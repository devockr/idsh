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
import { existsSync } from 'node:fs'
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
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { openAppendLog } from './append-log.ts'
import {
  BUILD_TIMEOUT_MS,
  COMPOSE_TIMEOUT_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  GCB_HOST_POLL_MS,
  GCB_HOST_WAIT_MS,
  AUTHORIZE_TIMEOUT_MS,
  AUTHORIZE_MARGIN_MS,
  GCB_PULL_TIMEOUT_MS,
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
  /** The credential broker's checkout; `gcb.update` pulls it and rebuilds from it. */
  readonly gcbCheckout?: string
  /** The host broker's own directory: `app.ref`, its pid file and the staged export. */
  readonly gcbDeployDir?: string
  /** Whether `gcb.update` also moves the host-supervised broker to the same commit. */
  readonly gcbHostUpdate?: boolean
  /** The compose file(s) that run the broker. */
  readonly gcbCompose?: readonly string[]
  /** The client image to rebuild from the same checkout, when the deployment bakes one. */
  readonly gcbClientImage?: string
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
  /** Extra availability rule for a shape `requires` cannot express, such as "one of two halves". */
  readonly available?: (ctx: OpContext) => boolean
  run(args: Record<string, unknown>, ctx: OpContext): Promise<Execution | string>
}

/** The broker's environment plus an operation's overrides, with `undefined` meaning "remove". */
function withDropped(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(extra)) {
    if (extra[key] === undefined) {
      delete merged[key]
    }
  }
  return merged
}

interface RunOptions {
  readonly keep?: Keep
  /** How long this program may run; a build is minutes, not the default ten seconds. */
  readonly timeoutMs?: number
  /** Append the program's output here as it arrives, so a failed build stays diagnosable. */
  readonly logPath?: string
  /** Where the program runs; a compose file is relative to its checkout. */
  readonly cwd?: string
  /** Extra environment, merged over the broker's own; an `undefined` value removes the key. */
  readonly env?: NodeJS.ProcessEnv
  /** Answer with stdout only; a caller that parses the output must not see compose's warnings. */
  readonly stdoutOnly?: boolean
  /** Called when the program wrote more than the retained window, so the answer is a prefix. */
  readonly onTruncated?: () => void
}

/**
 * Put the tag back on the image the service was running, ignoring the request's signal — cancelling
 * is one way to fail here, and the tag still has to go back. The returned note is what the answer
 * says, on success and on failure alike.
 */
async function restoreTag(ctx: OpContext, previousImage: string, image: string): Promise<string> {
  const restoreCtx = { ...ctx }
  delete (restoreCtx as { signal?: AbortSignal }).signal
  try {
    await docker(restoreCtx, ['tag', previousImage, image], 'head', {
      stdoutOnly: true,
      timeoutMs: GCB_QUERY_TIMEOUT_MS,
    })
    return `the tag is back on ${previousImage}`
  } catch (error) {
    return `restoring ${previousImage} to ${image} failed: ${messageOf(error)}`
  }
}

/**
 * Run one fixed program with fixed arguments.
 *
 * No shell and no caller-supplied argv; both pipes are collected in arrival order, so a log that
 * writes to stderr is not reordered or welded onto stdout. Past the buffer ceiling a tail operation
 * keeps the last 1 MiB and a head operation the first 1 MiB; `capOutput` then trims to the answer
 * size, from the end a log is asked for.
 */
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
      ...(options.env === undefined ? {} : { env: withDropped(options.env) }),
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
          code ?? undefined,
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
  const log = await openAppendLog(logPath)
  try {
    await log.chmod(FILE_MODE)
    // The real compose interpolates UID/GID, which the broker's own environment does not
    // necessarily export (a user unit starts it without a login shell): pass its ids explicitly.
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    // Deployments that keep the broker in its own tracked overlay get it here; one that supervises
    // the broker elsewhere simply has no such file, and keeps the base + dev pair.
    const composeArgs = ['compose', '-f', 'docker-compose.yml']
    if (existsSync(path.join(checkout, 'docker-compose.broker.yml'))) {
      composeArgs.push('-f', 'docker-compose.broker.yml')
    }
    composeArgs.push('-f', 'docker-compose.dev.yml', ...args)
    const child = spawn(ctx.dockerPath, composeArgs, {
      detached: true,
      cwd: checkout,
      env: {
        ...process.env,
        ...(uid === undefined ? {} : { UID: String(uid) }),
        ...(gid === undefined ? {} : { GID: String(gid) }),
      },
      stdio: ['ignore', log.fd, log.fd],
    })
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
async function recreatedContainerId(
  ctx: OpContext,
  deadline: number,
  retry = true,
): Promise<string | undefined> {
  for (;;) {
    try {
      const id = (
        await docker(
          ctx,
          ['inspect', '--type', 'container', '--format', '{{.Id}}', ctx.container],
          'head',
          // Parsed: a warning on stderr must not become part of the id it is used as.
          { stdoutOnly: true },
        )
      ).trim()
      if (id !== '') {
        return id
      }
    } catch {
      // Not there yet, or not there at all; the deadline decides which.
    }
    if (!retry || Date.now() >= deadline) {
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
  // Compose failing means nothing new is coming: one look for a container it did create, not a
  // window spent waiting for one it never will; the deploy lock is held for all of this.
  const id = await recreatedContainerId(ctx, deadline, composeExit === 0)
  const state = id === undefined ? undefined : await waitForState(ctx, id, deadline)
  const image = state?.image === '' ? undefined : state?.image
  // Compose exiting 0 and a healthy container is the success condition; `id === before` is not a
  // failure, because a profile-only change (or re-shipping an unchanged main) leaves a bind-mounted
  // container alone and compose says "Running" — the container it left behind is the one to report.
  if (composeExit === 0 && state?.ok === true) {
    if (options.expectImage !== undefined && image !== options.expectImage) {
      // Healthy, but not the image the tag was supposed to put in front of us: the tag did not take
      // effect (the compose file starts something else), and "is up" would hide that.
      await note(
        `${ctx.container} is up (${state.text}) but runs ${image ?? 'an image docker could not name'}, not ${options.expectImage}`,
      )
      return
    }
    const unchanged = id !== undefined && id === before
    await note(
      unchanged
        ? `compose left ${ctx.container} in place (the container is unchanged); it is up (${state.text})`
        : `${ctx.container} is up (${state.text})`,
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
  // A fresh budget: the wait above may have used the whole window, and a nominal inspect is what
  // decides whether a healthy rollback is a success.
  const targetId = (await imageId(ctx, previous, ctx.execTimeoutMs)) || previous
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

/** The image that carries node and pnpm for the build step, and the parent of :dev. */
const BUILD_BASE_IMAGE = 'devockr/idsh:base'
/** The container a dev build runs in: the base image itself, by the same tag. */
const BUILD_CONTAINER = BUILD_BASE_IMAGE
/** The values `target` accepts, shared by the schema and the parser. */
const BUILD_TARGETS = ['dev', 'base'] as const

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
/**
 * The local queries `gcb.update` runs: services, images, replicas, the running container and its
 * image, ps, inspect and the restore of a failed update.
 */
const GCB_QUERIES = 8
/**
 * The git reads around the pull — the optional status check, the ssh-config query and the commit —
 * at the default deadline.
 */
const GCB_PRELUDE_STEPS = 3
/**
 * The steps that may take the build budget: the image build, the optional client build and the
 * recreate (the pull has its own bound). The client build is counted even when it is not
 * configured, because the operation's deadline is fixed at registration and a smaller cap would
 * turn a slow configured client build into a timeout halfway through.
 */
const GCB_BUILD_STEPS = 3

/** What `gcb host status` said about the daemon this deployment runs. */
type HostStatusResult =
  | { config: string }
  | { reason: 'no-pid' }
  | { reason: 'failed'; message: string }
  | { reason: 'not-ours'; pid: number }
  | { reason: 'no-entry'; pid: number; pids: number[] }
  | { reason: 'null'; pid: number }

/**
 * What the host daemon reports about its configuration, with the reason it could not answer kept
 * distinct: a missing pid, a failed command, an entry for another pid, a null config and a path are
 * five different situations and get five different answers.
 */
async function reportedConfig(
  ctx: OpContext,
  cli: string,
  deployDir: string,
): Promise<HostStatusResult> {
  const pidText = await readFile(path.join(deployDir, 'gcb-host.pid'), 'utf8').catch(() => '')
  const pid = Number(pidText.trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    return { reason: 'no-pid' }
  }
  if (!(await ownsDeployment(deployDir, pid))) {
    return { reason: 'not-ours', pid }
  }
  let entries: { pid?: unknown; config?: unknown }[]
  try {
    const output = await runFixed(
      ctx,
      process.execPath,
      ['--conditions=development', cli, 'host', 'status'],
      { timeoutMs: GCB_QUERY_TIMEOUT_MS },
    )
    const parsed: unknown = JSON.parse(output)
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    entries = candidates.filter(
      (entry): entry is { pid?: unknown; config?: unknown } =>
        typeof entry === 'object' && entry !== null,
    )
  } catch (error) {
    return { reason: 'failed', message: messageOf(error) }
  }
  const match = entries.find(entry => entry.pid === pid)
  if (match === undefined) {
    return {
      reason: 'no-entry',
      pid,
      pids: entries.flatMap(entry => (typeof entry.pid === 'number' ? [entry.pid] : [])),
    }
  }
  return typeof match.config === 'string' && match.config !== ''
    ? { config: match.config }
    : { reason: 'null', pid }
}

/** Add or remove one allowlist entry through the staged gcb host CLI, which owns the file. */
async function editAllowlist(
  ctx: OpContext,
  action: 'add' | 'remove',
  host: string,
  repo: string,
): Promise<string> {
  const deployDir = await hostDeployDir(ctx, 'gcb.allow')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  const staged = await stat(cli).catch(() => null)
  if (staged === null || !staged.isFile()) {
    throw new BrokerFault(
      'unavailable',
      `gcb.allow: ${cli} is not staged; start the broker with --gcb-host and --gcb-checkout, then run gcb.update (target host, or both)`,
    )
  }
  const reported = await reportedConfig(ctx, cli, deployDir)
  if (!('config' in reported)) {
    const message =
      reported.reason === 'no-pid'
        ? 'gcb-host.pid is missing or does not name a pid; start the host daemon (gcb.update --gcb-host)'
        : reported.reason === 'failed'
          ? `gcb host status failed: ${reported.message}`
          : reported.reason === 'not-ours'
            ? `pid ${String(reported.pid)} does not run from this deployment; is gcb-host.pid stale?`
            : reported.reason === 'no-entry'
              ? `gcb host status has no entry for pid ${String(reported.pid)} (it reports ${reported.pids.length === 0 ? 'none' : reported.pids.join(', ')}); is gcb-host.pid stale?`
              : `gcb host status reports no configuration for pid ${String(reported.pid)}; is the host daemon running?`
    throw new BrokerFault('unavailable', `gcb.allow: ${message}`)
  }
  const config = reported.config
  const configured = await stat(config).catch(() => null)
  if (configured === null || !configured.isFile()) {
    throw new BrokerFault('unavailable', `gcb.allow: ${config} is not there`)
  }
  // The staged tree is source, not built output: the development condition is what makes its
  // package exports resolve, the same way the host broker itself is started.
  try {
    await runFixed(
      ctx,
      process.execPath,
      ['--conditions=development', cli, 'config', 'allow', action, host, repo, '--config', config],
      { timeoutMs: GCB_QUERY_TIMEOUT_MS },
    )
  } catch (error) {
    throw new BrokerFault(
      error instanceof BrokerFault ? error.code : 'unavailable',
      `gcb.allow: ${action} failed: ${messageOf(error)}`,
    )
  }
  return `${action === 'add' ? 'allowed' : 'removed'} ${host}/${repo}; the daemon reloads when the file is replaced`
}

/**
 * Pull the credential broker's checkout, rebuild its container image and pin the host half.
 *
 * Not named `deploy.*`: those mean this deployment, and their log and status would become ambiguous
 * the moment a second deployment shares the namespace. Every step is the answer, so a failure says
 * which one it was; the container's own state is the last word, because a build that cannot start
 * is not a successful update.
 */
/**
 * Put the built client where dsh resolves it: <state>/cache/gcb-client/<version>, a `current`
 * symlink, and <state>/bin/gcb. Best effort: a failure must not fail the sidecar update.
 */
async function stageClient(
  ctx: OpContext,
  image: string,
): Promise<{ current: string; bin: string; previous: string | undefined; version: string }> {
  const mount = (
    await docker(
      ctx,
      [
        'inspect',
        '--type',
        'container',
        '--format',
        '{{range .Mounts}}{{if eq .Destination "/home/app/.dsh"}}{{.Source}}{{end}}{{end}}',
        ctx.container,
      ],
      'head',
      { stdoutOnly: true, timeoutMs: GCB_QUERY_TIMEOUT_MS },
    )
  ).trim()
  if (mount === '') {
    throw new BrokerFault('unavailable', 'the deployment has no /home/app/.dsh mount to stage into')
  }
  const version = (
    await docker(ctx, ['run', '--rm', '--entrypoint', 'gcb', image, '--version'], 'head', {
      stdoutOnly: true,
      timeoutMs: GCB_QUERY_TIMEOUT_MS,
    })
  ).trim()
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new BrokerFault('unavailable', 'the client image did not report a version')
  }
  const imageId = (
    await docker(ctx, ['image', 'inspect', '--format', '{{.Id}}', image], 'head', {
      stdoutOnly: true,
      timeoutMs: GCB_QUERY_TIMEOUT_MS,
    })
  ).trim()
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) {
    throw new BrokerFault('unavailable', 'the client image has no usable id')
  }
  // A dev rebuild keeps the package version but changes the image id; key the immutable tree by
  // both, or the second build would be dropped as "already published".
  const identity = `${version}-${imageId.slice('sha256:'.length, 'sha256:'.length + 12)}`
  const root = path.join(mount, 'cache', 'gcb-client')
  await mkdir(root, { recursive: true })
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  const stagedName = `.stage-${String(process.pid)}`
  const staged = path.join(root, stagedName)
  const containerStaged = `/out/${stagedName}`
  await rm(staged, { recursive: true, force: true })
  // Fixed shell text: the only interpolation is the version matched above and the numeric pid.
  // Run as the deployment user so the staged tree belongs to it.
  const script = [
    'set -e',
    `mkdir -p "${containerStaged}/lib/node_modules" "${containerStaged}/bin"`,
    `cp -a /usr/local/lib/node_modules/gcb-client /usr/local/lib/node_modules/gcb-core "${containerStaged}/lib/node_modules/"`,
    `ln -sf ../lib/node_modules/gcb-client/bin/gcb.js "${containerStaged}/bin/gcb"`,
    `chmod +x "${containerStaged}/bin/gcb"`,
  ].join('\n')
  await docker(
    ctx,
    [
      'run',
      '--rm',
      '--user',
      `${String(uid)}:${String(gid)}`,
      '-v',
      `${root}:/out`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      script,
    ],
    'tail',
    { timeoutMs: BUILD_TIMEOUT_MS },
  )
  // Publish only a completed directory; an already published version is never overwritten.
  const versionDir = path.join(root, identity)
  try {
    await rename(staged, versionDir)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' ||
      (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
    ) {
      await rm(staged, { recursive: true, force: true })
    } else {
      throw error
    }
  }
  // The executable link first: if this fails, current still names the old client.
  const bin = path.join(mount, 'bin')
  await mkdir(bin, { recursive: true })
  const link = path.join(bin, 'gcb')
  const tmp = path.join(bin, `gcb.${String(process.pid)}.tmp`)
  await symlink('../cache/gcb-client/current/bin/gcb', tmp)
  await rename(tmp, link)
  // Only now publish: the directory and its executable are ready.
  const current = path.join(root, 'current')
  const previous = await readlink(current).catch(() => undefined)
  const next = path.join(root, `current.${String(process.pid)}.tmp`)
  await symlink(identity, next)
  await rename(next, current)
  return { current, bin: link, previous, version }
}

/** Put the client publication back the way it was; best effort, its outcome rides on the failure. */
async function restoreClient(staged: Awaited<ReturnType<typeof stageClient>>): Promise<string> {
  try {
    if (staged.previous === undefined) {
      await rm(staged.current, { force: true })
      await rm(staged.bin, { force: true })
      return 'the staged client was removed again'
    }
    const next = `${staged.current}.${String(process.pid)}.tmp`
    await symlink(staged.previous, next)
    await rename(next, staged.current)
    return `the staged client was restored to ${staged.previous}`
  } catch (error) {
    return `the staged client could not be restored: ${messageOf(error)}`
  }
}

async function updateBroker(
  ctx: OpContext,
  target: 'both' | 'container' | 'host',
): Promise<string> {
  const checkout = ctx.gcbCheckout
  const composeFiles = ctx.gcbCompose
  const repo = ctx.gcbProbeRepo
  const service = ctx.gcbService
  const containerConfigured = composeFiles !== undefined && repo !== undefined
  const hostConfigured = ctx.gcbHostUpdate === true
  if (target === 'container' && !containerConfigured) {
    throw new BrokerFault(
      'unavailable',
      'gcb.update: the container half is not configured: start the broker with --gcb-compose and --gcb-probe-repo',
    )
  }
  if (target === 'host' && !hostConfigured) {
    throw new BrokerFault(
      'unavailable',
      'gcb.update: the host half is not configured: start the broker with --gcb-host',
    )
  }
  const containerUpdate = containerConfigured && target !== 'host'
  const hostUpdate = hostConfigured && target !== 'container'
  if (checkout === undefined || (!containerUpdate && !hostUpdate)) {
    throw new BrokerFault(
      'unavailable',
      'gcb.update needs --gcb-checkout, and either the broker container (--gcb-compose with --gcb-probe-repo) or the host broker (--gcb-host)',
    )
  }
  // One prefix for every `compose` call: a deployment that renders a base file plus an overlay is
  // the same set of files everywhere here. Compose interpolates UID and GID, and the broker's own
  // environment may not carry them.
  const composeArgs = ['compose', ...(composeFiles ?? []).flatMap(file => ['-f', file])]
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
  // A broker may inherit GIT_DIR/GIT_WORK_TREE from whatever started it, and `-C` does not override
  // them: the pull would then act on another repository while the build uses this checkout. Every
  // git call here clears only the repository location; transport settings stay inherited.
  // `undefined` removes the keys: an empty GIT_DIR is a path, not "unset", and git fails on it.
  const isolatedGitEnv: NodeJS.ProcessEnv = {
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
  }
  // Fail before the one network step. A dirty checkout would otherwise be pulled into before the
  // refusal — and every target builds or pins the commit it reports, so none of them may read a
  // working tree that is not that commit. A missing host directory would pay for the pull first;
  // the directory resolved here is the one the pin writes to, so the check and the write agree.
  const dirty = (
    await git(
      ctx,
      ['status', '--porcelain'],
      { stdoutOnly: true, env: isolatedGitEnv },
      checkout,
    ).catch((error: unknown) => {
      // Before the pull there is no completed step to blame; name the check itself.
      throw new BrokerFault(
        error instanceof BrokerFault ? error.code : 'unavailable',
        `gcb.update: reading the checkout status failed: ${messageOf(error)}`,
      )
    })
  ).trim()
  if (dirty !== '') {
    throw new BrokerFault(
      'unavailable',
      'gcb.update: the checkout has local changes; commit or stash them, so the image and the pin name the commit that was built',
    )
  }
  const deployDir = hostUpdate ? await hostDeployDir(ctx) : ''
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      const message = messageOf(error)
      // A pin that already moved is the one state a late failure leaves behind, and re-running is
      // what converges it; saying so beats implying both halves are still where they were.
      const diverged = hostUpdate && done.some(line => line.startsWith('host: '))
      const failure =
        withCompleted(`gcb.update: ${name} failed: ${message}`, done) +
        (diverged
          ? '; the host half is already on the new commit — re-run gcb.update to converge both'
          : '')
      throw new BrokerFault(error instanceof BrokerFault ? error.code : 'unavailable', failure)
    }
  }
  // The one network step, and the only one that needs a bound: git decides ssh or HTTPS, and the
  // proxy, from the remote the checkout already has — this operation does not rewrite it. Prompts
  // are off because nobody is at a terminal; a network that answers nothing fails at the bound
  // rather than holding the request open.
  const pullEnv: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', ...isolatedGitEnv }
  // ssh can still ask on /dev/tty (passphrase, host key), so it is made non-interactive — but only
  // when the operator has not chosen an ssh command: core.sshCommand and GIT_SSH_COMMAND win,
  // because that is where a ProxyCommand or a key selection lives. ~/.ssh/config is read either way.
  if (process.env['GIT_SSH_COMMAND'] === undefined) {
    const configured = (
      await git(
        ctx,
        ['config', '--get', 'core.sshCommand'],
        { stdoutOnly: true, env: isolatedGitEnv },
        checkout,
      ).catch((error: unknown) => {
        // `git config --get` exits 1 for a key that is not set; anything else — a timeout, a
        // broken configuration — is a real failure and must not read as "nothing configured".
        if (error instanceof BrokerFault && error.exitCode === 1) {
          return ''
        }
        throw new BrokerFault(
          error instanceof BrokerFault ? error.code : 'unavailable',
          `gcb.update: reading the ssh configuration failed: ${messageOf(error)}`,
        )
      })
    ).trim()
    if (configured === '' && process.env['GIT_SSH'] === undefined) {
      pullEnv['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes -o ConnectTimeout=10'
    }
  }
  // The checkout is a build input, not a branch someone works on: fetch the remote and detach at
  // its tip. A checkout left on a deleted feature branch (or any other branch) then still updates,
  // where `pull --ff-only` would refuse to name a merge ref that no longer exists.
  const fetched = linesOf(
    await step('fetch', () =>
      git(
        ctx,
        ['fetch', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        { stdoutOnly: true, timeoutMs: GCB_PULL_TIMEOUT_MS, env: pullEnv },
        checkout,
      ),
    ),
  )
  await step('checkout', () =>
    git(
      ctx,
      ['checkout', '--detach', '--quiet', '--no-overwrite-ignore', 'refs/remotes/origin/main'],
      { stdoutOnly: true, env: pullEnv },
      checkout,
    ),
  )
  done.push(`fetch: origin/main${fetched.length === 0 ? '' : ' (fetched)'}`)
  const sha = (
    await step('read the commit', () =>
      git(ctx, ['rev-parse', 'HEAD'], { stdoutOnly: true, env: isolatedGitEnv }, checkout),
    )
  ).trim()
  if (!COMMIT_ID.test(sha)) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(`gcb.update: ${JSON.stringify(sha)} is not a commit id`, done),
    )
  }
  done.push(`commit: ${sha.slice(0, 12)}`)
  if (!containerUpdate) {
    if (hostUpdate) {
      done.push(
        `host: ${await step('pin the host broker', () => pinHostBroker(ctx, deployDir, sha))}`,
      )
    }
    // Configured and deliberately skipped is a different answer from not configured at all.
    done.push(
      containerConfigured ? 'container: skipped (target host)' : 'container: not configured',
    )
    return done.join('; ')
  }
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
  // Two builds sharing a tag means the client build overwrites the daemon image the recreate then
  // runs: the service would start the client target where it expects the daemon.
  const clientImage = ctx.gcbClientImage
  if (clientImage !== undefined && canonicalImage(clientImage) === canonicalImage(image)) {
    throw new BrokerFault(
      'unavailable',
      withCompleted(
        `the client image (${JSON.stringify(clientImage)}) and the broker image (${JSON.stringify(image)}) name the same image; the client build would replace the image the service runs`,
        done,
      ),
    )
  }
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
  if (hostConfigured && !hostUpdate) {
    done.push('host: skipped (target container)')
  }
  // The image the service currently runs: a failure after the daemon build must not leave the tag
  // pointing at an image no recreate ever verified.
  const running = linesOf(
    await step('read the running container', () => compose(['ps', '-q', service])),
  )
  let previousImage: string | undefined
  if (running.length === 1) {
    previousImage = (
      await step('read the running image', () =>
        docker(ctx, ['inspect', '--format', '{{.Image}}', running[0]], 'head', {
          stdoutOnly: true,
          timeoutMs: GCB_QUERY_TIMEOUT_MS,
        }),
      )
    ).trim()
  }
  // The client image is built from the same commit: a deployment whose container bakes the client
  // (idsh's dev image) would otherwise keep the old one after the daemon moves. It goes before the
  // daemon image so a client failure cannot leave the tag the service runs replaced — and before
  // the pin, for the same reason the daemon build is.
  let stagedClient: Awaited<ReturnType<typeof stageClient>> | undefined
  if (clientImage !== undefined) {
    await step('build the client', () =>
      docker(ctx, ['build', '--target', 'client', '-t', clientImage, '.'], 'tail', {
        cwd: checkout,
        timeoutMs: BUILD_TIMEOUT_MS,
      }),
    )
    done.push(`client: ${clientImage}`)
    try {
      stagedClient = await stageClient(ctx, clientImage)
      done.push(`client-bin: ${stagedClient.version}`)
    } catch (error) {
      done.push(`client-bin: failed — ${messageOf(error)}`)
    }
  }
  // The pin comes after a successful build: a build that fails must leave the host broker on the
  // commit it was running, or the two halves diverge in the very state this operation prevents.
  try {
    await step('build', () =>
      docker(ctx, ['build', '--target', 'host', '-t', image, '.'], 'tail', {
        cwd: checkout,
        timeoutMs: BUILD_TIMEOUT_MS,
      }),
    )
    done.push('build: ok')
    if (hostUpdate) {
      done.push(
        `host: ${await step('pin the host broker', () => pinHostBroker(ctx, deployDir, sha))}`,
      )
    }
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
    // Probe the client dsh actually resolves: the absolute staged path when the state has one,
    // otherwise the baked client. `docker exec` does not inherit the entrypoint's PATH, so ask the
    // container which path exists rather than trusting the staging result of this call (an older
    // staged client can already be published).
    const stagedBin = '/home/app/.dsh/bin/gcb'
    const hasStaged = await docker(ctx, ['exec', ctx.container, 'test', '-x', stagedBin], 'head', {
      timeoutMs: GCB_QUERY_TIMEOUT_MS,
    }).then(
      () => true,
      (error: unknown) => {
        // `test` exits 1 when the path is absent; anything else (a timeout, a dead docker) is a
        // failure to answer, not an answer of "no staged client".
        if (/(?:^|\s)exited with 1(?:\s|$)/u.test(messageOf(error))) {
          return false
        }
        throw error
      },
    )
    const client = hasStaged ? stagedBin : 'gcb'
    await step('probe', () =>
      docker(ctx, ['exec', ctx.container, client, 'probe', '--repo', repo], 'head', {
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    )
    done.push(`probe: ${repo} allowed via ${client}`)
    return done.join('; ')
  } catch (error) {
    const clientNote = stagedClient === undefined ? '' : `${await restoreClient(stagedClient)}; `
    const restoreNote =
      previousImage === undefined || previousImage === ''
        ? 'no running image was recorded, so the tag was not restored'
        : await restoreTag(ctx, previousImage, image)
    // A timed-out request already has its answer, so the restore outcome has no answer to ride on:
    // it goes to the broker's stderr (its log), or an unsuccessful recovery would be silent.
    if (ctx.signal?.aborted === true) {
      process.stderr.write(`gcb.update: request timed out; ${clientNote}${restoreNote}\n`)
    }
    const failure =
      error instanceof BrokerFault ? error : new BrokerFault('unavailable', messageOf(error))
    throw new BrokerFault(failure.code, `${failure.message}; ${clientNote}${restoreNote}`)
  }
}

/* ---------------------------------------------------------- gcb.authorize */

/**
 * Authorize the credential broker as a person, on the host.
 *
 * Gcb-host 0.9.0 serializes this write with the daemon's own renewal through `user.refresh.lock`,
 * so a running sidecar needs no stop; the lock directory must be mounted with the token. The
 * device-flow code and the completion go to the same per-call log a build uses, so a job can follow
 * it: the code is useful before the command returns, which a single request/answer cannot carry.
 * The token itself is never read here; gcb writes it beside the configuration.
 */
async function authorizeBroker(ctx: OpContext, logId: string | undefined): Promise<string> {
  const deployDir = await hostDeployDir(ctx, 'gcb.authorize')
  const config = path.join(deployDir, 'config', 'broker.config.yml')
  const configured = await stat(config).catch(() => null)
  if (configured === null || !configured.isFile()) {
    throw new BrokerFault('unavailable', `gcb.authorize: ${config} is not there`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && configured.uid !== uid) {
    throw new BrokerFault(
      'unavailable',
      `gcb.authorize: ${config} is owned by uid ${String(configured.uid)}, not ${String(uid)}; chown the config and token to the deployment user first`,
    )
  }
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  const staged = await stat(cli).catch(() => null)
  if (staged === null || !staged.isFile()) {
    throw new BrokerFault(
      'unavailable',
      `gcb.authorize: ${cli} is not staged; run gcb.update (target host, or both) first`,
    )
  }
  const lockModule = await stat(
    path.join(deployDir, 'app', 'packages', 'host', 'src', 'token-lock.ts'),
  ).catch(() => null)
  if (lockModule === null || !lockModule.isFile()) {
    throw new BrokerFault(
      'unavailable',
      'gcb.authorize: the staged gcb-host has no token lock; run gcb.update (target host, or both)',
    )
  }
  const lock = path.join(deployDir, 'user.refresh.lock')
  const lockState = await stat(lock).catch(() => null)
  if (lockState === null || !lockState.isDirectory()) {
    throw new BrokerFault(
      'unavailable',
      `gcb.authorize: ${lock} is missing or not a directory; create it with mkdir -p and mount it with user.refresh (see docker-compose.broker.yml)`,
    )
  }
  if (uid !== undefined && lockState.uid !== uid) {
    throw new BrokerFault(
      'unavailable',
      `gcb.authorize: ${lock} is owned by uid ${String(lockState.uid)}, not ${String(uid)}; chown it to the deployment user`,
    )
  }
  const logPath = path.join(ctx.stateDir, logId === undefined ? 'build.log' : `build-${logId}.log`)
  const log = await openAppendLog(logPath)
  try {
    await log.chmod(FILE_MODE)
    await log.write('authorize: starting the device flow\n')
  } finally {
    await log.close()
  }
  if (ctx.signal?.aborted === true) {
    throw new BrokerFault('unavailable', 'gcb.authorize: the request was cancelled')
  }
  const target = path.join(deployDir, 'user.refresh')
  try {
    await runFixed(
      ctx,
      process.execPath,
      [
        '--conditions=development',
        cli,
        'authorize',
        '--broker-container',
        '--config',
        config,
        '--to',
        target,
      ],
      { cwd: deployDir, logPath, timeoutMs: AUTHORIZE_TIMEOUT_MS },
    )
  } catch (error) {
    // Keep the runner's code (a timeout is not "unavailable") and point at the log, so a
    // deployment without the job registry still knows where the device-flow code went.
    throw new BrokerFault(
      error instanceof BrokerFault ? error.code : 'unavailable',
      `gcb.authorize: ${messageOf(error)}; see ${logPath}`,
    )
  }
  return `authorized the credential broker; the device-flow code is in ${logPath}`
}

/* ------------------------------------------------------------------ gcb.update (host half) */

/**
 * `$HOME/.broker-host`, resolved where it is used: a broker that never updates must start without
 * it.
 */
function defaultDeployDir(): string {
  try {
    return path.join(homedir(), '.broker-host')
  } catch {
    throw new BrokerFault('unavailable', 'gcb.update: no HOME to find the host broker under')
  }
}

/**
 * The canonical reference Docker would resolve: an omitted tag is `latest`, an omitted registry is
 * `docker.io`, and a bare name lives under `library/`. Two spellings that resolve to the same
 * reference name the same image — which is what a tag collision between two builds has to catch.
 */
function canonicalImage(reference: string): string {
  if (reference.includes('@')) {
    return reference
  }
  // The tag is decided before the registry: a single-component name may carry one too.
  const slash = reference.lastIndexOf('/')
  const colon = reference.lastIndexOf(':')
  const hasTag = colon > slash
  const name = hasTag ? reference.slice(0, colon) : reference
  const tag = hasTag ? reference.slice(colon) : ':latest'
  const parts = name.split('/')
  const first = parts[0]
  const hasRegistry =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')
  const registry = hasRegistry ? (first === 'index.docker.io' ? 'docker.io' : first) : 'docker.io'
  const rest = hasRegistry ? parts.slice(1) : parts
  // `library/` is Docker Hub's rule only: `ghcr.io/x` and `ghcr.io/library/x` are different.
  if (registry === 'docker.io' && rest.length === 1) {
    rest.unshift('library')
  }
  return `${registry}/${rest.join('/')}${tag}`
}

/** A hostname as gcb records it. */
const GCB_HOST_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u
/** One exact `owner/name` entry, which is what the allowlist holds. */
const GCB_REPO_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/u

/** A commit id, which is all `app.ref` may hold. */
const COMMIT_ID = /^[0-9a-f]{40}$/u

/** The host broker's directory, checked once so a missing one is named before any work starts. */
async function hostDeployDir(ctx: OpContext, op = 'gcb.update'): Promise<string> {
  const deployDir = ctx.gcbDeployDir ?? defaultDeployDir()
  const stats = await stat(deployDir).catch(() => null)
  if (stats === null || !stats.isDirectory()) {
    throw new BrokerFault(
      'unavailable',
      `${op}: ${deployDir} is not a directory; set --gcb-deploy-dir to the host broker's directory`,
    )
  }
  return deployDir
}

/**
 * Move the host-side gcb broker to a commit and wait until it runs it.
 *
 * The host broker is started by a supervisor that re-stages `~/.broker-host/app` from the commit in
 * `app.ref` whenever it starts, so an update is: write the pin, stop the process, and let the
 * supervisor restart it. This does exactly that, and waits for the restarted process and the staged
 * commit, because "the pin moved" is not "the broker runs it".
 */
/**
 * Whether a pid is this deployment's gcb host: its command line mentions gcb and names the
 * deployment (or a path inside it), or its working directory is inside the deployment. A pid file
 * survives a crash and a pid can be recycled, so a matching number alone is not ownership.
 */
async function ownsDeployment(deployDir: string, pid: number): Promise<boolean> {
  const deployment = path.resolve(deployDir)
  const realDeployment = await realpath(deployment).catch(() => deployment)
  const cmdline = await readFile(`/proc/${String(pid)}/cmdline`, 'utf8').catch(() => '')
  if (!/gcb/u.test(cmdline)) {
    return false
  }
  const namesDeployment = async (arg: string): Promise<boolean> => {
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg
    if (!value.startsWith('/')) {
      return false
    }
    for (let current = value; ; current = path.dirname(current)) {
      if ((await realpath(current).catch(() => current)) === realDeployment) {
        return true
      }
      if (current === path.dirname(current)) {
        return false
      }
    }
  }
  for (const arg of cmdline.split('\0')) {
    if (await namesDeployment(arg)) {
      return true
    }
  }
  const cwd = await readlink(`/proc/${String(pid)}/cwd`).catch(() => '')
  if (cwd === '') {
    return false
  }
  const realCwd = await realpath(cwd).catch(() => cwd)
  return realCwd === realDeployment || realCwd.startsWith(`${realDeployment}/`)
}

async function pinHostBroker(ctx: OpContext, deployDir: string, sha: string): Promise<string> {
  const pinFile = path.join(deployDir, 'app.ref')
  const pidFile = path.join(deployDir, 'gcb-host.pid')
  const stagedFile = path.join(deployDir, 'app', 'STAGED.json')

  const readPid = async (): Promise<number | undefined> => {
    const text = await readFile(pidFile, 'utf8').catch(() => '')
    const pid = Number(text.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  }
  const alive = (pid: number | undefined): boolean => {
    if (pid === undefined) {
      return false
    }
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // Only a confirmed absence is "not running": EPERM means the pid exists under another user,
      // and treating that as gone would let the pin move past a broker the operation cannot check.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return false
      }
      throw new BrokerFault(
        'unavailable',
        `gcb.update: cannot check pid ${String(pid)}: ${messageOf(error)}`,
      )
    }
  }
  const stagedSha = async (): Promise<string | undefined> => {
    const text = await readFile(stagedFile, 'utf8').catch(() => '')
    try {
      const parsed = JSON.parse(text) as { sha?: unknown }
      return typeof parsed.sha === 'string' ? parsed.sha : undefined
    } catch {
      return undefined
    }
  }

  const before = await readPid()
  // Asked once: the answer decides both the refusal below and the signal after the pin, and a
  // second probe after the pin could fail for a reason that no longer has an untouched state.
  const wasRunning = before !== undefined && alive(before)
  // A pid file survives a crash, and a recycled pid belongs to somebody else: check it before the
  // pin moves, so the refusal is the whole effect of a stale file.
  if (wasRunning && before !== undefined && !(await ownsDeployment(deployDir, before))) {
    throw new BrokerFault(
      'unavailable',
      `gcb.update: refusing to stop ${String(before)}: it does not run from ${path.resolve(deployDir)}`,
    )
  }
  await writeFile(`${pinFile}.${String(process.pid)}.tmp`, `${sha}\n`, { mode: FILE_MODE })
  await rename(`${pinFile}.${String(process.pid)}.tmp`, pinFile)
  if (wasRunning && before !== undefined) {
    try {
      process.kill(before, 'SIGTERM')
    } catch {
      // It exited between the check and the signal, which is the outcome the signal wanted.
    }
  }

  const deadline = Date.now() + GCB_HOST_WAIT_MS
  const pinned = `app.ref is pinned to ${sha.slice(0, 12)}`
  try {
    for (;;) {
      const pid = await readPid()
      if (pid !== before && alive(pid) && (await stagedSha()) === sha) {
        return `pinned ${sha.slice(0, 12)}; host broker ${String(pid)} (was ${before === undefined ? 'not running' : String(before)})`
      }
      if (Date.now() >= deadline) {
        throw new BrokerFault(
          'unavailable',
          `the host broker did not stage it within ${String(GCB_HOST_WAIT_MS / 1000)}s; check ${path.join(deployDir, 'gcb-host.log')}`,
        )
      }
      if (ctx.signal?.aborted === true) {
        throw new BrokerFault('timeout', 'gcb.update: cancelled while waiting for the host broker')
      }
      // Clamped: a poll that sleeps past the deadline would let the request's own timeout win, and
      // that answer is the one without the log path.
      await new Promise(resolve =>
        setTimeout(resolve, Math.max(0, Math.min(GCB_HOST_POLL_MS, deadline - Date.now()))),
      )
    }
  } catch (error) {
    // The pin is the effect that survives whatever went wrong next; an answer without it would
    // leave the operator thinking nothing changed.
    const message = messageOf(error)
    throw new BrokerFault(
      error instanceof BrokerFault ? error.code : 'unavailable',
      `${message}; ${pinned}, but the host broker has not confirmed it; re-run gcb.update to converge both`,
    )
  }
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
      'What the deployment is running — its state and image, the dsh, gcb client, sidecar and staged host versions.',
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
      // The sidecar and the staged host app can be a release apart; name the staged version
      // beside the client probe so one number is not read as the other.
      let staged: string | undefined
      try {
        const dir = ctx.gcbDeployDir ?? defaultDeployDir()
        const manifest = JSON.parse(
          await readFile(path.join(dir, 'app', 'packages', 'host', 'package.json'), 'utf8'),
        ) as { version?: unknown }
        if (typeof manifest.version === 'string' && /^\S{1,64}$/u.test(manifest.version)) {
          staged = manifest.version
        }
      } catch {
        staged = undefined
      }
      // The sidecar is the other half: ask the container that compose runs, not the staged tree.
      if (ctx.gcbCompose !== undefined && ctx.gcbCheckout !== undefined) {
        try {
          const uid = process.getuid?.()
          const gid = process.getgid?.()
          const compose = ['compose', ...ctx.gcbCompose.flatMap(file => ['-f', file])]
          const env: NodeJS.ProcessEnv = {
            ...(uid === undefined ? {} : { UID: String(uid) }),
            ...(gid === undefined ? {} : { GID: String(gid) }),
          }
          const container = (
            await docker(ctx, [...compose, 'ps', '-q', ctx.gcbService], 'head', {
              cwd: ctx.gcbCheckout,
              stdoutOnly: true,
              env,
              timeoutMs: budget(),
            })
          )
            .trim()
            .split('\n')[0]
          if (container === '') {
            probes.push('gcb-host: unavailable — no container')
          } else {
            const version = await docker(ctx, ['exec', container, 'gcb', '--version'], 'head', {
              stdoutOnly: true,
              timeoutMs: budget(),
            })
            probes.push(`gcb-host: ${version.trim()}`)
          }
        } catch (error) {
          const message = messageOf(error).trim()
          const last = message.split('\n').at(-1) ?? message
          probes.push(`gcb-host: unavailable — ${last}`)
        }
      }
      return [
        `${ctx.container}: ${state.trim()}`,
        ...probes,
        ...(staged === undefined ? [] : [`gcb-staged: ${staged}`]),
      ].join('\n')
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
        target: {
          type: 'string',
          enum: BUILD_TARGETS,
          description: 'The build target the preview is for.',
        },
      },
      additionalProperties: false,
    },
    // git resolves refs in a second or two, but a slow origin is a build's problem, not a read's.
    timeoutMs: BUILD_TIMEOUT_MS,
    async run(args, ctx) {
      rejectUnknown(args, ['pr', 'sha', 'for', 'log', 'target'])
      // The whole request is checked here, not only the part this resolves: an argument the build
      // would refuse must not reach the person as a question they cannot answer usefully.
      optionalLog(args)
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      // `deploy.main` builds main; a pinned sha is allowed, a PR is not.
      if (args['for'] === 'deploy.main') {
        if (args['pr'] !== undefined) {
          throw new BrokerFault(
            'bad-argument',
            'deploy.main resolves main; give pr to deploy.build instead',
          )
        }
        const pin = args['sha']
        if (pin !== undefined && (typeof pin !== 'string' || !COMMIT_ID.test(pin))) {
          throw new BrokerFault('bad-argument', 'sha must be a full 40-character commit sha')
        }
        const main = await resolveMainSource(ctx, deadline)
        if (typeof pin === 'string' && pin !== main.sha) {
          throw new BrokerFault(
            'unavailable',
            'main moved since the pin was taken; preview again before building',
          )
        }
        rememberPin('deploy.main', args, main)
        return 'main'
      }
      // A base build takes no source: its root surface is main's, so a pr/sha would name an image
      // that does not contain it. The preview says main, exactly like a deploy.main preview.
      const target = args['target'] === undefined ? 'dev' : choice(args, 'target', BUILD_TARGETS)
      if (target === 'base') {
        if (args['pr'] !== undefined || args['sha'] !== undefined) {
          throw new BrokerFault('bad-argument', 'target base builds main; do not pass pr or sha')
        }
        const main = await resolveMainSource(ctx, deadline)
        rememberPin('deploy.build', args, main)
        return 'main (base build)'
      }
      // Anything else is `deploy.build`, which refuses a request without one of the two — the
      // preview refuses it too, so the person is never asked about a build that cannot start.
      const source = await resolveBuildSource(ctx, args, deadline)
      rememberPin('deploy.build', args, source)
      return `${source.label}; root files from main`
    },
  },
  {
    name: 'deploy.build',
    summary:
      "Build the :dev image from a PR head or origin branch tip, or rebuild main's base image; the root files stay at main.",
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
        target: {
          type: 'string',
          enum: BUILD_TARGETS,
          description:
            'dev (default) builds :dev from the source; base rebuilds devockr/idsh:base from main and takes no pr/sha.',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['pr', 'sha', 'log', 'target'])
      const log = optionalLog(args)
      const target = args['target'] === undefined ? 'dev' : choice(args, 'target', BUILD_TARGETS)
      if (target === 'base' && (args['pr'] !== undefined || args['sha'] !== undefined)) {
        throw new BrokerFault('bad-argument', 'target base builds main; do not pass pr or sha')
      }
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      // A base build's only inputs are main's root surface; the answer names what was built rather
      // than a source whose files are not in the image.
      const pin = takePin('deploy.build', args)
      if (pin.kind === 'expired') {
        throw new BrokerFault('unavailable', 'the preview expired; preview again before building')
      }
      const pinned = pin.kind === 'ok' ? pin.source : undefined
      const main =
        target === 'base' ? (pinned ?? (await resolveMainSource(ctx, deadline))) : undefined
      const source =
        pinned ??
        (main === undefined
          ? await resolveBuildSource(ctx, args, deadline)
          : { label: 'main', sha: main.sha, mainSha: main.sha })
      const mainSha = source.mainSha
      const { previous, failed } = await buildInto(ctx, source, deadline, log, target)
      return target === 'base'
        ? `built ${BUILD_BASE_IMAGE} from main ${source.sha}${reapNote(failed)}`
        : `built ${source.label} (${source.sha}) as ${BUILD_IMAGE}; main ${mainSha}; previous image ${previous ?? 'unknown'}` +
            reapNote(failed)
    },
  },
  {
    name: 'deploy.main',
    summary:
      'Build the tip of main as :dev, then recreate the container from it; pass the sha the preview showed to refuse a moved main.',
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
        sha: {
          type: 'string',
          description:
            'The main sha the preview showed; a main that has moved since is refused instead of built.',
        },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['log', 'sha'])
      const log = optionalLog(args)
      const pin = args['sha']
      if (pin !== undefined && (typeof pin !== 'string' || !/^[0-9a-f]{40}$/u.test(pin))) {
        throw new BrokerFault('bad-argument', 'sha must be a full 40-character commit sha')
      }
      const checkout = requireCheckout(ctx)
      const deadline = Date.now() + BUILD_TIMEOUT_MS
      const resolvedPin =
        typeof pin === 'string' ? { kind: 'none' as const } : takePin('deploy.main', args)
      if (resolvedPin.kind === 'expired') {
        throw new BrokerFault('unavailable', 'the preview expired; preview again before building')
      }
      const pinned = resolvedPin.kind === 'ok' ? resolvedPin.source : undefined
      const source = pinned ?? (await resolveMainSource(ctx, deadline))
      if (typeof pin === 'string' && pin !== source.sha) {
        throw new BrokerFault(
          'unavailable',
          'main moved since the preview; preview again before building',
        )
      }
      const { previous, failed } = await buildInto(ctx, source, deadline, log)
      const before = await existingContainerId(ctx)
      const expectImage = (await imageId(ctx, BUILD_IMAGE, ctx.execTimeoutMs)) || undefined
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
    name: 'gcb.allow',
    summary: 'Add or remove one credential-broker allowlist entry through the staged host CLI.',
    confirm: true,
    serial: true,
    // The staged tree and the configuration are the host-supervised deployment's; a broker without
    // that half has neither, so the operation is not offered.
    available: ctx => ctx.gcbHostUpdate === true,
    input: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        host: { type: 'string', description: 'Host as gcb records it; default github.com.' },
        repo: { type: 'string', description: 'The exact owner/name entry to change.' },
      },
      required: ['action', 'repo'],
      additionalProperties: false,
    },
    run(args, ctx) {
      rejectUnknown(args, ['action', 'host', 'repo'])
      const action = text(args, 'action', MAX_PATTERN_CHARS)
      if (action !== 'add' && action !== 'remove') {
        throw new BrokerFault('bad-argument', 'action must be add or remove')
      }
      const host = text(args, 'host', MAX_PATTERN_CHARS) ?? 'github.com'
      if (!GCB_HOST_ID.test(host)) {
        throw new BrokerFault(
          'bad-argument',
          `host must be a hostname, got ${JSON.stringify(host)}`,
        )
      }
      const repo = text(args, 'repo', MAX_PATTERN_CHARS) ?? ''
      if (!GCB_REPO_ID.test(repo)) {
        throw new BrokerFault('bad-argument', 'repo must be owner/name')
      }
      return editAllowlist(ctx, action, host, repo)
    },
  },

  {
    name: 'gcb.authorize',
    summary:
      'Authorize the credential broker as a person: run the device flow on the host and let gcb replace the token under its lock.',
    confirm: true,
    serial: true,
    // The child timer, plus room for the answer to be written after it fires.
    timeoutMs: AUTHORIZE_TIMEOUT_MS + AUTHORIZE_MARGIN_MS,
    // The staged tree is what the operation runs; the checkout is not required. Without this the
    // confirmation is asked before the broker can say the tree is missing.
    available: ctx => {
      try {
        const dir = ctx.gcbDeployDir ?? defaultDeployDir()
        return existsSync(path.join(dir, 'app', 'packages', 'host', 'bin', 'gcb.js'))
      } catch {
        return false
      }
    },
    input: {
      type: 'object',
      properties: {
        log: {
          type: 'string',
          pattern: '^[\\w-]{1,64}$',
          description: 'The log id a job follows; the broker picks one when omitted.',
        },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      rejectUnknown(args, ['log'])
      return authorizeBroker(ctx, optionalLog(args))
    },
  },
  {
    name: 'gcb.update',
    summary:
      'Update the credential broker from its checkout: rebuild and recreate its container, and pin the host-supervised broker to the same commit.',
    confirm: true,
    serial: true,
    // The operation's own deadline has to outlast every step it runs: a pull, a build and a
    // recreate at the build budget, the probe, and the four local queries, or a slow link turns a
    // working update into a timeout halfway through it.
    timeoutMs:
      GCB_BUILD_STEPS * BUILD_TIMEOUT_MS +
      PROBE_TIMEOUT_MS +
      GCB_QUERIES * GCB_QUERY_TIMEOUT_MS +
      GCB_PRELUDE_STEPS * GCB_QUERY_TIMEOUT_MS +
      GCB_PULL_TIMEOUT_MS +
      GCB_HOST_WAIT_MS,
    requires: ['gcbCheckout'],
    // One half has to be configured, or the call could only fail after a confirmation: the host
    // broker (`--gcb-host`) or the container (`--gcb-compose` with `--gcb-probe-repo`).
    available: ctx =>
      ctx.gcbHostUpdate === true ||
      (ctx.gcbCompose !== undefined && ctx.gcbProbeRepo !== undefined),
    input: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['both', 'container', 'host'],
          description:
            'Which half to update; default both. A half that is not configured is an error when named.',
        },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      rejectUnknown(args, ['target'])
      const target = text(args, 'target', MAX_PATTERN_CHARS) ?? 'both'
      if (target !== 'both' && target !== 'container' && target !== 'host') {
        throw new BrokerFault(
          'bad-argument',
          `target must be both, container or host, got ${JSON.stringify(target)}`,
        )
      }
      return updateBroker(ctx, target)
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
    op =>
      (op.requires === undefined || op.requires.every(key => context?.[key] !== undefined)) &&
      (op.available === undefined || context === undefined || op.available(context)),
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

/** How long a preview's resolution remains the commitment its build uses. */
const SOURCE_PIN_TTL_MS = 600_000

const SOURCE_PINS = new Map<string, BuildSource & { at: number }>()

function pinKey(op: 'deploy.build' | 'deploy.main', args: Record<string, unknown>): string {
  return JSON.stringify([
    op,
    args['pr'] ?? null,
    args['sha'] ?? null,
    op === 'deploy.main' ? 'dev' : (args['target'] ?? 'dev'),
  ])
}

function rememberPin(
  op: 'deploy.build' | 'deploy.main',
  args: Record<string, unknown>,
  source: BuildSource,
): void {
  SOURCE_PINS.set(pinKey(op, args), { ...source, at: Date.now() })
}

type PinResult = { kind: 'none' } | { kind: 'ok'; source: BuildSource } | { kind: 'expired' }

function takePin(op: 'deploy.build' | 'deploy.main', args: Record<string, unknown>): PinResult {
  const key = pinKey(op, args)
  const hit = SOURCE_PINS.get(key)
  if (hit === undefined) {
    return { kind: 'none' }
  }
  if (Date.now() - hit.at > SOURCE_PIN_TTL_MS) {
    // Keep the marker: otherwise the next build would silently resolve a new source. Only a new
    // preview replaces it.
    return { kind: 'expired' }
  }
  SOURCE_PINS.delete(key)
  return { kind: 'ok', source: hit }
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
    const branch = heads.find(entry => entry.sha === resolved)?.ref.replace(/^refs\/heads\//u, '')
    return {
      sha: resolved,
      mainSha: main,
      label: branch === undefined ? `PR #${String(pr)}` : `PR #${String(pr)} (${branch})`,
    }
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
  const branch = heads.find(entry => entry.sha === matches[0])?.ref.replace(/^refs\/heads\//u, '')
  return {
    sha: matches[0] ?? '',
    mainSha: main,
    label: branch === undefined ? 'an origin branch' : `branch ${branch}`,
  }
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
  target: 'dev' | 'base' = 'dev',
): Promise<{ previous?: string; failed: readonly string[] }> {
  const dir = await prepareBuildSource(ctx, source, deadline)
  try {
    if (target === 'base') {
      await buildImage(ctx, dir, deadline, logId, 'base')
      return { failed: [] }
    }
    // Recorded before the build, so the tag moving is what makes this the rollback target.
    const previous = await recordRollback(ctx)
    await buildImage(ctx, dir, deadline, logId, target)
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
 * is neither the one the build produced, nor the base it starts from, nor the recorded target is
 * retired. A successful removal is what makes "at most three" true; anything it could not remove is
 * reported, and the next dev build tries again.
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
  // The base is a parent of what the next dev build starts from, and it carries the keep label too.
  // A dev build cannot run its container without it, so a lookup that fails is a failed check, not
  // an absent image: removing the labelled base on a daemon hiccup would untag :base, and the next
  // build could not pull it.
  const base = await imageId(ctx, BUILD_BASE_IMAGE, timeoutMs())
  if (base === '') {
    return ['the base image could not be resolved, so nothing was removed']
  }
  keep.add(base)
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
  target: 'dev' | 'base' = 'dev',
): Promise<void> {
  // One file per build: a job follows exactly the log its own call writes.
  const logPath = path.join(ctx.stateDir, logId === undefined ? 'build.log' : `build-${logId}.log`)
  // Create the log before the first program: a silent failure still leaves the file behind.
  const log = await openAppendLog(logPath)
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
  if (target === 'base') {
    // The base stage needs only the root surface, not a compiled tree: the dev build is what runs
    // the container. It does carry the keep label — a host prune respects that — and the dev sweep
    // keeps the base id explicitly, because removing it would untag :base under the next build.
    await docker(
      ctx,
      [
        'build',
        '--target',
        'base',
        '--tag',
        BUILD_BASE_IMAGE,
        '--label',
        KEEP_LABEL,
        '--build-arg',
        `NPM_REGISTRY=${registry}`,
        '--file',
        path.join(dir, 'Dockerfile'),
        dir,
      ],
      'tail',
      { timeoutMs: remaining(deadline), logPath },
    )
    return
  }
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
