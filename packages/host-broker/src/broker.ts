/**
 * The broker: one unix socket, one typed table, one audit line per request.
 *
 * It runs on the host as the deployment's user, so it can read what the user can read. What it
 * refuses to do is the boundary: there is no shell, no caller-supplied path, and no caller-supplied
 * program. The socket's permissions are the other half — `0600` in a directory only its owner may
 * write means only that uid can open it at all.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, appendFile, chmod, lstat, mkdir, rm, stat, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import packageJson from '../package.json' with { type: 'json' }
import {
  AFTER_RESPONSE_DELAY_MS,
  BUILD_KEY_CHARS,
  DEFAULT_CONTAINER,
  DEFAULT_DOCKER,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_GIT,
  DEFAULT_IP,
  DEFAULT_NPM,
  DEFAULT_PNPM,
  DRAIN_TIMEOUT_MS,
  DEFAULT_SS,
  IP_CANDIDATES,
  SS_CANDIDATES,
  DIRECTORY_MODE,
  FILE_MODE,
  FORBIDDEN_DIRECTORY_BITS,
  INTAKE_QUEUE_LIMIT,
  LIVENESS_TIMEOUT_MS,
  MAX_AUDIT_ARGS_CHARS,
  MAX_LINE_BYTES,
  MAX_TIMER_MS,
  SEND_TIMEOUT_MS,
  SOCKET_MODE,
  TIMEOUT_SLACK_MS,
} from './constants.ts'
import { DeployLock } from './deploy-lock.ts'
import { capOutput, RateLimiter, type Capped } from './limits.ts'
import {
  BrokerFault,
  createLineReader,
  encode,
  parseRequest,
  type BrokerRequest,
  type BrokerResponse,
} from './protocol.ts'
import {
  describeOps,
  findOp,
  type Execution,
  type OpContext,
  type OpDefinition,
} from './sources.ts'

/** The operation that answers with the table itself, so the plugin never hard-codes it. */
export const DESCRIBE_OP = 'ops.describe'

/** Every request the table does not contain shares this rate-limit bucket. */
const UNKNOWN_BUCKET = 'unknown'

export interface BrokerOptions {
  /** The socket to create. A missing directory is made `0700`; the socket is made `0600`. */
  readonly socketPath: string
  /** Append-only JSON Lines; one line per request, refused ones included. */
  readonly auditPath: string
  /** Where `log.tail` reads. Default `/var/log`. */
  readonly logDir?: string
  /** Where `proc.read` reads. Default `/proc`; tests point it somewhere else. */
  readonly procDir?: string
  /** The container `deploy.*` inspects. Default `dsh`. */
  readonly container?: string
  /** The docker client `deploy.*` runs. Default `docker`, resolved through the host's PATH. */
  readonly dockerPath?: string
  /** The git client `deploy.*` runs. Default `git`, resolved through the host's PATH. */
  readonly gitPath?: string
  /** The `ip` client `net.status` runs. Default: the first of the usual locations that exists. */
  readonly ipPath?: string
  /** The `ss` client `net.sockets` runs. Default: the first of the usual locations that exists. */
  readonly ssPath?: string
  /** The pnpm client `broker.update` runs. Default `pnpm`, resolved through the host's PATH. */
  readonly pnpmPath?: string
  /** The npm client the published-package update runs. Default `npm`. */
  readonly npmPath?: string
  /** The program this broker runs from; defaults to argv[1]. */
  readonly entryPath?: string
  /** How `broker.update` stops the process; the tests pass their own, the CLI exits. */
  readonly stop?: () => void
  /** The deployment checkout that holds `docker-compose.yml`; required by `deploy.recreate`. */
  readonly checkout?: string
  /** The credential broker's own checkout; `gcb.update` rebuilds from it. */
  readonly gcbCheckout?: string
  /** The compose file that runs the broker; `gcb.update` recreates only its service. */
  readonly gcbCompose?: string
  /** The repository `gcb.update` probes for, `owner/name`; the broker's own check after a recreate. */
  readonly gcbProbeRepo?: string
  /** The compose service that runs the broker. Default `gcb`. */
  readonly gcbService?: string
  /** Requests per operation per minute. Default 60. */
  readonly rateLimitPerMinute?: number
  /** How long one operation may take. Default 10s; clamped to Node's timer ceiling. */
  readonly execTimeoutMs?: number
  /** Injectable clock, so the rate limiter is testable without sleeping. */
  readonly now?: () => number
}

export interface RunningBroker {
  close(): Promise<void>
}

/** An optional path from the command line, resolved and checked to be what its flag promises. */
async function optionalPath(
  value: string | undefined,
  flag: string,
  kind: 'directory' | 'file',
): Promise<string | undefined> {
  if (value === undefined) {
    return undefined
  }
  const resolved = path.resolve(value)
  const stats = await stat(resolved).catch(() => null)
  const matches = stats !== null && (kind === 'directory' ? stats.isDirectory() : stats.isFile())
  if (!matches) {
    throw new Error(`${flag} must be an existing ${kind}, got ${resolved}`)
  }
  return resolved
}

/** First candidate that exists and is executable. */
async function firstExisting(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Try the next location.
    }
  }
  return undefined
}

const DEFAULTS = {
  logDir: '/var/log',
  procDir: '/proc',
  container: DEFAULT_CONTAINER,
  dockerPath: DEFAULT_DOCKER,
  gitPath: DEFAULT_GIT,
  pnpmPath: DEFAULT_PNPM,
  npmPath: DEFAULT_NPM,
  rateLimitPerMinute: 60,
  execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
} as const

/** Start the broker and resolve once the socket is accepting. */
export async function startBroker(options: BrokerOptions): Promise<RunningBroker> {
  const logDir = options.logDir ?? DEFAULTS.logDir
  const procDir = options.procDir ?? DEFAULTS.procDir
  const container = options.container ?? DEFAULTS.container
  if (!/^\w[\w.-]*$/u.test(container)) {
    throw new Error(`container must be a docker container name, got ${JSON.stringify(container)}`)
  }
  const dockerPath = options.dockerPath ?? DEFAULTS.dockerPath
  const gitPath = options.gitPath ?? DEFAULTS.gitPath
  const ipPath = options.ipPath ?? (await firstExisting(IP_CANDIDATES)) ?? DEFAULT_IP
  const ssPath = options.ssPath ?? (await firstExisting(SS_CANDIDATES)) ?? DEFAULT_SS
  const checkout = await optionalPath(options.checkout, '--checkout', 'directory')
  const gcbCheckout = await optionalPath(options.gcbCheckout, '--gcb-checkout', 'directory')
  const gcbCompose = await optionalPath(options.gcbCompose, '--gcb-compose', 'file')
  const gcbProbeRepo = options.gcbProbeRepo
  // `owner/name`, and each side starts with a character a repository name can start with: `../repo`
  // and `.` match a dot-only pattern, and the probe would refuse them after a rebuild instead of at
  // boot.
  if (
    gcbProbeRepo !== undefined &&
    !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/u.test(gcbProbeRepo)
  ) {
    throw new Error(`--gcb-probe-repo must be owner/name, got ${JSON.stringify(gcbProbeRepo)}`)
  }
  const gcbService = options.gcbService ?? 'gcb'
  if (!/^\w[\w.-]*$/u.test(gcbService)) {
    throw new Error(
      `--gcb-service must be a compose service name, got ${JSON.stringify(gcbService)}`,
    )
  }
  const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute
  // Clamp where the context is built, not only in the wrapper: the same value reaches `spawn`,
  // and a program started with a delay past Node's ceiling is killed at 1 ms.
  const execTimeoutMs = Math.min(
    options.execTimeoutMs ?? DEFAULTS.execTimeoutMs,
    MAX_TIMER_MS - TIMEOUT_SLACK_MS,
  )
  const auditPath = options.auditPath
  const now = options.now ?? Date.now

  // A build root per socket *path*, not per basename: two sockets with the same name in different
  // directories must not share (and sweep) one another's clones.
  const buildKey = createHash('sha256')
    .update(path.resolve(options.socketPath))
    .digest('hex')
    .slice(0, BUILD_KEY_CHARS)
  const buildRoot = path.join(path.dirname(auditPath), 'build', buildKey)
  const deployLock = new DeployLock()
  const pnpmPath = options.pnpmPath ?? DEFAULTS.pnpmPath
  const npmPath = options.npmPath ?? DEFAULTS.npmPath
  const entryPath = options.entryPath ?? process.argv.at(1) ?? ''
  const brokerVersion = packageJson.version || 'unknown'
  const startedAt = now()
  const stopHolder: { stop?: () => void } = {}
  const context: OpContext = {
    logDir,
    procDir,
    execTimeoutMs,
    container,
    dockerPath,
    gitPath,
    ipPath,
    ssPath,
    pnpmPath,
    npmPath,
    entryPath,
    brokerVersion,
    startedAt,
    socketPath: options.socketPath,
    auditPath,
    stop: options.stop ?? (() => stopHolder.stop?.()),
    stateDir: path.dirname(auditPath),
    buildRoot,
    deployLock,
    ...(checkout === undefined ? {} : { checkout }),
    ...(gcbCheckout === undefined ? {} : { gcbCheckout }),
    ...(gcbCompose === undefined ? {} : { gcbCompose }),
    ...(gcbProbeRepo === undefined ? {} : { gcbProbeRepo }),
    gcbService,
  }
  const limiter = new RateLimiter(rateLimitPerMinute)
  const sockets = new Set<net.Socket>()

  // The audit directory is made once, not per request: a request path that touches the filesystem
  // twice is a request path that can fail in a second way.
  await mkdir(path.dirname(auditPath), {
    recursive: true,
    mode: DIRECTORY_MODE,
  })
  // A file left by rotation may be wider than FILE_MODE; narrow it before the first record.
  const audit = await stat(auditPath).catch(() => null)
  if (audit?.isFile() === true) {
    await chmod(auditPath, FILE_MODE).catch(() => null)
  }
  await prepareSocketDirectory(options.socketPath)
  // Only now is it clear no other broker is serving this socket; a tree another uid owns must not
  // keep the broker from starting, so the sweep is best effort.
  await rm(buildRoot, { recursive: true, force: true }).catch(() => null)
  await mkdir(buildRoot, { recursive: true, mode: DIRECTORY_MODE }).catch(() => null)
  let inFlight = 0
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    serve(socket, context, limiter, auditPath, now, {
      start: () => {
        inFlight += 1
      },
      end: () => {
        inFlight -= 1
      },
    })
  })
  await listen(server, options.socketPath)
  try {
    await chmod(options.socketPath, SOCKET_MODE)
  } catch (error) {
    // The socket may be reachable to someone else; do not leave it listening behind a failure.
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>(resolve => server.close(() => resolve()))
    await unlink(options.socketPath).catch(() => null)
    throw error
  }

  /** Let requests that are already being answered finish before the sockets go. */
  const drain = async (): Promise<void> => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const shutdown = async (): Promise<void> => {
    await drain()
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>(resolve => server.close(() => resolve()))
    await unlink(options.socketPath).catch(() => null)
  }
  stopHolder.stop = () => {
    // Let this answer finish first: the stop is called from inside one.
    setTimeout(() => {
      void shutdown()
    }, 50)
  }
  return { close: shutdown }
}

/** Answer one connection, one request at a time, so responses stay in request order. */
interface Tracker {
  start: () => void
  end: () => void
}

function serve(
  socket: net.Socket,
  context: OpContext,
  limiter: RateLimiter,
  auditPath: string,
  now: () => number,
  tracker: Tracker,
): void {
  let closed = false
  const endWith = (response: BrokerResponse): void => {
    // `end` flushes the answer; destroying in its callback closes the readable side too, so a client
    // that never closes cannot keep the descriptor.
    socket.end(encode(response), () => socket.destroy())
  }
  /** Write an answer and settle once it is flushed; a write that cannot happen is a failure. */
  const sendAndWait = (response: BrokerResponse): Promise<void> =>
    new Promise((resolve, reject) => {
      if (closed || socket.destroyed) {
        // A caller that hung up has lost its answer; that is not a failed operation.
        resolve()
        return
      }
      // A write that has not flushed by now counts as a lost answer too, so a stalled socket cannot
      // keep the deferred work (and the deployment lock) waiting.
      const timer = setTimeout(() => resolve(), SEND_TIMEOUT_MS)
      socket.write(encode(response), error => {
        clearTimeout(timer)
        if (error === undefined || error === null) {
          resolve()
        } else {
          reject(error)
        }
      })
    })

  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  const reader = createLineReader({
    onLine(line) {
      queue = queue
        .then(() => {
          tracker.start()
          return answer(line, sendAndWait, context, limiter, auditPath, now).finally(() =>
            tracker.end(),
          )
        })
        .catch(() => {
          // One broken request must not stall every later one on this connection.
        })
        .finally(() => {
          pending -= 1
          if (pending < INTAKE_QUEUE_LIMIT) {
            socket.resume()
          }
        })
      pending += 1
      // A client that pipelines faster than the broker answers is a buffer with no ceiling; pause
      // the socket until the queue drains. One chunk is already parsed, so the queue can overshoot
      // this by that chunk's lines — bounded by one read, not by the client.
      if (pending >= INTAKE_QUEUE_LIMIT) {
        socket.pause()
      }
    },
    onOverflow() {
      if (closed) {
        return
      }
      closed = true
      // The one refusal that never reaches `answer` still leaves its audit line, with the shape a
      // `bad-json` refusal gets: no operation, and the error code as the outcome.
      const record = {
        time: new Date(now()).toISOString(),
        op: '?',
        ok: false,
        durationMs: 0,
        bytes: 0,
        truncated: false,
        args: '{}',
        error: 'line-too-long',
      }
      void appendAudit(auditPath, record).then(
        () => {
          endWith({
            ok: false,
            error: {
              code: 'line-too-long',
              message: `a request line is limited to ${String(MAX_LINE_BYTES)} bytes`,
            },
          })
        },
        () => {
          // An unaudited refusal must not look like a refusal that got away with it.
          endWith({
            ok: false,
            error: {
              code: 'internal',
              message: 'the audit log could not be written',
            },
          })
        },
      )
    },
  })

  socket.on('data', reader)
  socket.on('error', () => socket.destroy())
}

async function answer(
  line: string,
  send: (response: BrokerResponse) => Promise<void>,
  context: OpContext,
  limiter: RateLimiter,
  auditPath: string,
  now: () => number,
): Promise<void> {
  const started = now()
  let op = '?'
  let requestId: string | undefined
  let args: Record<string, unknown> = {}
  let release: (() => void) | undefined
  let released = false
  // One release for the whole request: the handler releases when nothing is deferred, the deferred
  // work's own chain releases when it is.
  const releaseOnce = (): void => {
    if (released) {
      return
    }
    released = true
    release?.()
  }

  /** Write an answer; a caller that hung up has lost it, which is not a failed operation. */
  const deliver = async (response: BrokerResponse): Promise<void> => {
    try {
      await send(response)
    } catch {
      // The audit line stands and any deferred work still runs.
    }
  }

  const finish = async (
    response: BrokerResponse,
    outcome: { bytes: number; truncated: boolean; error?: string },
    after?: () => Promise<void> | void,
  ): Promise<boolean> => {
    try {
      await appendAudit(auditPath, {
        time: new Date(started).toISOString(),
        op,
        ok: response.ok,
        durationMs: now() - started,
        bytes: outcome.bytes,
        truncated: outcome.truncated,
        args: boundedArgs(args),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      })
    } catch {
      // An unaudited action is not allowed to look like a successful one.
      await deliver({
        ...(requestId === undefined ? {} : { id: requestId }),
        ok: false,
        error: {
          code: 'internal',
          message: 'the audit log could not be written',
        },
      })
      return false
    }
    await deliver(response)
    if (after === undefined) {
      return false
    }
    // The answer is out; the deferred work runs detached from this handler, after a pause that lets
    // the answer arrive, and whatever holds the request's lock releases when that work ends.
    setTimeout(() => {
      void Promise.resolve()
        .then(after)
        .catch(() => null)
        .finally(releaseOnce)
    }, AFTER_RESPONSE_DELAY_MS)
    return true
  }

  try {
    const request = parseRequest(line)
    op = request.op
    requestId = request.id
    args = request.args
    const definition = findOp(request.op, context)
    const budget = definition?.timeoutMs ?? context.execTimeoutMs
    const deployment = acquireDeployment(context, definition)
    if (deployment.fault !== undefined) {
      await finish(faultAnswer(deployment.fault, requestId), {
        bytes: 0,
        truncated: false,
        error: deployment.fault.code,
      })
      return
    }
    const deadline = Date.now() + budget
    const controller = new AbortController()
    const requestContext = { ...context, signal: controller.signal }
    release = deployment.release
    let deferred = false
    try {
      const execution = await execute(
        request,
        requestContext,
        limiter,
        started,
        deadline,
        controller,
      )
      deferred = await finish(
        {
          ...(requestId === undefined ? {} : { id: requestId }),
          ok: true,
          result: execution.text,
          ...(execution.truncated ? { truncated: true } : {}),
        },
        {
          bytes: Buffer.byteLength(execution.text),
          truncated: execution.truncated,
        },
        execution.after,
      )
    } finally {
      // When the answer carries deferred work, that work's chain releases the lock; otherwise this
      // request is done as soon as its answer is written.
      if (!deferred) {
        releaseOnce()
      }
    }
  } catch (error) {
    let fault: BrokerFault
    if (error instanceof BrokerFault) {
      fault = error
    } else {
      const message = error instanceof Error ? error.message : 'the operation failed'
      fault = new BrokerFault('internal', message)
    }
    await finish(faultAnswer(fault, requestId), {
      bytes: 0,
      truncated: false,
      error: fault.code,
    })
  }
}

/** Resolve, limit, run and bound one request. Separated so the answer path stays readable. */
async function execute(
  request: BrokerRequest,
  context: OpContext,
  limiter: RateLimiter,
  started: number,
  deadline: number,
  controller?: AbortController,
): Promise<Capped & Pick<Execution, 'after'>> {
  // Resolve before limiting: a caller-chosen name must not get a bucket of its own, or the limit
  // would only bound repeats of one spelling and the map would grow without limit.
  const definition = request.op === DESCRIBE_OP ? undefined : findOp(request.op, context)
  const bucket = request.op === DESCRIBE_OP ? DESCRIBE_OP : (definition?.name ?? UNKNOWN_BUCKET)
  if (!limiter.take(bucket, started)) {
    throw new BrokerFault(
      'too-many-requests',
      bucket === UNKNOWN_BUCKET
        ? 'unknown operations are rate-limited; wait a minute'
        : `${bucket} is rate-limited; wait a minute`,
    )
  }
  if (request.op !== DESCRIBE_OP && definition === undefined) {
    throw new BrokerFault('unknown-op', `no operation named ${JSON.stringify(request.op)}`)
  }
  const raw =
    definition === undefined
      ? describeOps(context)
      : await runOp(definition, request.args, context, deadline, controller)
  const value: Execution = typeof raw === 'string' ? { text: raw } : raw
  const capped =
    definition === undefined ? capOutput(value.text) : capOutput(value.text, definition.keep)
  return {
    ...capped,
    ...(value.after === undefined ? {} : { after: value.after }),
  }
}

/** One failed answer, with the request id when the caller sent one. */
function faultAnswer(fault: BrokerFault, requestId: string | undefined): BrokerResponse {
  return {
    ...(requestId === undefined ? {} : { id: requestId }),
    ok: false,
    error: { code: fault.code, message: fault.message },
  }
}

/**
 * Take the deployment lock when the operation asks for it. There is no queue: a deployment that
 * finds another one running answers with the fault, and its caller retries.
 */
function acquireDeployment(
  context: OpContext,
  definition: OpDefinition | undefined,
): { release?: () => void; fault?: BrokerFault } {
  if (definition?.serial !== true) {
    return {}
  }
  const release = context.deployLock.tryAcquire()
  if (release === undefined) {
    return {
      fault: new BrokerFault(
        'unavailable',
        'a deployment is in progress; stop it (or wait for it to finish), then run this again',
      ),
    }
  }
  return { release }
}

function runOp(
  op: OpDefinition,
  args: Record<string, unknown>,
  context: OpContext,
  deadline: number,
  controller?: AbortController,
): Promise<Execution | string> {
  const running = op.run(args, context)
  const bounded = withTimeout(running, Math.max(1, deadline - Date.now()) + TIMEOUT_SLACK_MS)
  // A timed-out operation is also stopped: the program's group is killed through the signal, so it
  // cannot keep working (or retag an image) after the answer.
  void bounded.catch(() => controller?.abort())
  return bounded
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    // The context clamps the operation timeout, so `ms` stays under Node's ceiling here.
    const timer = setTimeout(() => {
      reject(new BrokerFault('timeout', `no answer within ${ms} ms`))
    }, ms)
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Arguments are useful in the audit log, but not at any length a caller chooses. */
function boundedArgs(args: Record<string, unknown>): string {
  const encoded = JSON.stringify(args)
  return encoded.length <= MAX_AUDIT_ARGS_CHARS
    ? encoded
    : `${encoded.slice(0, MAX_AUDIT_ARGS_CHARS)}…`
}

function appendAudit(file: string, record: Record<string, unknown>): Promise<void> {
  // `appendFile` writes the whole line (looping over partial writes) and creates the file with
  // `FILE_MODE`; the startup chmod covers a file that rotation installed.
  return appendFile(file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
}

/**
 * Prepare the socket's directory and clear a stale socket.
 *
 * A directory this process creates is made owner-only. An existing one is not narrowed — the
 * read-only fallback in `ROADMAP.md` uses `0750` on purpose — but one the container could write to
 * is refused, because a writable directory lets the socket there be replaced.
 */
async function prepareSocketDirectory(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath)
  const created = await mkdir(directory, {
    recursive: true,
    mode: DIRECTORY_MODE,
  })
  if (created === undefined) {
    const existing = await stat(directory)
    // eslint-disable-next-line sonarjs/bitwise-operators -- a permission mask, not a truthiness test
    if ((existing.mode & FORBIDDEN_DIRECTORY_BITS) !== 0) {
      throw new Error(`${directory} is group- or world-writable`)
    }
  } else {
    await chmod(directory, DIRECTORY_MODE)
  }

  const socket = await lstat(socketPath).catch(() => null)
  if (socket === null) {
    return
  }
  if (!socket.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket`)
  }
  if (await socketIsLive(socketPath)) {
    throw new Error(`another broker is already listening on ${socketPath}`)
  }
  await unlink(socketPath)
}

/**
 * Ask whether something is listening.
 *
 * Only a refused connection proves the socket is stale. A timeout proves nothing — a loaded host
 * can leave a live broker silent — so it is reported as live, and the next broker refuses to start
 * rather than quietly taking a path that another process may still be serving.
 */
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath)
    const done = (live: boolean): void => {
      socket.destroy()
      resolve(live)
    }
    socket.setTimeout(LIVENESS_TIMEOUT_MS, () => done(true))
    socket.once('connect', () => done(true))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? false : true)
    })
  })
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
