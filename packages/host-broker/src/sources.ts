/**
 * The operations this slice exposes.
 *
 * Each one names a **source** rather than a command: a fixed set of files or one fixed program,
 * with a small set of validated arguments. That is the whole shape — the questions asked of a host
 * are unbounded, the places an answer can come from are not. `run` is the one operation that takes
 * an argv, and it takes only the form its declaration allows: a declared binary, declared flags and
 * a positional shape checked against the declaration, never a shell. No declaration takes a path
 * yet, so there is no path guard to get wrong.
 */
import { spawn } from 'node:child_process'
import {
  appendFile,
  chmod,
  lstat,
  readdir,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
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
  RECREATE_POLL_MS,
  RECREATE_WAIT_MS,
  TAIL_WINDOW_BYTES,
  VERSIONS_TIMEOUT_MS,
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
  /** The compose file(s) that run the broker. */
  readonly gcbCompose?: readonly string[]
  /** The service in those files that runs the broker. */
  readonly gcbService: string
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
  /**
   * The read-only operation that resolves what this one would do, so the person is asked about
   * that.
   */
  readonly preview?: string
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
  /** Answer with stdout only; a caller that parses the output must not see compose's warnings. */
  readonly stdoutOnly?: boolean
  /** Called when the program wrote more than the retained window, so the answer is a prefix. */
  readonly onTruncated?: () => void
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
    // Kept apart from the answer: a caller that parses stdout still needs the reason a program
    // failed, and that reason is usually on stderr.
    let errors = Buffer.alloc(0)

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
    let announcedCut = false
    const collect = (chunk: Buffer): void => {
      if (logPath !== undefined) {
        // Chunks arrive in order but the writes are async: chain them, so the file is ordered.
        logChain = logChain
          .then(() => appendFile(logPath, chunk, { mode: FILE_MODE }))
          .catch(() => null)
      }
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_EXEC_BUFFER_BYTES) {
        if (!announcedCut) {
          announcedCut = true
          options.onTruncated?.()
        }
        // The retained window's start never reaches a client: the answer cap keeps the last
        // 64 KiB of it, and that boundary is repaired by `decodeTail`.
        buffer =
          keep === 'tail'
            ? buffer.subarray(buffer.length - MAX_EXEC_BUFFER_BYTES)
            : buffer.subarray(0, MAX_EXEC_BUFFER_BYTES)
      }
    }

    child.stdout.on('data', collect)
    // Warnings still reach the log, but not the parsed answer; the failure path reads `errors`.
    child.stderr.on('data', (chunk: Buffer) => {
      errors = Buffer.concat([errors, chunk])
      if (errors.length > MAX_EXEC_BUFFER_BYTES) {
        errors = errors.subarray(errors.length - MAX_EXEC_BUFFER_BYTES)
      }
      if (options.stdoutOnly !== true) {
        collect(chunk)
      } else if (logPath !== undefined) {
        logChain = logChain
          .then(() => appendFile(logPath, chunk, { mode: FILE_MODE }))
          .catch(() => null)
      }
    })
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
      const failure = options.stdoutOnly === true && errors.length > 0 ? errors : buffer
      const text = (failure.length > 0 ? failure : errors).toString('utf8').trim()
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
): Promise<number | undefined> {
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
    let exited: number | undefined
    try {
      await new Promise<void>(resolve => {
        child.once('error', () => resolve())
        child.once('exit', code => {
          exited = code ?? undefined
          resolve()
        })
      })
    } finally {
      clearTimeout(timer)
    }
    return exited
  } finally {
    await log.close()
  }
}

/** Whether the container is up, and what docker says about it. */
interface RecreateState {
  readonly ok: boolean
  /** Waiting longer cannot help: exited, dead, restarting, unhealthy, or no healthcheck. */
  readonly terminal: boolean
  readonly status: string
  readonly health: string
  /** The image id docker reports for the container. */
  readonly image: string
  readonly text: string
}

/** Ask docker about one container by id; a container mid-swap is not an error yet. */
async function deploymentState(ctx: OpContext, id: string): Promise<RecreateState | undefined> {
  try {
    const text = await docker(
      ctx,
      [
        'inspect',
        '--format',
        'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} image={{.Image}}',
        id,
      ],
      'head',
      // Parsed, so a docker warning on stderr must not become part of the state.
      { stdoutOnly: true },
    )
    const status = /status=(\S+)/u.exec(text)?.[1]
    const health = /health=(\S+)/u.exec(text)?.[1] ?? 'none'
    const image = /image=(\S+)/u.exec(text)?.[1] ?? ''
    // A boot line proves nothing on its own — a container can print it and exit — so the check the
    // compose file declares is what counts, and a container that declares none is not healthy.
    const ok = status === 'running' && health === 'healthy'
    // Docker's own verdict is the fastest signal there is: a crash loop or a failed check is not
    // going to fix itself inside the window.
    const terminal =
      status === 'exited' ||
      status === 'dead' ||
      status === 'restarting' ||
      (status === 'running' && (health === 'none' || health === 'unhealthy'))
    // The log line keeps the two facts a person reads; the image is carried as a field.
    return {
      ok,
      terminal,
      status: status ?? '',
      health,
      image,
      text: `status=${status ?? 'unknown'} health=${health}`,
    }
  } catch {
    return undefined
  }
}

/** The id of the running container, when there is one; a first deploy has none. */
async function existingContainerId(ctx: OpContext): Promise<string | undefined> {
  try {
    const id = (
      await docker(
        ctx,
        ['inspect', '--type', 'container', '--format', '{{.Id}}', ctx.container],
        'head',
        { stdoutOnly: true },
      )
    ).trim()
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}

/** The image the running container uses, when there is one. */
async function existingContainerImage(ctx: OpContext): Promise<string | undefined> {
  try {
    const image = (
      await docker(
        ctx,
        ['inspect', '--type', 'container', '--format', '{{.Image}}', ctx.container],
        'head',
        { stdoutOnly: true },
      )
    ).trim()
    return IMAGE_REFERENCE.test(image) ? image : undefined
  } catch {
    return undefined
  }
}

/** The id of the container compose just created, retried while it may still be appearing. */
async function recreatedContainerId(ctx: OpContext, deadline: number): Promise<string | undefined> {
  for (;;) {
    try {
      const id = (
        await docker(ctx, ['inspect', '--type', 'container', '--format', '{{.Id}}', ctx.container])
      ).trim()
      if (id !== '') {
        return id
      }
    } catch {
      // Not there yet, or not there at all; the deadline decides which.
    }
    if (Date.now() >= deadline) {
      return undefined
    }
    await new Promise(resolve => setTimeout(resolve, RECREATE_POLL_MS))
  }
}

/** Poll one container until it is healthy, terminal, or out of time. */
async function waitForState(
  ctx: OpContext,
  id: string,
  deadline: number,
): Promise<RecreateState | undefined> {
  let state = await deploymentState(ctx, id)
  while (!(state?.ok ?? false) && state?.terminal !== true) {
    if (Date.now() >= deadline) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, RECREATE_POLL_MS))
    state = await deploymentState(ctx, id)
  }
  return state
}

/**
 * Wait for the recreated deployment to prove itself, and roll it back when it does not.
 *
 * The caller's connection is already gone — the container it lives in was replaced — so the answer
 * cannot report this: what happened goes to the compose log, where an operator looks after a swap.
 * The read is pinned to the id compose created: a container replaced under us is not the one we
 * were asked to watch, so it counts as a failure to come up, not as a success.
 */
interface SwapResult {
  /** The container id before the swap, when there was one. */
  readonly before?: string
  /** The image that was running before the swap; a recreate restores exactly that. */
  readonly restoreTo?: string
  /** Compose's exit code, or undefined when the spawn itself failed. */
  readonly composeExit?: number
}

interface VerifyOptions {
  /** A rescue has nothing newer to return to; it reports instead of rolling back. */
  readonly rollback?: boolean
  /** A recreate restores the image already running, so a tag-and-up could only be a no-op. */
  readonly skipNoopRestore?: boolean
  /** The image id the deployment must run for this swap to count (a rollback's target). */
  readonly expectImage?: string
}

async function verifyRecreate(
  ctx: OpContext,
  checkout: string,
  swap: SwapResult,
  options: VerifyOptions = {},
): Promise<void> {
  const { before, restoreTo, composeExit } = swap
  const rollback = options.rollback ?? true
  const logPath = path.join(ctx.stateDir, 'compose.log')
  const note = async (line: string): Promise<void> => {
    await appendFile(logPath, `verify: ${line}\n`, { mode: FILE_MODE }).catch(() => null)
  }
  const deadline = Date.now() + RECREATE_WAIT_MS
  const id = await recreatedContainerId(ctx, deadline)
  const state = id === undefined ? undefined : await waitForState(ctx, id, deadline)
  const image = state?.image === '' ? undefined : state?.image
  // Compose exiting 0 and a healthy container is the whole success condition. `id === before` is
  // not a failure: a profile-only change, or shipping an unchanged main, leaves a bind-mounted
  // container alone and compose says "Running" without doing anything — that is a no-op, and the
  // container it left behind is exactly the one that should be reported as up.
  if (
    composeExit === 0 &&
    state?.ok === true &&
    (options.expectImage === undefined || image === options.expectImage)
  ) {
    const unchanged = id !== undefined && id === before
    await note(
      unchanged
        ? `compose left ${ctx.container} in place (the container is unchanged); it is up (${state.text})`
        : `${ctx.container} is up (${state.text})`,
    )
    return
  }
  if (composeExit === 0 && state?.ok === true && options.expectImage !== undefined) {
    // Healthy, but not the image the tag was supposed to put in front of us: the tag did not take
    // effect (the compose file starts something else), and saying "is up" would hide that.
    await note(
      `${ctx.container} is up (${state.text}) but runs ${image ?? 'an image docker could not name'}, not ${options.expectImage}`,
    )
    return
  }
  const missingHealth = state?.status === 'running' && state.health === 'none'
  let why: string
  if (composeExit === 0) {
    if (id === undefined) {
      why = 'no container appeared'
    } else if (state === undefined) {
      why = 'the container disappeared while it was watched'
    } else if (missingHealth) {
      why = `${state.text} — no healthcheck is declared in the compose file`
    } else {
      why = state.text
    }
  } else {
    why = `compose exited with ${String(composeExit ?? 'no status')}`
  }
  // `deploy.recreate` restores the image it found running, so when compose failed and left that
  // container untouched and healthy, a tag-and-up could only re-create the same container: skip it
  // and say so, rather than spend the rescue path on a no-op. `deploy.main` keeps the path: its
  // target is recorded immediately before its own build, so restoring it is a real retag.
  if (
    options.skipNoopRestore === true &&
    composeExit !== 0 &&
    state?.ok === true &&
    id !== undefined &&
    id === before
  ) {
    await note(
      `${ctx.container} is unchanged and healthy after ${why}; restoring the image already running would change nothing, so nothing is rolled back`,
    )
    return
  }
  if (!rollback) {
    // A rollback has nothing newer to return to; say whether the rescue worked instead.
    await note(`${ctx.container} did not come up (${why}); not rolling back any further`)
    return
  }
  await note(`${ctx.container} did not come up (${why}); rolling back`)
  let previous: string | undefined = restoreTo
  if (previous === undefined) {
    try {
      previous = await rollbackTarget(ctx)
    } catch (error) {
      await note(`no rollback target (${messageOf(error)}); leaving the deployment as it is`)
      return
    }
  }
  let rollbackExit: number | undefined
  try {
    await docker(ctx, ['tag', previous, BUILD_IMAGE])
    rollbackExit = await composeDetached(ctx, checkout, ['up', '-d', '--no-build'])
  } catch (error) {
    await note(`the rollback itself failed (${messageOf(error)}); the deployment needs a person`)
    return
  }
  if (rollbackExit !== 0) {
    // The rescue failed: compose's answer and the moved tag are what is known. What the container
    // did after a failed `up` is not verified here, so the line does not claim it.
    await note(
      `the rollback's compose exited with ${String(rollbackExit ?? 'no status')}; ${BUILD_IMAGE} now names ${previous}`,
    )
    return
  }
  // The rescue worked when the deployment runs the target image again and is healthy. Whether that
  // needed a new container is docker's business: a tag moved back to the image already running
  // (a failed build-based deploy, or a recreate restoring what it found) restores the deployment
  // without replacing anything.
  const rolledBackDeadline = Date.now() + RECREATE_WAIT_MS
  const rolledBack = await recreatedContainerId(ctx, rolledBackDeadline)
  if (rolledBack === undefined) {
    await note(`rolled back to ${previous}, but no container appeared`)
    return
  }
  const after = await waitForState(ctx, rolledBack, rolledBackDeadline)
  // `previous` can be a registry digest while the container reports its image id, so resolve the
  // target once and compare ids; no answer means fall back to what the file names.
  const targetId =
    (await imageId(
      ctx,
      previous,
      Math.min(ctx.execTimeoutMs, Math.max(1, rolledBackDeadline - Date.now())),
    )) || previous
  const afterImage = after?.image === '' ? undefined : after?.image
  if (after?.ok === true && (afterImage === previous || afterImage === targetId)) {
    await note(`rolled back to ${previous}; ${ctx.container} is up (${after.text})`)
    return
  }
  if (afterImage === previous || afterImage === targetId) {
    await note(
      `rolled back to ${previous}, but ${ctx.container} still is not up (${after?.text ?? 'docker could not be asked'})`,
    )
    return
  }
  await note(
    `rolled back to ${previous}, but the deployment runs ${afterImage ?? 'an image docker could not name'}`,
  )
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

/** The label every image this broker builds carries, so a prune keeps it and the sweep finds it. */
const KEEP_LABEL = 'idsh.keep=1'

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

/** What an unknown value says when it is turned into a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What is left of one operation's budget. */
function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

/* ---------------------------------------------------------------- broker.status / broker.update */

const BROKER_PACKAGE = '@idsh/host-broker'

/** Up to how many links one resolution follows, so a chain that loops cannot hang the operation. */
const MAX_LINK_HOPS = 16

/**
 * A path as the filesystem names it, so the two sides of the comparison agree when one is reached
 * through a symlink — a deployment whose checkout lives under `/var/services` and a process whose
 * entry resolved to `/volume1` are the same tree, and a plain `resolve` cannot say so.
 *
 * A path that no longer exists is named through its nearest existing ancestor and the segments
 * below it, because a cleaned `lib/` must not turn a symlinked checkout into "outside the
 * checkout".
 */
async function realOrResolved(value: string, hops = 0): Promise<string> {
  const resolved = path.resolve(value)
  const missing: string[] = []
  let head = resolved
  for (;;) {
    try {
      return path.join(await realpath(head), ...missing.toReversed())
    } catch (error) {
      const parent = path.dirname(head)
      // Only "this segment is missing" continues the walk; a loop or a permission error is a path
      // that exists in some form, and the lexical name is the honest answer for it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === head) {
        return resolved
      }
      // A dangling link still names where it pointed: follow that instead of treating the link's
      // own name as the missing segment, because the target may be the tree being looked for.
      const target = hops < MAX_LINK_HOPS ? await danglingTarget(head) : undefined
      if (target !== undefined) {
        return realOrResolved(path.join(target, ...missing.toReversed()), hops + 1)
      }
      missing.push(path.basename(head))
      head = parent
    }
  }
}

/**
 * The target of a symlink whose target is gone, or `undefined` when the path is not a symlink (or
 * cannot be read at all, which is not this case to answer).
 */
async function danglingTarget(value: string): Promise<string | undefined> {
  try {
    if (!(await lstat(value)).isSymbolicLink()) {
      return undefined
    }
    const link = await readlink(value)
    // A relative target is relative to the directory the link lives in *as the filesystem names
    // it*: the lexical parent may itself be a symlink, and the two spellings reach different trees.
    const parent = await realpath(path.dirname(value)).catch(() => path.dirname(value))
    const target = path.isAbsolute(link) ? link : path.resolve(parent, link)
    return target === path.resolve(value) ? undefined : target
  } catch {
    return undefined
  }
}

/**
 * How this broker was installed, read from the program it is running: inside the checkout it builds
 * there (the entry it is running from), otherwise the published package is what to update.
 */
async function brokerUpdateSource(ctx: OpContext): Promise<'checkout' | 'npm'> {
  if (ctx.checkout === undefined) {
    return 'npm'
  }
  const entry = await realOrResolved(ctx.entryPath)
  const relative = path.relative(await realOrResolved(ctx.checkout), entry)
  // `..` as a segment, not as a prefix: a child directory called `..build` is inside the checkout,
  // and a plain `startsWith('..')` would send it to the npm branch and the refusal there.
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`)
  return relative !== '' && !outside ? 'checkout' : 'npm'
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

/* ------------------------------------------------------------------ run */

/** Where the declared binaries are looked for, independent of the PATH the broker inherited. */
const RUN_PATH = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
].join(':')

/** The most tokens one `run` call may carry, and the longest a single token may be. */
const MAX_RUN_TOKENS = 16
const MAX_RUN_TOKEN_CHARS = 128

/** Flags a `run` declaration accepts: a bare switch, or one that takes the next token as its value. */
type RunFlag = 'boolean' | 'value'

/** One binary `run` may start. Adding a binary is a declaration, not code. */
interface RunDeclaration {
  readonly summary: string
  /** The first positional must be one of these, when set. */
  readonly subcommands?: readonly string[]
  readonly flags?: Readonly<Record<string, RunFlag>>
  /** What a positional may look like, when the binary takes any. */
  readonly positional?: (value: string) => boolean
  /** How many positionals the declaration requires, subcommand excluded. */
  readonly minPositionals?: number
  /** How many positionals the declaration allows, subcommand excluded. */
  readonly maxPositionals?: number
}

/**
 * A hostname, an IPv4 literal or an IPv6 literal, and nothing that could be a flag or a path. The
 * first character may be a colon because every compressed IPv6 literal starts with one (`::1`); a
 * bare colon run is still refused, since it names no host.
 */
const RUN_TARGET = /^(?=.*[A-Za-z0-9])[A-Za-z0-9:](?:[A-Za-z0-9._:%-]{0,252})$/u

/**
 * No declaration takes a filesystem path yet, on purpose: the ROADMAP's race-safe guard (resolve
 * once, consume the resolved object, and only inside a root the container's uid cannot write) is
 * what a path-taking binary has to land with. A declaration without paths does not need it, and
 * saying so here is cheaper than a guard nobody exercises.
 */
const RUN_BINARIES: Readonly<Record<string, RunDeclaration>> = {
  ping: {
    summary: 'ICMP probe: ping -c/-W/-w, -4/-6, -q, -n, one host.',
    flags: {
      c: 'value',
      W: 'value',
      w: 'value',
      '4': 'boolean',
      '6': 'boolean',
      q: 'boolean',
      n: 'boolean',
    },
    positional: value => RUN_TARGET.test(value),
    minPositionals: 1,
    maxPositionals: 1,
  },
  dig: {
    summary: 'DNS query: dig +short/+noall/+answer, one host.',
    flags: { '+short': 'boolean', '+noall': 'boolean', '+answer': 'boolean' },
    positional: value => RUN_TARGET.test(value),
    maxPositionals: 1,
  },
  traceroute: {
    summary: 'Path probe: traceroute -n/-m/-w/-q, one host.',
    flags: { n: 'boolean', m: 'value', w: 'value', q: 'value', '4': 'boolean', '6': 'boolean' },
    positional: value => RUN_TARGET.test(value),
    minPositionals: 1,
    maxPositionals: 1,
  },
  ip: {
    summary: 'ip addr/route/neigh: -4/-6/-o/-s.',
    subcommands: ['addr', 'route', 'neigh'],
    flags: { '4': 'boolean', '6': 'boolean', o: 'boolean', s: 'boolean' },
  },
  ss: {
    summary: 'Socket tables: ss -t/-u/-l/-n/-p/-a/-s.',
    flags: {
      t: 'boolean',
      u: 'boolean',
      l: 'boolean',
      n: 'boolean',
      p: 'boolean',
      a: 'boolean',
      s: 'boolean',
    },
  },
  df: {
    summary: 'Filesystem usage: df -h/-a/-i/-P (every mount, no path argument).',
    flags: { h: 'boolean', a: 'boolean', i: 'boolean', P: 'boolean' },
  },
  free: {
    summary: 'Memory: free -h/-m/-g.',
    flags: { h: 'boolean', m: 'boolean', g: 'boolean' },
  },
  uptime: { summary: 'Load average and uptime.' },
}

/** The declared name a token spells, or `undefined` when it spells none of them. */
function flagName(token: string): string | undefined {
  // One leading dash, or the plus `dig` uses — the declaration's spelling exactly. `--h` for a
  // declared `-h` would be a second grammar, and `-+short` is not the plus form either.
  if (token.startsWith('+')) {
    return token
  }
  return /^-[^-+]/u.test(token) ? token.slice(1) : undefined
}

/** One parsed `run` call: the program, its argv, and what the declaration said about it. */
interface RunVerdict {
  readonly program: string
  readonly argv: readonly string[]
}

/**
 * Turn the caller's tokens into the argv the declaration allows.
 *
 * Parsed, not passed through: a token starting with `-` is a flag and must be declared, a
 * positional must match the declaration, and nothing is ever handed to a shell.
 */
function parseRun(tokens: readonly string[]): RunVerdict {
  if (tokens.length === 0) {
    throw new BrokerFault('bad-argument', 'argv needs at least the program to run')
  }
  if (tokens.length > MAX_RUN_TOKENS) {
    throw new BrokerFault('bad-argument', `argv may carry at most ${String(MAX_RUN_TOKENS)} tokens`)
  }
  for (const token of tokens) {
    if (token.length === 0 || token.length > MAX_RUN_TOKEN_CHARS) {
      throw new BrokerFault(
        'bad-argument',
        `every argv token must be 1-${String(MAX_RUN_TOKEN_CHARS)} characters`,
      )
    }
  }
  const [program, ...rest] = tokens
  const declaration = Object.hasOwn(RUN_BINARIES, program) ? RUN_BINARIES[program] : undefined
  if (declaration === undefined) {
    throw new BrokerFault(
      'bad-argument',
      `${JSON.stringify(program)} is not a declared binary; ${Object.keys(RUN_BINARIES).sort().join(', ')}`,
    )
  }
  const argv: string[] = [program]
  const subcommands = declaration.subcommands
  let sawSubcommand = subcommands === undefined
  let positionals = 0
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token.startsWith('-') || token.startsWith('+')) {
      if (token === '--' || token === '-') {
        throw new BrokerFault('bad-argument', `${JSON.stringify(token)} is not a declared flag`)
      }
      const name = flagName(token)
      const flags = declaration.flags
      const kind =
        name !== undefined && flags !== undefined && Object.hasOwn(flags, name)
          ? flags[name]
          : undefined
      if (kind === undefined) {
        throw new BrokerFault('bad-argument', `${program} does not accept ${JSON.stringify(token)}`)
      }
      argv.push(token)
      if (kind === 'value') {
        const value = rest[index + 1]
        if (
          value === undefined ||
          value.startsWith('-') ||
          !/^[A-Za-z0-9._:+,]{1,64}$/u.test(value)
        ) {
          throw new BrokerFault('bad-argument', `${token} needs one value`)
        }
        argv.push(value)
        index += 1
      }
      continue
    }
    if (!sawSubcommand) {
      if (subcommands === undefined || !subcommands.includes(token)) {
        throw new BrokerFault(
          'bad-argument',
          `${program} needs one of ${(subcommands ?? []).map(item => JSON.stringify(item)).join(', ')}`,
        )
      }
      sawSubcommand = true
      argv.push(token)
      continue
    }
    if (declaration.positional === undefined || !declaration.positional(token)) {
      throw new BrokerFault('bad-argument', `${program} does not accept ${JSON.stringify(token)}`)
    }
    positionals += 1
    if (positionals > (declaration.maxPositionals ?? 0)) {
      throw new BrokerFault('bad-argument', `${program} accepts no more positionals`)
    }
    argv.push(token)
  }
  if (!sawSubcommand) {
    throw new BrokerFault(
      'bad-argument',
      `${program} needs one of ${(subcommands ?? []).map(item => JSON.stringify(item)).join(', ')}`,
    )
  }
  // A verdict has to be runnable: `ping` and `traceroute` without a target exit non-zero without
  // probing anything, and a dry run that approves them answers a question nobody can execute.
  const minimum = declaration.minPositionals ?? 0
  if (positionals < minimum) {
    throw new BrokerFault(
      'bad-argument',
      `${program} needs at least ${String(minimum)} positional argument${minimum === 1 ? '' : 's'}`,
    )
  }
  return { program, argv }
}

/** The text a dry run answers: the exact argv, and the note that nothing ran. */
function describeRun(verdict: RunVerdict): string {
  return `would run: ${verdict.argv.join(' ')}\nnothing was executed; dryRun answered the policy verdict only`
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

/** One field of an object-shaped value from a program's JSON, or undefined. */
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

/** A path through object-shaped JSON, one field at a time. */
const fieldOf = (value: unknown, ...keys: string[]): unknown => keys.reduce(field, value)

/** The non-empty lines of a program's answer, trimmed. */
const linesOf = (output: string): string[] =>
  output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')

/** A message that says which steps already worked, when any did. */
const withCompleted = (message: string, done: readonly string[]): string =>
  done.length === 0 ? message : `${message}; completed: ${done.join('; ')}`

/** How long the post-update probe may take; it answers over the network, unlike a local read. */
const PROBE_TIMEOUT_MS = 60_000
/** How long each local docker query in `gcb.update` may take; they run in milliseconds. */
const GCB_QUERY_TIMEOUT_MS = 10_000
/** The local queries `gcb.update` runs: services, images, replicas, ps and inspect. */
const GCB_QUERIES = 5
/** The steps that may take the build budget: pull, build and recreate. */
const GCB_BUILD_STEPS = 3

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
  const composeFiles = ctx.gcbCompose
  const repo = ctx.gcbProbeRepo
  const service = ctx.gcbService
  if (composeFiles === undefined || checkout === undefined || repo === undefined) {
    throw new BrokerFault('unavailable', 'the broker is not configured for gcb.update')
  }
  // One prefix for every `compose` call: a deployment that renders a base file plus an overlay is
  // the same set of files everywhere here. Compose interpolates UID and GID, and the broker's own
  // environment may not carry them.
  const composeArgs = ['compose', ...composeFiles.flatMap(file => ['-f', file])]
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  const composeEnv: NodeJS.ProcessEnv = {
    ...(uid === undefined ? {} : { UID: String(uid) }),
    ...(gid === undefined ? {} : { GID: String(gid) }),
  }
  const queryOptions = {
    cwd: checkout,
    stdoutOnly: true,
    env: composeEnv,
    timeoutMs: GCB_QUERY_TIMEOUT_MS,
  }
  const compose = (args: string[], options: RunOptions = queryOptions): Promise<string> =>
    docker(ctx, [...composeArgs, ...args], 'head', options)
  // Each step names itself, in the answer and in the failure: a pull that worked and a build that
  // did not are different answers to whoever reads the audit log.
  const done: string[] = []
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      const message = messageOf(error)
      const failure = withCompleted(`gcb.update: ${name} failed: ${message}`, done)
      throw new BrokerFault(error instanceof BrokerFault ? error.code : 'unavailable', failure)
    }
  }
  const pull =
    linesOf(
      await step('pull', () =>
        git(
          ctx,
          ['pull', '--ff-only'],
          { stdoutOnly: true, timeoutMs: BUILD_TIMEOUT_MS },
          checkout,
        ),
      ),
    )[0] ?? ''
  done.push(`pull: ${pull}`)
  // The named service, not the file: a deployment compose also runs dsh, and this operation must
  // touch only the broker's container.
  const services = linesOf(await step('read the services', () => compose(['config', '--services'])))
  if (!services.includes(service)) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(
        `the broker's compose has no service ${JSON.stringify(service)}; it has ${
          services.length === 0 ? 'none' : services.join(', ')
        }`,
        done,
      ),
    )
  }
  const images = linesOf(
    await step('read the image', () => compose(['config', '--images', service])),
  )
  if (images.length !== 1) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(
        `the broker's service names ${String(images.length)} images; gcb.update builds exactly one`,
        done,
      ),
    )
  }
  const image = images[0]
  done.push(`image: ${image}`)
  // The broker is one container, so a service that asks for replicas is a configuration this cannot
  // verify: `ps -q` lists only running containers, and one stopped replica among two would pass.
  const replicas = await step('read the replica count', async () => {
    const text = await compose(['config', '--format', 'json'])
    const parsed: unknown = JSON.parse(text)
    const entry = fieldOf(parsed, 'services', service)
    // `scale` at the service's top level is the short form of `deploy.replicas`; either one asks
    // for more than the single container this operation can verify.
    return [field(entry, 'scale'), fieldOf(entry, 'deploy', 'replicas')].find(
      (value): value is number => typeof value === 'number' && value !== 1,
    )
  })
  // `find` only returns a count that is not one, so its presence is the refusal.
  if (replicas !== undefined) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(
        `the broker's service declares ${String(replicas)} replicas; gcb.update expects one container`,
        done,
      ),
    )
  }
  await step('build', () =>
    docker(ctx, ['build', '--target', 'host', '-t', image, '.'], 'tail', {
      cwd: checkout,
      timeoutMs: BUILD_TIMEOUT_MS,
    }),
  )
  done.push('build: ok')
  // The image this operation just built is the one that runs: never build from a compose `build:`
  // stanza, never reach for a registry.
  await step('recreate', () =>
    compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', service], {
      cwd: checkout,
      env: composeEnv,
      timeoutMs: BUILD_TIMEOUT_MS,
    }),
  )
  done.push(`recreate: up -d --no-deps --no-build --pull never --wait ${service}`)
  const ids = linesOf(await step('list the container', () => compose(['ps', '-q', service])))
  if (ids.length !== 1) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(
        ids.length === 0
          ? 'the broker container is not running after the recreate'
          : `the broker service runs ${String(ids.length)} containers; gcb.update expects one`,
        done,
      ),
    )
  }
  const states = await step('inspect the container state', () =>
    Promise.all(
      ids.map(id =>
        docker(
          ctx,
          [
            'inspect',
            '--format',
            '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
            id,
          ],
          'head',
          { stdoutOnly: true, timeoutMs: GCB_QUERY_TIMEOUT_MS },
        ),
      ),
    ),
  )
  const state = states.map(entry => entry.trim()).join(', ')
  const unhealthy = states
    .map(entry => entry.trim())
    .filter(entry => !/^running(?: healthy)?$/u.test(entry))
  if (unhealthy.length > 0) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(`the broker container is ${unhealthy.join(', ')}; state: ${state}`, done),
    )
  }
  done.push(`state: ${state}`)
  // State is not reachability: the probe asks the broker through the client the deployment uses, so
  // "updated" means "a push would be issued a credential". It mints a token, so it gets its own
  // budget rather than the ten-second default.
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
    name: 'deploy.versions',
    summary:
      'What the deployment is running — its state and image, and the dsh and gcb versions inside it.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    // Four docker calls in sequence, so they get their own budget rather than the 10 s default.
    timeoutMs: VERSIONS_TIMEOUT_MS,
    async run(args, ctx) {
      rejectUnknown(args, [])
      // One deadline for the whole read, and each call may take only what is left of it: a raised
      // per-program default must not let the op outlive the timeout its client was promised.
      const deadline = Date.now() + VERSIONS_TIMEOUT_MS
      // `remaining` already floors at one millisecond.
      const budget = (): number => Math.min(ctx.execTimeoutMs, remaining(deadline))
      // The id, not the name: a recreate between these calls would otherwise answer with one
      // deployment's state and the next one's versions. Exec against the old id fails instead.
      const id =
        // `--type container`, like deploy.status: `docker inspect` otherwise resolves a name
        // across object types, and an image or volume that shares it would answer instead.
        (
          await docker(
            ctx,
            ['inspect', '--type', 'container', '--format', '{{.Id}}', ctx.container],
            'head',
            {
              // Parsed, so a docker warning on stderr must not become part of the id.
              stdoutOnly: true,
              timeoutMs: budget(),
            },
          )
        ).trim()
      // Labelled like deploy.status, so the two reads of the same container read alike.
      const state = await docker(
        ctx,
        [
          'inspect',
          '--type',
          'container',
          '--format',
          'status={{.State.Status}} image={{.Config.Image}} image-id={{.Image}} created={{.Created}}',
          id,
        ],
        'head',
        { stdoutOnly: true, timeoutMs: budget() },
      )
      // Sequential on purpose: concurrent `docker exec` calls that fail in the runtime can report
      // each other's error text (measured), and a read that names the wrong binary as missing is
      // worse than the second it saves.
      const probes: string[] = []
      // Fixed probes only: the broker exposes no arbitrary exec, so what can be asked is what is
      // declared here.
      for (const [name, command] of [
        ['dsh', ['dsh', '--version']],
        ['gcb', ['gcb', '--version']],
      ] as const) {
        try {
          const answer = await docker(ctx, ['exec', id, ...command], 'head', {
            stdoutOnly: true,
            timeoutMs: budget(),
          })
          probes.push(`${name}: ${answer.trim()}`)
        } catch (error) {
          // An image without gcb is ordinary; the answer says so instead of failing the whole read.
          // The tail is the line that says why — the rule runFixed keeps for docker.
          const message = messageOf(error).trim()
          const last = message.split('\n').at(-1) ?? message
          probes.push(`${name}: unavailable — ${last}`)
        }
      }
      return [`${ctx.container}: ${state.trim()}`, ...probes].join('\n')
    },
  },
  {
    name: 'deploy.source',
    summary:
      'Check a build request and resolve what it would build — the branch tip and main, or main alone — without building.',
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
        for: {
          type: 'string',
          description: 'The operation this resolves, so the check matches what that one accepts.',
        },
        log: {
          type: 'string',
          description: 'Checked exactly as the build checks it, and otherwise unused.',
        },
      },
      additionalProperties: false,
    },
    // git resolves refs in a second or two, but a slow origin is a build's problem, not a read's.
    timeoutMs: BUILD_TIMEOUT_MS,
    async run(args, ctx) {
      rejectUnknown(args, ['pr', 'sha', 'for', 'log'])
      // The whole request is checked here, not only the part this resolves: an argument the build
      // would refuse must not reach the person as a question they cannot answer usefully.
      optionalLog(args)
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      // `deploy.main` builds main, and its question is about main, so nothing else is accepted.
      if (args['for'] === 'deploy.main') {
        if (args['pr'] !== undefined || args['sha'] !== undefined) {
          throw new BrokerFault(
            'bad-argument',
            'deploy.main resolves main; give pr or sha to deploy.build instead',
          )
        }
        const main = await resolveMainSource(ctx, deadline)
        return `main at ${main.sha}`
      }
      // Anything else is `deploy.build`, which refuses a request without one of the two — the
      // preview refuses it too, so the person is never asked about a build that cannot start.
      const source = await resolveBuildSource(ctx, args, deadline)
      return `${source.label} at ${source.sha}; main at ${source.mainSha}`
    },
  },
  {
    name: 'deploy.build',
    summary:
      'Build the :dev image from a PR head or the tip of an origin branch; the root files stay at main.',
    confirm: true,
    preview: 'deploy.source',
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
      const { previous, failed } = await buildInto(ctx, source, deadline, log)
      return (
        `built ${source.label} (${source.sha}) as ${BUILD_IMAGE}; main ${source.mainSha}; previous image ${previous}` +
        reapNote(failed)
      )
    },
  },
  {
    name: 'deploy.main',
    summary: 'Build the tip of main as :dev, then recreate the container from it.',
    confirm: true,
    preview: 'deploy.source',
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
      const { previous, failed } = await buildInto(ctx, source, deadline, log)
      const before = await existingContainerId(ctx)
      const expectImage = (await imageId(ctx, BUILD_IMAGE, remaining(deadline))) || undefined
      return {
        text:
          `built ${source.label} (${source.sha}) as ${BUILD_IMAGE}; recreating from it; previous image ${previous}` +
          reapNote(failed),
        after: async () => {
          const composeExit = await composeDetached(ctx, checkout, ['up', '-d', '--no-build'])
          await verifyRecreate(ctx, checkout, { before, composeExit }, { expectImage })
        },
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
      const targetId = (
        await docker(ctx, ['image', 'inspect', '--format', '{{.Id}}', target], 'head', {
          stdoutOnly: true,
        })
      ).trim()
      const before = await existingContainerId(ctx)
      return {
        text: `rollback queued to ${target}; the session drops when the container is replaced`,
        after: async () => {
          try {
            await docker(ctx, ['tag', target, BUILD_IMAGE])
          } catch (error) {
            const message = messageOf(error)
            await appendFile(
              path.join(ctx.stateDir, 'compose.log'),
              `rollback tag failed: ${message}\n`,
              { mode: FILE_MODE },
            ).catch(() => null)
            throw error
          }
          const composeExit = await composeDetached(ctx, checkout, ['up', '-d', '--no-build'])
          await verifyRecreate(
            ctx,
            checkout,
            { before, composeExit },
            { rollback: false, expectImage: targetId === '' ? undefined : targetId },
          )
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
    async run(args, ctx) {
      rejectUnknown(args, [])
      const checkout = requireCheckout(ctx)
      const before = await existingContainerId(ctx)
      // The recorded rollback file belongs to the last build, not to what runs now: a recreate
      // restores the image it found, and only falls back to the file on a first deploy.
      const restoreTo = await existingContainerImage(ctx)
      const expectImage = (await imageId(ctx, BUILD_IMAGE, ctx.execTimeoutMs)) || undefined
      return {
        text: `recreate queued; the session drops when the container is replaced. compose log: ${path.join(ctx.stateDir, 'compose.log')}`,
        after: async () => {
          const composeExit = await composeDetached(ctx, checkout, ['up', '-d', '--no-build'])
          await verifyRecreate(
            ctx,
            checkout,
            { before, restoreTo, composeExit },
            { skipNoopRestore: true, expectImage },
          )
        },
      }
    },
  },

  {
    name: 'gcb.update',
    summary: 'Rebuild the credential broker from its checkout and recreate only its container.',
    confirm: true,
    serial: true,
    // The operation's own deadline has to outlast every step it runs: a pull, a build and a
    // recreate at the build budget, the probe, and the four local queries, or a slow link turns a
    // working update into a timeout halfway through it.
    timeoutMs:
      GCB_BUILD_STEPS * BUILD_TIMEOUT_MS + PROBE_TIMEOUT_MS + GCB_QUERIES * GCB_QUERY_TIMEOUT_MS,
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
      const source = await brokerUpdateSource(ctx)
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
    name: 'run',
    summary:
      'Run one declared, read-only binary on the host: an argv parsed against the declaration, never a shell.',
    confirm: true,
    input: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_RUN_TOKENS,
          description: `The program and its arguments, e.g. ["ping", "-c", "3", "1.1.1.1"].`,
        },
        dryRun: {
          type: 'boolean',
          description: 'Answer the policy verdict without running anything.',
        },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['argv', 'dryRun'])
      const raw = args['argv']
      if (!Array.isArray(raw)) {
        throw new BrokerFault('bad-argument', 'argv must be an array of strings')
      }
      // Narrowed element by element: `Array.isArray` leaves the elements `any`, and type coverage is
      // measured over this file, so the check has to say what it knows.
      const tokens: string[] = []
      for (const token of raw as unknown[]) {
        if (typeof token !== 'string') {
          throw new BrokerFault('bad-argument', 'argv must be an array of strings')
        }
        tokens.push(token)
      }
      const dryRun = args['dryRun']
      if (dryRun !== undefined && typeof dryRun !== 'boolean') {
        throw new BrokerFault('bad-argument', 'dryRun must be a boolean')
      }
      const verdict = parseRun(tokens)
      if (dryRun === true) {
        return describeRun(verdict)
      }
      const [, ...rest] = verdict.argv
      // The configured path wins where a source already owns the binary: `--ip`/`--ss` exist so a
      // host can name the client it actually has.
      const program =
        verdict.program === 'ip'
          ? ctx.ipPath
          : verdict.program === 'ss'
            ? ctx.ssPath
            : verdict.program
      return runFixed(ctx, program, rest, {
        // Not the broker's inherited PATH: a supervisor with a narrow one would make every declared
        // binary unreachable (ENOENT) rather than refused, and these live in the sbin directories on
        // most hosts. A fixed list is the same answer everywhere.
        env: { PATH: RUN_PATH },
      })
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

/** The protocol `ops.describe` is shaped for: the number a client compares with its own. */
export const DESCRIBE_PROTOCOL = 1

function describeTable(context?: OpContext): unknown[] {
  return available(context).map(({ name, summary, input, confirm, preview, timeoutMs }) => ({
    name,
    summary,
    input,
    ...(confirm === true ? { confirm: true } : {}),
    ...(preview === undefined ? {} : { preview }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }))
}

/**
 * What `ops.describe` answers — the table as the plugin sees it: names, summaries and each
 * operation's parameter schema.
 *
 * The negotiation is one-sided on purpose: a client that declares `{protocol}` gets the envelope —
 * the table, that protocol and this broker's version — and a client that sends nothing gets the
 * bare table. An older plugin throws on anything but an array, so answering it with the envelope
 * would cost it every host tool; a newer plugin reads both, so the bare table only means "older
 * broker".
 */
export function describeOps(context?: OpContext, args?: Record<string, unknown>): string {
  // Unknown keys are ignored on purpose: this request is versioned too. A newer plugin may send a
  // field this broker has never heard of, and answering the part it knows — with the protocol it
  // speaks — lets the client decide; refusing would turn skew into a hard failure here, which is
  // exactly what the negotiation exists to avoid.
  const declared = args?.['protocol']
  if (declared === undefined) {
    return JSON.stringify(describeTable(context), null, 2)
  }
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    throw new BrokerFault('bad-argument', 'protocol must be an integer')
  }
  return JSON.stringify(
    {
      protocol: DESCRIBE_PROTOCOL,
      version: context?.brokerVersion ?? 'unknown',
      ops: describeTable(context),
    },
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

/** Prepare, build and clean up; returns the previous image and what the sweep could not remove. */
async function buildInto(
  ctx: OpContext,
  source: BuildSource,
  deadline: number,
  logId: string | undefined,
): Promise<{ previous: string; failed: readonly string[] }> {
  const dir = await prepareBuildSource(ctx, source, deadline)
  try {
    // Recorded before the build, so the tag moving is what makes this the rollback target.
    const previous = await recordRollback(ctx)
    await buildImage(ctx, dir, deadline, logId)
    // Best effort: an image that cannot be removed is left for the next build, not an error, but the
    // answer says so — a silent failure would look like the bound held.
    const failed = await reapImages(ctx, previous, deadline).catch((error: unknown) => [
      messageOf(error),
    ])
    return { previous, failed }
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
  const idText = await docker(
    ctx,
    ['inspect', '--type', 'container', '--format', '{{.Image}}', ctx.container],
    'head',
    // Parsed into the rollback target: a docker warning on stderr must not become part of it.
    { stdoutOnly: true },
  )
  const id = idText.trim().split('\n')[0] ?? ''
  if (id === '') {
    throw new BrokerFault('unavailable', 'the container has no image to roll back to')
  }
  let previous = id
  try {
    const digestsText = await docker(
      ctx,
      ['inspect', '--type', 'image', '--format', '{{json .RepoDigests}}', id],
      'head',
      { stdoutOnly: true },
    )
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
/**
 * Retire the builds this one makes unnecessary.
 *
 * The build labels every image it produces `idsh.keep=1`, which is how the host's prune keeps them
 * and how this finds them again. A label means "built here, kept until superseded", not "this is
 * the rollback target", so the label alone is unbounded: after a build, every labelled image that
 * is neither the one the build produced nor the recorded target is retired. A successful removal is
 * what makes "at most two" true; anything it could not remove is reported, and the next build tries
 * again.
 *
 * @returns What could not be removed, empty when the sweep finished.
 */
async function reapImages(
  ctx: OpContext,
  previous: string,
  deadline: number,
): Promise<readonly string[]> {
  const timeoutMs = (): number => remaining(deadline)
  let cut = false
  const ids = linesOf(
    await docker(
      ctx,
      ['image', 'ls', '--quiet', '--no-trunc', '--filter', `label=${KEEP_LABEL}`],
      'head',
      {
        stdoutOnly: true,
        timeoutMs: timeoutMs(),
        onTruncated: () => {
          cut = true
        },
      },
    ),
  )
  if (cut) {
    // The ids behind the cut were never seen, so removing the ones in front of it would report a
    // finished sweep that did not finish.
    return ['more images carried the label than one listing could answer for; nothing was removed']
  }
  if (ids.length === 0) {
    return []
  }
  const keep = new Set<string>()
  // The image this build produced must survive: losing it loses the `:dev` tag the recreate uses.
  // When it cannot be resolved, nothing is removed at all rather than guessed at.
  const built = await imageId(ctx, BUILD_IMAGE, timeoutMs())
  if (built === '') {
    return ['the image this build produced could not be resolved, so nothing was removed']
  }
  keep.add(built)
  // The recorded target is an id when the image was built here, and a digest when it was pulled: a
  // digest is not on this daemon, and docker refuses to remove an image a running container uses,
  // so a failed lookup is a form this keeps as-is rather than a reason to remove it.
  keep.add(
    /^sha256:[0-9a-f]+$/u.test(previous)
      ? previous
      : (await imageId(ctx, previous, timeoutMs())) || previous,
  )

  const failed: string[] = []
  for (const id of ids) {
    if (keep.has(id)) {
      continue
    }
    // The build's budget is the operation's budget: a sweep that kept spawning 1 ms calls after the
    // deadline would turn a build that finished into a timeout, and the recreate would never run.
    if (Date.now() >= deadline) {
      failed.push('the sweep reached its deadline; later images were not considered')
      break
    }
    try {
      await docker(ctx, ['image', 'rm', id], 'tail', { timeoutMs: timeoutMs() })
    } catch (error) {
      failed.push(`${id}: ${messageOf(error)}`)
    }
  }
  return failed
}

/** The id a reference resolves to on this daemon, or nothing when it does not resolve here. */
async function imageId(ctx: OpContext, ref: string, timeoutMs: number): Promise<string> {
  const text = await docker(ctx, ['image', 'inspect', '--format', '{{.Id}}', ref], 'head', {
    stdoutOnly: true,
    timeoutMs,
  }).catch(() => '')
  return text.trim()
}

/** What the answer says about a sweep that could not finish. */
function reapNote(failed: readonly string[]): string {
  return failed.length === 0 ? '' : `; the image sweep did not finish: ${failed.join('; ')}`
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
      KEEP_LABEL,
      '--file',
      path.join(dir, 'Dockerfile.dev'),
      dir,
    ],
    'tail',
    { timeoutMs: remaining(deadline), logPath },
  )
}
