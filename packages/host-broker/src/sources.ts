/**
 * The operations this slice exposes.
 *
 * Each one names a **source** rather than a command: a fixed set of files or one fixed program,
 * with a small set of validated arguments. That is the whole shape — the questions asked of a host
 * are unbounded, the places an answer can come from are not. Nothing here takes a path or an
 * arbitrary argument, so there is no path guard to get wrong yet.
 */
import { spawn } from 'node:child_process'
import {
  appendFile,
  chmod,
  readdir,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import {
  BUILD_TIMEOUT_MS,
  COMPOSE_TIMEOUT_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  MAX_ERROR_CHARS,
  MAX_EXEC_BUFFER_BYTES,
  MAX_PATTERN_CHARS,
  TAIL_WINDOW_BYTES,
} from './constants.ts'
import type { DeployLock } from './deploy-lock.ts'
import type { Keep } from './limits.ts'
import { BrokerFault } from './protocol.ts'

/** Where an operation reads from, which container it drives, and how long a program may run. */
export interface OpContext {
  readonly logDir: string
  readonly procDir: string
  readonly execTimeoutMs: number
  readonly container: string
  readonly dockerPath: string
  readonly checkout?: string
  /** The credential broker's checkout; `gcb.update` rebuilds from it. */
  readonly gcbCheckout?: string
  /** The compose file that runs the broker; `gcb.update` recreates only its service. */
  readonly gcbCompose?: string
  /** The repository `gcb.update` probes for, `owner/name`. */
  readonly gcbProbeRepo?: string
  /** The git client. Default `git`, resolved through the host's PATH. */
  readonly gitPath: string
  /** The `ip` client `net.status` runs. */
  readonly ipPath: string
  /** The `ss` client `net.sockets` runs. */
  readonly ssPath: string
  /** The pnpm client `broker.update` runs. */
  readonly pnpmPath: string
  /** The npm client the published-package update runs. */
  readonly npmPath: string
  /** The program this broker is running from; decides how to update it. */
  readonly entryPath: string
  /** The broker's own version, from its package.json. */
  readonly brokerVersion: string
  /** When the broker booted, for `broker.status`. */
  readonly startedAt: number
  readonly socketPath: string
  readonly auditPath: string
  /** Stop the broker, so its supervisor starts the new build. */
  readonly stop: () => void
  /** Where a detached operation writes its log; the audit directory. */
  readonly stateDir: string
  /** Where builds clone; unique to this broker's socket, swept at boot. */
  readonly buildRoot: string
  /** Serializes builds, recreates and rollbacks: one retag at a time. */
  readonly deployLock: DeployLock
  /** Aborted when the caller has waited as long as it will; programs stop with it. */
  readonly signal?: AbortSignal
}

/** An answer plus work that must not start until that answer has been written. */
export interface Execution {
  readonly text: string
  /** Runs on the host once the response is flushed; a recreate replaces the caller's container. */
  readonly after?: () => Promise<void> | void
}

/** One typed operation. `input` is the JSON Schema the plugin turns into a tool parameter. */
export interface OpDefinition {
  readonly name: string
  readonly summary: string
  readonly input: Record<string, unknown>
  /** The end a cap keeps; a log wants its tail, everything else its head. */
  readonly keep?: Keep
  /** Destructive: the plugin must ask the person before it runs. */
  readonly confirm?: boolean
  /** How long the operation may take; defaults to the broker's per-program deadline. */
  readonly timeoutMs?: number
  /** Runs under the deployment lock: no build, recreate or rollback overlaps it. */
  readonly serial?: boolean
  /** Config the operation cannot work without: absent is not offered by `ops.describe`. */
  readonly requires?: readonly (keyof OpContext)[]
  run(args: Record<string, unknown>, ctx: OpContext): Promise<Execution | string>
}

/**
 * Run one fixed program with fixed arguments.
 *
 * No shell and no caller-supplied argv; both pipes are collected in arrival order, so a log that
 * writes to stderr is not reordered or welded onto stdout. Past the buffer ceiling a tail operation
 * keeps the last 1 MiB and a head operation the first 1 MiB; `capOutput` then trims to the answer
 * size, from the end a log is asked for.
 */
interface RunOptions {
  readonly keep?: Keep
  /** How long this program may run; a build is minutes, not the default ten seconds. */
  readonly timeoutMs?: number
  /** Append the program's output here as it arrives, so a failed build stays diagnosable. */
  readonly logPath?: string
  /** Where the program runs; a compose file is relative to its checkout. */
  readonly cwd?: string
  /** Extra environment, merged over the broker's own. */
  readonly env?: NodeJS.ProcessEnv
}

function runFixed(
  ctx: OpContext,
  program: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const keep = options.keep ?? 'head'
  const timeoutMs = options.timeoutMs ?? ctx.execTimeoutMs
  if (ctx.signal?.aborted === true) {
    return Promise.reject(new BrokerFault('timeout', 'the operation was cancelled'))
  }
  return new Promise((resolve, reject) => {
    let logChain: Promise<unknown> = Promise.resolve()
    const child = spawn(program, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own group, so a timeout can stop whatever the program started too.
      detached: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    })
    const state: { settled: boolean; timer?: NodeJS.Timeout } = {
      settled: false,
    }
    let buffer = Buffer.alloc(0)

    const settle = (failure?: Error): void => {
      if (state.settled) {
        return
      }
      state.settled = true
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
      }
      ctx.signal?.removeEventListener('abort', onAbort)
      // The answer waits for the log to be complete, so a reader never sees a torn tail.
      void logChain.finally(() => {
        if (failure === undefined) {
          resolve(buffer.toString('utf8'))
        } else {
          reject(failure)
        }
      })
    }
    // The caller's deadline aborts the request context: the program goes with it, so a timed-out
    // build cannot retag an image after its answer.
    function onAbort(): void {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      settle(new BrokerFault('timeout', 'the operation was cancelled'))
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    const logPath = options.logPath
    const collect = (chunk: Buffer): void => {
      if (logPath !== undefined) {
        // Chunks arrive in order but the writes are async: chain them, so the file is ordered.
        logChain = logChain
          .then(() => appendFile(logPath, chunk, { mode: FILE_MODE }))
          .catch(() => null)
      }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_EXEC_BUFFER_BYTES) {
        // The retained window's start never reaches a client: the answer cap keeps the last
        // 64 KiB of it, and that boundary is repaired by `decodeTail`.
        buffer =
          keep === 'tail'
            ? buffer.subarray(buffer.length - MAX_EXEC_BUFFER_BYTES)
            : buffer.subarray(0, MAX_EXEC_BUFFER_BYTES)
      }
    }

    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    state.timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      settle(new BrokerFault('timeout', `no answer within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    child.once('error', (error: NodeJS.ErrnoException) => {
      settle(new BrokerFault('unavailable', `${error.code ?? 'spawn failed'}: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        settle()
        return
      }
      // The program's own message is the useful part, and docker/df put the cause last: keep the
      // tail of the output, from a line boundary, rather than its opening lines.
      const text = buffer.toString('utf8').trim()
      // Only a cut needs a boundary repair: a short message is complete as it stands.
      const cut = text.length > MAX_ERROR_CHARS
      let tail = cut ? text.slice(-MAX_ERROR_CHARS) : text
      if (cut) {
        // A slice can start on the low half of a surrogate pair.
        if (/^[\uDC00-\uDFFF]/u.test(tail)) {
          tail = tail.slice(1)
        }
        const boundary = tail.indexOf('\n')
        tail = boundary === -1 ? tail : tail.slice(boundary + 1)
      }
      const message = tail.trim()
      settle(
        new BrokerFault(
          'unavailable',
          message === '' ? `${program} exited with ${code ?? signal ?? 'no status'}` : message,
        ),
      )
    })
  })
}

/* ------------------------------------------------------------------ argument checks */

function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new BrokerFault('bad-argument', `unknown argument ${JSON.stringify(key)}`)
    }
  }
}

/** Narrow a string to the allowed values, so the return needs no second assertion. */
function isChoice<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some(item => item === value)
}

function choice<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = args[name]
  if (typeof value !== 'string' || !isChoice(allowed, value)) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be one of ${allowed.map(item => JSON.stringify(item)).join(', ')}`,
    )
  }
  return value
}

function integer(
  args: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = args[name]
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BrokerFault('bad-argument', `${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function text(args: Record<string, unknown>, name: string, maxChars: number): string | undefined {
  const value = args[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length > maxChars) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be a string of at most ${maxChars} characters`,
    )
  }
  return value
}

/* ------------------------------------------------------------------ log.tail */

/** The most rows `log.tail` returns, and the default when the caller does not ask. */
const MAX_LINES = 500
const DEFAULT_LINES = 100

/** The one directory `log.tail` reads, and the only three names it knows inside it. */
const LOG_TARGETS = ['messages', 'syslog', 'kern'] as const

type LogFile = (typeof LOG_TARGETS)[number]

const LOG_FILES: Record<LogFile, string> = {
  messages: 'messages',
  syslog: 'syslog',
  kern: 'kern.log',
}

/**
 * The last `lines` rows of one log.
 *
 * A window is read from the end rather than the whole file: a log can be gigabytes, and the answer
 * is bounded anyway. One byte before the window is read as well, so the first row is dropped only
 * when the window really starts inside it — a window that starts on a line boundary keeps its first
 * whole row.
 */
async function tail(
  file: LogFile,
  lines: number,
  pattern: string | undefined,
  ctx: OpContext,
): Promise<string> {
  const filePath = path.join(ctx.logDir, LOG_FILES[file])
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(filePath)
  } catch {
    throw new BrokerFault('unavailable', `${file} is not being written on this host`)
  }
  if (!info.isFile()) {
    throw new BrokerFault('unavailable', `${file} is not a regular file`)
  }

  const offset = Math.max(0, info.size - TAIL_WINDOW_BYTES - 1)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, TAIL_WINDOW_BYTES + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    let body = buffer.subarray(0, bytesRead).toString('utf8')
    if (offset > 0) {
      const firstBreak = body.indexOf('\n')
      body = firstBreak === -1 ? '' : body.slice(firstBreak + 1)
    }
    let rows = body.split('\n').filter(row => row !== '')
    // A literal substring, not a regular expression: nothing to escape, nothing that can backtrack.
    if (pattern !== undefined) {
      rows = rows.filter(row => row.includes(pattern))
    }
    return rows.slice(-lines).join('\n')
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ proc.read */

/** The fixed set `proc.read` can answer from. */
const PROC_TARGETS = ['mdstat', 'loadavg', 'meminfo', 'uptime', 'vmstat'] as const

type ProcFile = (typeof PROC_TARGETS)[number]

async function readProc(file: ProcFile, ctx: OpContext): Promise<string> {
  try {
    return await readFile(path.join(ctx.procDir, file), 'utf8')
  } catch {
    throw new BrokerFault('unavailable', `${file} is not readable on this host`)
  }
}

/* ---------------------------------------------------------------- proc.list */

/**
 * How many processes `proc.list` returns by default, and at most. Both are read by the tests, so
 * they are @internal and stripped from the published types.
 */
export const DEFAULT_PROC_LINES = 20
/** @internal The tests assert the cap; not part of the published surface. */
export const MAX_PROC_LINES = 100

const PROC_PID = /^\d+$/u

/** Width of the resident-set column. */
const RSS_COLUMN = 9

interface ProcEntry {
  readonly pid: string
  readonly ppid: number
  readonly state: string
  readonly rssKb: number
  readonly comm: string
}

function parseProcStat(pid: string, stat: string): Omit<ProcEntry, 'rssKb'> | undefined {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open === -1 || close === -1 || close < open) {
    return undefined
  }
  // A newline in a comm would add a line that looks like a row of its own; printable Unicode stays.
  const comm = stat.slice(open + 1, close).replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/u)
  const state = fields[0]
  const parent = Number(fields[1])
  if (!Number.isInteger(parent)) {
    return undefined
  }
  return { pid, state, ppid: parent, comm }
}

function readRssKb(status: string): number {
  const match = /^VmRSS:\s+(\d+) kB/mu.exec(status)
  return match === null ? 0 : Number(match[1])
}

/** The process table, biggest resident set first. No environment, no argv. */
async function procList(ctx: OpContext, lines: number): Promise<string> {
  let names: string[]
  try {
    names = await readdir(ctx.procDir)
  } catch {
    throw new BrokerFault('unavailable', 'the process table is not readable on this host')
  }
  const entries: ProcEntry[] = []
  for (const name of names) {
    // A timed-out request should stop reading the table, not walk the rest of it.
    if (ctx.signal?.aborted === true) {
      break
    }
    if (!PROC_PID.test(name)) {
      continue
    }
    try {
      const stat = await readFile(path.join(ctx.procDir, name, 'stat'), 'utf8')
      const parsed = parseProcStat(name, stat)
      if (parsed === undefined) {
        continue
      }
      const status = await readFile(path.join(ctx.procDir, name, 'status'), 'utf8')
      entries.push({ ...parsed, rssKb: readRssKb(status) })
    } catch {
      // A process that exited while it was being read is not an error.
    }
  }
  entries.sort((left, right) => right.rssKb - left.rssKb || Number(left.pid) - Number(right.pid))
  const rows = entries
    .slice(0, lines)
    .map(
      entry =>
        `${entry.pid.padStart(7)} ${String(entry.ppid).padStart(7)} ${entry.state} ${String(entry.rssKb).padStart(RSS_COLUMN)} ${entry.comm}`,
    )
  return ['    pid    ppid s    rssKiB comm', ...rows].join('\n')
}

/* ------------------------------------------------------------------ disk.usage */

/** One fixed program with one fixed argument. */
function diskUsage(ctx: OpContext): Promise<string> {
  return runFixed(ctx, 'df', ['-h'])
}

/* ------------------------------------------------------------------ deploy.status / deploy.log */

/** The most lines one log answer may ask for, and the default. */
const MAX_LOG_LINES = 1000
const DEFAULT_LOG_LINES = 100

/** The shape every `run` operation takes: one program, fixed argv. */
function docker(
  ctx: OpContext,
  args: readonly string[],
  keep: Keep = 'head',
  options: RunOptions = {},
): Promise<string> {
  return runFixed(ctx, ctx.dockerPath, args, { ...options, keep })
}

/** One git invocation in the deployment checkout (or in a clone, via `-C`). */
function git(
  ctx: OpContext,
  args: readonly string[],
  options: RunOptions = {},
  cwd: string | undefined = ctx.checkout,
): Promise<string> {
  return runFixed(ctx, ctx.gitPath, ['-C', cwd ?? '.', ...args], options)
}

/**
 * Start `docker compose` on the host, detached from this request.
 *
 * A recreate removes and replaces the container the caller runs in, so the request cannot wait for
 * it: the broker flushes its answer, the scheduler waits `AFTER_RESPONSE_DELAY_MS`, and only then
 * is this called. The child is detached and unref'd, so neither the broker's exit nor a timeout
 * stops it, and compose's own log records the outcome.
 */
async function composeDetached(
  ctx: OpContext,
  checkout: string,
  args: readonly string[],
): Promise<void> {
  const logPath = path.join(ctx.stateDir, 'compose.log')
  const log = await open(logPath, 'a', FILE_MODE)
  try {
    await log.chmod(FILE_MODE)
    // The real compose interpolates UID/GID, which the broker's own environment does not
    // necessarily export (a user unit starts it without a login shell): pass its ids explicitly.
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    const child = spawn(
      ctx.dockerPath,
      ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml', ...args],
      {
        detached: true,
        cwd: checkout,
        env: {
          ...process.env,
          ...(uid === undefined ? {} : { UID: String(uid) }),
          ...(gid === undefined ? {} : { GID: String(gid) }),
        },
        stdio: ['ignore', log.fd, log.fd],
      },
    )
    // A failed spawn must not take the broker down, and the answer already went out: record it
    // where the operator will look for it. The handle is closed by the finally below, so this
    // appends by path instead of holding the descriptor open.
    child.on('error', (error: Error) => {
      noteFailure(logPath, error)
    })
    child.unref()
    // The caller holds the deployment lock until compose is done, so a compose that never returns
    // must not hold it forever.
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      void appendFile(logPath, `compose did not finish within ${String(COMPOSE_TIMEOUT_MS)} ms\n`, {
        mode: FILE_MODE,
      }).catch(() => null)
    }, COMPOSE_TIMEOUT_MS)
    try {
      await new Promise<void>(resolve => {
        child.once('error', () => resolve())
        child.once('exit', () => resolve())
      })
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await log.close()
  }
}

/** The files a build takes from main: everything that runs as root before the uid drops. */
const ROOT_SURFACE = [
  'Dockerfile',
  'Dockerfile.dev',
  'entrypoint.sh',
  'tools',
  '.dockerignore',
  'Dockerfile.dev.dockerignore',
] as const

/** Run inside the build container; the host argv is fixed and no caller input reaches it. */
const BUILD_COMMAND = 'pnpm install --frozen-lockfile && pnpm build'

/** The image that carries node and pnpm for the build step. */
const BUILD_CONTAINER = 'devockr/idsh:base'

const BUILD_IMAGE = 'devockr/idsh:dev'

const SHA_PATTERN = /^[0-9a-f]{7,40}$/u

/** What `recordRollback` writes: an image id or a manifest digest. */
const IMAGE_REFERENCE = /^(?:sha256:[0-9a-f]{64}|[^\s@]+@sha256:[0-9a-f]{64})$/u

/** A spawn failure the answer already left behind: record it where the operator will look. */
function noteFailure(logPath: string, error: Error): void {
  void appendFile(logPath, `spawn failed: ${error.message}\n`, {
    mode: FILE_MODE,
  }).catch(() => null)
}

/** What is left of one operation's budget. */
function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

/* ---------------------------------------------------------------- broker.status / broker.update */

const BROKER_PACKAGE = '@idsh/host-broker'

/**
 * How this broker was installed, read from the program it is running: inside the checkout it builds
 * there (the entry it is running from), otherwise the published package is what to update.
 */
function brokerUpdateSource(ctx: OpContext): 'checkout' | 'npm' {
  if (ctx.checkout === undefined) {
    return 'npm'
  }
  const entry = path.resolve(ctx.entryPath)
  const relative = path.relative(ctx.checkout, entry)
  return relative !== '' && !relative.startsWith('..') ? 'checkout' : 'npm'
}

/**
 * The npm prefix the running entry came from: `<prefix>/bin/idsh-host` or a package path under
 * `<prefix>/lib/node_modules`. Anything else has no prefix to install into.
 */
function installPrefix(ctx: OpContext): string | undefined {
  const entry = path.resolve(ctx.entryPath)
  const modules = `${path.sep}lib${path.sep}node_modules${path.sep}`
  const at = entry.indexOf(modules)
  if (at > 0) {
    return entry.slice(0, at)
  }
  const bin = path.dirname(entry)
  return path.basename(bin) === 'bin' ? path.dirname(bin) : undefined
}

interface UpdateStep {
  readonly program: string
  readonly args: readonly string[]
  readonly cwd?: string
}

function brokerUpdate(ctx: OpContext, source: 'checkout' | 'npm'): UpdateStep[] {
  if (source === 'checkout' && ctx.checkout !== undefined) {
    return [
      {
        // The checkout is `git`'s default cwd, and a step's budget is what is left of the op's.
        program: ctx.gitPath,
        args: ['pull', '--ff-only'],
        cwd: ctx.checkout,
      },
      {
        program: ctx.pnpmPath,
        args: ['install', '--frozen-lockfile'],
        cwd: ctx.checkout,
      },
      {
        program: ctx.pnpmPath,
        args: ['--filter', BROKER_PACKAGE, 'build'],
        cwd: ctx.checkout,
      },
    ]
  }
  const prefix = installPrefix(ctx)
  if (prefix === undefined) {
    throw new BrokerFault(
      'unavailable',
      `cannot tell which npm prefix ${ctx.entryPath} belongs to; update the broker the way it was installed`,
    )
  }
  return [
    {
      // The unit runs `<prefix>/bin/idsh-host`, so the update has to land in that prefix.
      program: ctx.npmPath,
      args: ['install', '--global', '--prefix', prefix, `${BROKER_PACKAGE}@latest`],
    },
  ]
}

/* ---------------------------------------------------------------- net.sockets */

/** The socket tables `net.sockets` can read. */
const SOCKET_TABLES = ['listen', 'connections'] as const
const SOCKET_WHAT = [...SOCKET_TABLES, 'all'] as const

type SocketWhat = (typeof SOCKET_WHAT)[number]

/** What each table renders; adding one to SOCKET_TABLES fails to type-check until it is here. */
const SOCKET_RENDER: Record<
  (typeof SOCKET_TABLES)[number],
  { label: string; args: readonly string[] }
> = {
  listen: { label: 'listen', args: ['-tulpn'] },
  // No -l and no -a: the non-listening TCP/UDP sockets, with their peers.
  connections: { label: 'connections', args: ['-tunp'] },
}

async function netSockets(ctx: OpContext, what: SocketWhat): Promise<string> {
  const sections: string[] = []
  for (const table of SOCKET_TABLES) {
    if (what !== 'all' && what !== table) {
      continue
    }
    const { label, args } = SOCKET_RENDER[table]
    const output = await runFixed(ctx, ctx.ssPath, args)
    sections.push(`## ${label}`, output.trimEnd())
  }
  return sections.join('\n')
}

/* ---------------------------------------------------------------- net.status */

/** The tables `net.status` can read; `all` means every one of them. */
const NET_TABLES = ['addr', 'route', 'neigh'] as const
const NET_WHAT = [...NET_TABLES, 'all'] as const

type NetWhat = (typeof NET_WHAT)[number]
type NetTable = (typeof NET_TABLES)[number]

/** What each table renders. Adding a table to NET_TABLES fails to type-check until it is here. */
const NET_RENDER: Record<NetTable, ReadonlyArray<{ label: string; args: readonly string[] }>> = {
  addr: [{ label: 'addr', args: ['-br', 'addr'] }],
  route: [
    // `ip route` alone is IPv4: a dual-stack LAN needs both tables, labelled.
    { label: 'route (ipv4)', args: ['-4', '-br', 'route'] },
    { label: 'route (ipv6)', args: ['-6', '-br', 'route'] },
  ],
  neigh: [{ label: 'neigh', args: ['-br', 'neigh'] }],
}

async function netStatus(ctx: OpContext, what: NetWhat): Promise<string> {
  const sections: string[] = []
  for (const table of NET_TABLES) {
    if (what !== 'all' && what !== table) {
      continue
    }
    for (const section of NET_RENDER[table]) {
      const output = await runFixed(ctx, ctx.ipPath, section.args)
      sections.push(`## ${section.label}`, output.trimEnd())
    }
  }
  return sections.join('\n')
}

/* ---------------------------------------------------------------- deploy.rollback */

/** The image recorded before the last build; a build that never ran leaves no target. */
async function rollbackTarget(ctx: OpContext): Promise<string> {
  let text: string
  try {
    text = await readFile(path.join(ctx.stateDir, 'rollback'), 'utf8')
  } catch {
    throw new BrokerFault('unavailable', 'no rollback target recorded; run deploy.build first')
  }
  // One line, plus the newline recordRollback writes; any other break is a broken file.
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  if (lines.length !== 1) {
    throw new BrokerFault(
      'unavailable',
      `the rollback file does not name one image: ${JSON.stringify(text)}`,
    )
  }
  const target = (lines[0] ?? '').trim()
  if (!IMAGE_REFERENCE.test(target)) {
    throw new BrokerFault(
      'unavailable',
      `the rollback file does not name an image: ${JSON.stringify(target)}`,
    )
  }
  return target
}

/* ------------------------------------------------------------------ the table */

/* ---------------------------------------------------------------- gcb.update */

/** How long the post-update probe may take; it answers over the network, unlike a local read. */
const PROBE_TIMEOUT_MS = 60_000

/**
 * Rebuild the credential broker from its own checkout and recreate only its container.
 *
 * Not named `deploy.*`: those mean this deployment, and their log and status would become ambiguous
 * the moment a second deployment shares the namespace. Every step is the answer, so a failure says
 * which one it was; the container's own state is the last word, because a build that cannot start
 * is not a successful update.
 */
async function updateBroker(ctx: OpContext): Promise<string> {
  const checkout = ctx.gcbCheckout
  const compose = ctx.gcbCompose
  const repo = ctx.gcbProbeRepo
  if (checkout === undefined || compose === undefined || repo === undefined) {
    throw new BrokerFault('unavailable', 'the broker is not configured for gcb.update')
  }
  // Each step names itself, in the answer and in the failure: a pull that worked and a build that
  // did not are different answers to whoever reads the audit log.
  const done: string[] = []
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const suffix = done.length === 0 ? '' : `; completed: ${done.join('; ')}`
      if (error instanceof BrokerFault) {
        throw new BrokerFault(error.code, `gcb.update: ${name} failed: ${message}${suffix}`)
      }
      throw new BrokerFault('unavailable', `gcb.update: ${name} failed: ${message}${suffix}`)
    }
  }
  const pull =
    (
      await step('pull', () =>
        git(ctx, ['pull', '--ff-only'], { timeoutMs: BUILD_TIMEOUT_MS }, checkout),
      )
    )
      .trim()
      .split('\n')[0] ?? ''
  done.push(`pull: ${pull}`)
  // The broker's compose runs the broker and nothing else — that is what `gcb compose` renders, and
  // the deployment's own overlay is not the file this operates on. Discovering the one service here
  // keeps that requirement explicit instead of offering a name flag that could disagree with it.
  const services = (
    await step('read the service', () =>
      docker(ctx, ['compose', '-f', compose, 'config', '--services'], 'head', { cwd: checkout }),
    )
  )
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (services.length !== 1) {
    throw new BrokerFault(
      'unavailable',
      `the broker's compose must run exactly one service, got ${String(services.length)}: ${services.join(', ')}`,
    )
  }
  const service = services[0]
  const images = (
    await step('read the image', () =>
      docker(ctx, ['compose', '-f', compose, 'config', '--images', service], 'head', {
        cwd: checkout,
      }),
    )
  )
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (images.length !== 1) {
    throw new BrokerFault(
      'unavailable',
      `the broker's service names ${String(images.length)} images; gcb.update builds exactly one`,
    )
  }
  const image = images[0]
  done.push(`image: ${image}`)
  await step('build', () =>
    docker(ctx, ['build', '--target', 'host', '-t', image, '.'], 'tail', {
      cwd: checkout,
      timeoutMs: BUILD_TIMEOUT_MS,
    }),
  )
  done.push('build: ok')
  // The service, not the whole file: another service sharing that compose project must not be
  // recreated by a broker update, and `ps` must not answer with its id either.
  await step('recreate', () =>
    docker(ctx, ['compose', '-f', compose, 'up', '-d', '--no-deps', '--wait', service], 'head', {
      cwd: checkout,
      timeoutMs: BUILD_TIMEOUT_MS,
    }),
  )
  done.push(`recreate: up -d --no-deps --wait ${service}`)
  // The container is the broker: ids first, so an empty list is its own answer, then the state
  // and — when the unit declares one — the healthcheck.
  const ids = (
    await step('list the container', () =>
      docker(ctx, ['compose', '-f', compose, 'ps', '-q', service], 'head', { cwd: checkout }),
    )
  )
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (ids.length === 0) {
    throw new BrokerFault('unavailable', 'the broker container is not running after the recreate')
  }
  const states = await Promise.all(
    ids.map(id =>
      docker(ctx, [
        'inspect',
        '--format',
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
        id,
      ]),
    ),
  )
  const unhealthy = states
    .map(state => state.trim())
    .filter(state => !/^running(?: healthy)?$/u.test(state))
  if (unhealthy.length > 0) {
    throw new BrokerFault('unavailable', `the broker container is ${unhealthy.join(', ')}`)
  }
  done.push(`state: ${states.map(state => state.trim()).join(', ')}`)
  // State is not the same as reachable: the socket check in the healthcheck passes for a process
  // that answers nothing. The probe asks the broker through the client the deployment uses, so
  // "updated" means "a push would be issued a credential".
  // The probe mints a token through the broker, so it is a network step, not a socket round trip:
  // on a slow link the ten-second default answers `timeout` after an update that worked.
  await step('probe', () =>
    docker(ctx, ['exec', ctx.container, 'gcb', 'probe', '--repo', repo], 'head', {
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
  )
  done.push(`probe: ${repo} allowed`)
  return done.join('; ')
}

export const OPS: readonly OpDefinition[] = [
  {
    name: 'log.tail',
    summary: 'The last lines of a host log, optionally only the lines containing a literal string.',
    keep: 'tail',
    input: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: [...LOG_TARGETS],
          description: 'Which host log to read.',
        },
        lines: {
          type: 'integer',
          description: `How many trailing lines to return, 1 to ${String(MAX_LINES)}. Default ${String(DEFAULT_LINES)}.`,
        },
        pattern: {
          type: 'string',
          description: `Keep only rows containing this literal text (at most ${String(MAX_PATTERN_CHARS)} characters; not a regular expression).`,
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['file', 'lines', 'pattern'])
      const file = choice(args, 'file', LOG_TARGETS)
      const lines = integer(args, 'lines', 1, MAX_LINES, DEFAULT_LINES)
      return tail(file, lines, text(args, 'pattern', MAX_PATTERN_CHARS), ctx)
    },
  },
  {
    name: 'proc.read',
    summary: 'One of a fixed set of kernel state files: mdstat, loadavg, meminfo, uptime, vmstat.',
    input: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: [...PROC_TARGETS],
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['file'])
      const file = choice(args, 'file', PROC_TARGETS)
      return readProc(file, ctx)
    },
  },
  {
    name: 'deploy.status',
    summary: 'The deployment container: its image, creation time and state, straight from docker.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      // The keys are the inspect JSON names ('.Id', not '.ID'), and docker renders with
      // `missingkey=error`, so a wrong name fails the call. `index .State "Health"` is the one
      // guard that survives an absent health block; `{{if .State.Health}}` is itself a lookup.
      return docker(ctx, [
        'inspect',
        '--type',
        'container',
        '--format',
        'container={{.Id}} image={{.Config.Image}} image-id={{.Image}} created={{.Created}} status={{.State.Status}} health={{with index .State "Health"}}{{.Status}}{{else}}none{{end}} exit={{.State.ExitCode}}',
        ctx.container,
      ])
    },
  },
  {
    name: 'deploy.log',
    summary: 'The tail of the deployment container log.',
    keep: 'tail',
    input: {
      type: 'object',
      properties: {
        lines: {
          type: 'integer',
          description: `How many trailing lines to return, 1 to ${String(MAX_LOG_LINES)}. Default ${String(DEFAULT_LOG_LINES)}.`,
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['lines'])
      const lines = integer(args, 'lines', 1, MAX_LOG_LINES, DEFAULT_LOG_LINES)
      return docker(ctx, ['logs', '--tail', String(lines), ctx.container], 'tail')
    },
  },
  {
    name: 'deploy.build',
    summary:
      'Build the :dev image from a PR head or the tip of an origin branch; the root files stay at main.',
    confirm: true,
    serial: true,
    timeoutMs: BUILD_TIMEOUT_MS,
    input: {
      type: 'object',
      properties: {
        pr: {
          type: 'integer',
          description: 'A same-repository PR number; its head must be on an origin branch.',
        },
        sha: {
          type: 'string',
          description: 'The tip of an origin branch.',
        },
        log: {
          type: 'string',
          description: 'Log id this build writes as build-<log>.log; the client follows it.',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['pr', 'sha', 'log'])
      const log = optionalLog(args)
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      const source = await resolveBuildSource(ctx, args, deadline)
      const previous = await buildInto(ctx, source, deadline, log)
      return `built ${source.label} (${source.sha}) as ${BUILD_IMAGE}; main ${source.mainSha}; previous image ${previous}`
    },
  },
  {
    name: 'deploy.main',
    summary: 'Build the tip of main as :dev, then recreate the container from it.',
    confirm: true,
    serial: true,
    timeoutMs: BUILD_TIMEOUT_MS,
    input: {
      type: 'object',
      properties: {
        log: {
          type: 'string',
          description: 'Log id this build writes as build-<log>.log; the client follows it.',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['log'])
      const log = optionalLog(args)
      const checkout = requireCheckout(ctx)
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      const source = await resolveMainSource(ctx, deadline)
      const previous = await buildInto(ctx, source, deadline, log)
      return {
        text: `built ${source.label} (${source.sha}) as ${BUILD_IMAGE}; recreating from it; previous image ${previous}`,
        after: () => composeDetached(ctx, checkout, ['up', '-d', '--no-build']),
      }
    },
  },
  {
    name: 'deploy.rollback',
    summary: 'Retag :dev to the image recorded before the last build, then recreate from it.',
    confirm: true,
    serial: true,
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      const checkout = requireCheckout(ctx)
      const target = await rollbackTarget(ctx)
      // Read-only: a target docker no longer has must fail before anything is acknowledged.
      await docker(ctx, ['image', 'inspect', '--format', '{{.Id}}', target])
      return {
        text: `rollback queued to ${target}; the session drops when the container is replaced`,
        after: async () => {
          try {
            await docker(ctx, ['tag', target, BUILD_IMAGE])
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await appendFile(
              path.join(ctx.stateDir, 'compose.log'),
              `rollback tag failed: ${message}\n`,
              { mode: FILE_MODE },
            ).catch(() => null)
            throw error
          }
          await composeDetached(ctx, checkout, ['up', '-d', '--no-build'])
        },
      }
    },
  },
  {
    name: 'deploy.recreate',
    summary: 'Recreate the deployment container from the current :dev image, without building.',
    confirm: true,
    serial: true,
    input: { type: 'object', properties: {}, additionalProperties: false },
    run(args, ctx) {
      rejectUnknown(args, [])
      const checkout = requireCheckout(ctx)
      return Promise.resolve({
        text: `recreate queued; the session drops when the container is replaced. compose log: ${path.join(ctx.stateDir, 'compose.log')}`,
        after: () => composeDetached(ctx, checkout, ['up', '-d', '--no-build']),
      })
    },
  },

  {
    name: 'gcb.update',
    summary: 'Rebuild the credential broker from its checkout and recreate only its container.',
    confirm: true,
    serial: true,
    timeoutMs: BUILD_TIMEOUT_MS,
    requires: ['gcbCheckout', 'gcbCompose', 'gcbProbeRepo'],
    input: { type: 'object', properties: {}, additionalProperties: false },
    run(args, ctx) {
      rejectUnknown(args, [])
      return updateBroker(ctx)
    },
  },
  {
    name: 'net.status',
    summary: "The host's addresses, routes and neighbours, read with ip.",
    input: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          enum: [...NET_WHAT],
          description: 'Which table to read: addr, route, neigh, or all (the default).',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['what'])
      // Asked for nothing means all of them; anything else must name one of the tables.
      const what: NetWhat = args['what'] === undefined ? 'all' : choice(args, 'what', NET_WHAT)
      return netStatus(ctx, what)
    },
  },
  {
    name: 'net.sockets',
    summary: "The host's listening sockets and connections, read with ss.",
    input: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          enum: [...SOCKET_WHAT],
          description: 'Which table to read: listen, connections, or all (the default).',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['what'])
      const what: SocketWhat =
        args['what'] === undefined ? 'all' : choice(args, 'what', SOCKET_WHAT)
      return netSockets(ctx, what)
    },
  },
  {
    name: 'broker.status',
    summary: 'This broker: its version, process, start time, socket, audit file and checkout.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    run(args, ctx) {
      rejectUnknown(args, [])
      return Promise.resolve(
        [
          `version=${ctx.brokerVersion}`,
          `pid=${String(process.pid)}`,
          `started=${new Date(ctx.startedAt).toISOString()}`,
          `socket=${ctx.socketPath}`,
          `audit=${ctx.auditPath}`,
          `checkout=${ctx.checkout ?? ''}`,
        ].join('\n'),
      )
    },
  },
  {
    name: 'broker.update',
    summary: 'Update the broker from its checkout (or npm) and let its supervisor restart it.',
    confirm: true,
    serial: true,
    timeoutMs: BUILD_TIMEOUT_MS,
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      const source = brokerUpdateSource(ctx)
      // Synchronous on purpose: a failed step must be the answer, not a silent no-op behind it.
      // Each step gets what is left of the one budget, like the build.
      for (const step of brokerUpdate(ctx, source)) {
        await runFixed(ctx, step.program, step.args, {
          timeoutMs: remaining(deadline),
          ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
        })
      }
      return {
        text: `updated from ${source}; the broker exits so its supervisor starts the new build`,
        after: () => ctx.stop(),
      }
    },
  },
  {
    name: 'proc.list',
    summary: 'The process table: pid, parent, state, resident set and command name, biggest first.',
    input: {
      type: 'object',
      properties: {
        lines: {
          type: 'integer',
          description: `How many processes to return, 1 to ${String(MAX_PROC_LINES)}. Default ${String(DEFAULT_PROC_LINES)}.`,
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['lines'])
      const lines = integer(args, 'lines', 1, MAX_PROC_LINES, DEFAULT_PROC_LINES)
      return procList(ctx, lines)
    },
  },
  {
    name: 'disk.usage',
    summary: 'df -h: the mounted filesystems and how full they are.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      return diskUsage(ctx)
    },
  },
]

/**
 * The operations this broker can offer: a `requires` list that the context cannot satisfy hides
 * one.
 */
const available = (context: OpContext | undefined): readonly OpDefinition[] =>
  OPS.filter(
    op => op.requires === undefined || op.requires.every(key => context?.[key] !== undefined),
  )

export function findOp(name: string, context?: OpContext): OpDefinition | undefined {
  return available(context).find(op => op.name === name)
}

/** The table as the plugin sees it: names, summaries and the parameter schema of each. */
export function describeOps(context?: OpContext): string {
  return JSON.stringify(
    available(context).map(({ name, summary, input, confirm, timeoutMs }) => ({
      name,
      summary,
      input,
      ...(confirm === true ? { confirm: true } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })),
    null,
    2,
  )
}

/** The deployment checkout, or the fault that says why a deploy operation cannot run. */
function requireCheckout(ctx: OpContext): string {
  if (ctx.checkout === undefined) {
    throw new BrokerFault('unavailable', 'no checkout configured; start the broker with --checkout')
  }
  return ctx.checkout
}

/* ---------------------------------------------------------------- deploy.build */

interface BuildSource {
  readonly sha: string
  /** `main` resolved at the same moment as the source, so the pin cannot drift. */
  readonly mainSha: string
  readonly label: string
}

function findMain(heads: Array<{ sha: string; ref: string }>): string {
  const main = heads.find(entry => entry.ref === 'refs/heads/main')
  if (main === undefined) {
    throw new BrokerFault('unavailable', 'origin has no main branch')
  }
  return main.sha
}

function parseLsRemote(text: string): Array<{ sha: string; ref: string }> {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const [sha = '', ref = ''] = line.split(/\s+/u)
      return { sha, ref }
    })
}

function lsRemote(ctx: OpContext, pattern: string, deadline: number): Promise<string> {
  return git(ctx, ['ls-remote', 'origin', pattern], {
    timeoutMs: remaining(deadline),
  })
}

/**
 * Resolve what to build.
 *
 * Only code that exists on origin is deployable: a PR's head must be a branch of this repository,
 * and a bare sha must be the tip of an origin branch. Nothing from the working tree is ever built.
 */
async function resolveBuildSource(
  ctx: OpContext,
  args: Record<string, unknown>,
  deadline: number,
): Promise<BuildSource> {
  const pr = args['pr']
  const sha = args['sha']
  if ((pr === undefined) === (sha === undefined)) {
    throw new BrokerFault('bad-argument', 'give exactly one of pr or sha')
  }
  requireCheckout(ctx)
  const heads = parseLsRemote(await lsRemote(ctx, 'refs/heads/*', deadline))
  const main = findMain(heads)
  if (pr !== undefined) {
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) {
      throw new BrokerFault('bad-argument', 'pr must be a positive integer')
    }
    const head = parseLsRemote(await lsRemote(ctx, `refs/pull/${String(pr)}/head`, deadline))
    const resolved = head.at(0)?.sha
    if (resolved === undefined) {
      throw new BrokerFault('unavailable', `PR ${String(pr)} has no head on origin`)
    }
    if (!heads.some(entry => entry.sha === resolved)) {
      throw new BrokerFault(
        'unavailable',
        `the head of PR ${String(pr)} is not on an origin branch; fork PRs are not deployable`,
      )
    }
    return { sha: resolved, mainSha: main, label: `PR #${String(pr)}` }
  }
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    throw new BrokerFault('bad-argument', 'sha must be a hex commit id')
  }
  // Several branches at one commit is ordinary; only different commits are ambiguous.
  const matches = [
    ...new Set(heads.map(entry => entry.sha).filter(candidate => candidate.startsWith(sha))),
  ]
  if (matches.length === 0) {
    throw new BrokerFault('unavailable', `sha ${sha} is not the tip of an origin branch`)
  }
  if (matches.length > 1) {
    throw new BrokerFault('bad-argument', `sha ${sha} matches more than one origin branch`)
  }
  return { sha: matches[0], mainSha: main, label: `sha ${sha}` }
}

/** The tip of main, resolved like any other source. */
async function resolveMainSource(ctx: OpContext, deadline: number): Promise<BuildSource> {
  requireCheckout(ctx)
  const main = findMain(parseLsRemote(await lsRemote(ctx, 'refs/heads/*', deadline)))
  return { sha: main, mainSha: main, label: 'main' }
}

/** Prepare, build and clean up; returns the image the container ran before. */
async function buildInto(
  ctx: OpContext,
  source: BuildSource,
  deadline: number,
  logId: string | undefined,
): Promise<string> {
  const dir = await prepareBuildSource(ctx, source, deadline)
  try {
    // Recorded before the build, so the tag moving is what makes this the rollback target.
    const previous = await recordRollback(ctx)
    await buildImage(ctx, dir, deadline, logId)
    return previous
  } finally {
    // Best effort: a cleanup failure must not turn a tagged image into an error.
    await rm(dir, { recursive: true, force: true }).catch(() => null)
  }
}

/** A clean clone of the source, with the root surface replaced by main's. */
async function prepareBuildSource(
  ctx: OpContext,
  source: BuildSource,
  deadline: number,
): Promise<string> {
  const checkout = requireCheckout(ctx)
  const root = ctx.buildRoot
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE })
  // The checkout may never have fetched the source: freshen its refs, then clone its objects.
  await git(ctx, ['fetch', '--quiet', 'origin'], { timeoutMs: remaining(deadline) }, checkout)
  const dir = await mkdtemp(path.join(root, 'source-'))
  try {
    await git(
      ctx,
      ['clone', '--quiet', '--no-checkout', checkout, dir],
      { timeoutMs: remaining(deadline) },
      root,
    )
    await git(
      ctx,
      ['checkout', '--quiet', '--detach', source.sha],
      { timeoutMs: remaining(deadline) },
      dir,
    )
    await git(
      ctx,
      ['checkout', source.mainSha, '--', ...ROOT_SURFACE],
      { timeoutMs: remaining(deadline) },
      dir,
    )
    return dir
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => null)
    throw error
  }
}

/** Remember the image the container runs now, before a build retags `:dev`. */
async function recordRollback(ctx: OpContext): Promise<string> {
  // RepoDigests lives on the image, not on the container: read the id first, then the image.
  const idText = await docker(ctx, [
    'inspect',
    '--type',
    'container',
    '--format',
    '{{.Image}}',
    ctx.container,
  ])
  const id = idText.trim().split('\n')[0] ?? ''
  if (id === '') {
    throw new BrokerFault('unavailable', 'the container has no image to roll back to')
  }
  let previous = id
  try {
    const digestsText = await docker(ctx, [
      'inspect',
      '--type',
      'image',
      '--format',
      '{{json .RepoDigests}}',
      id,
    ])
    const parsed: unknown = JSON.parse(digestsText.trim().split('\n')[0] ?? '[]')
    // A pulled image is one pull away; a local one only exists as its id.
    if (Array.isArray(parsed)) {
      const list: unknown[] = parsed
      if (typeof list[0] === 'string') {
        previous = list[0]
      }
    }
  } catch {
    // No digests: the id is the target.
  }
  const file = path.join(ctx.stateDir, 'rollback')
  await writeFile(file, `${previous}\n`, { mode: FILE_MODE })
  await chmod(file, FILE_MODE).catch(() => null)
  return previous
}
/** The optional log id a caller picks, so its job can follow exactly this build. */
function optionalLog(args: Record<string, unknown>): string | undefined {
  const log = args['log']
  if (log === undefined) {
    return undefined
  }
  if (typeof log !== 'string' || !/^[\w-]{1,64}$/u.test(log)) {
    throw new BrokerFault('bad-argument', 'log must be 1-64 letters, digits, "_" or "-"')
  }
  return log
}

async function buildImage(
  ctx: OpContext,
  dir: string,
  deadline: number,
  logId: string | undefined,
): Promise<void> {
  // One file per build: a job follows exactly the log its own call writes.
  const logPath = path.join(ctx.stateDir, logId === undefined ? 'build.log' : `build-${logId}.log`)
  // Create the log before the first program: a silent failure still leaves the file behind.
  const log = await open(logPath, 'a', FILE_MODE)
  try {
    await log.chmod(FILE_MODE)
  } finally {
    await log.close()
  }
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  const user = uid === undefined || gid === undefined ? undefined : `${String(uid)}:${String(gid)}`
  const registry = process.env['NPM_REGISTRY'] ?? 'https://registry.npmmirror.com/'
  const cidFile = path.join(dir, 'container.cid')
  // The image's entrypoint is dsh itself; without --entrypoint the command would be handed to it
  // as dsh arguments and boot a second server. --user keeps the mounted tree owned by the broker's
  // uid, since --entrypoint bypasses the entrypoint's own setpriv drop. Not a Windows target: the
  // broker runs on the host as the same POSIX user that owns the checkout.
  try {
    await docker(
      ctx,
      [
        'run',
        '--rm',
        '--cidfile',
        cidFile,
        '--entrypoint',
        'sh',
        ...(user === undefined ? [] : ['--user', user]),
        '-v',
        `${dir}:/src`,
        '-w',
        '/src',
        '-e',
        `npm_config_registry=${registry}`,
        BUILD_CONTAINER,
        '-c',
        BUILD_COMMAND,
      ],
      'tail',
      { timeoutMs: remaining(deadline), logPath },
    )
  } catch (error) {
    // A killed client does not stop its container: remove the one this run started, with a context
    // that is not the aborted one (that would cancel the cleanup too).
    const cid = await readFile(cidFile, 'utf8').catch(() => null)
    if (cid !== null && cid.trim() !== '') {
      const cleanup = { ...ctx, signal: undefined }
      await docker(cleanup, ['rm', '--force', cid.trim()]).catch(() => null)
    }
    throw error
  }
  await docker(
    ctx,
    [
      'build',
      '--tag',
      BUILD_IMAGE,
      // Retention: the previous :dev image becomes untagged, and a prune keeps this one.
      '--label',
      'idsh.keep=1',
      '--file',
      path.join(dir, 'Dockerfile.dev'),
      dir,
    ],
    'tail',
    { timeoutMs: remaining(deadline), logPath },
  )
}
