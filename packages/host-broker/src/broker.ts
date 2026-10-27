/**
 * The broker: one unix socket, one typed table, one audit line per request.
 *
 * It runs on the host as the deployment's user, so it can read what the user can read. What it
 * refuses to do is the boundary: there is no shell, no caller-supplied path, and no caller-supplied
 * program. The socket's permissions are the other half — `0600` in a directory only its owner may
 * write means only that uid can open it at all.
 */
import { createHash } from 'node:crypto'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import {
  AFTER_RESPONSE_DELAY_MS,
  BUILD_KEY_CHARS,
  DEFAULT_CONTAINER,
  DEFAULT_DOCKER,
  DEFAULT_GIT,
  DEFAULT_EXEC_TIMEOUT_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  FORBIDDEN_DIRECTORY_BITS,
  INTAKE_QUEUE_LIMIT,
  LIVENESS_TIMEOUT_MS,
  MAX_AUDIT_ARGS_CHARS,
  MAX_LINE_BYTES,
  MAX_TIMER_MS,
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
  /** The deployment checkout that holds `docker-compose.yml`; required by `deploy.recreate`. */
  readonly checkout?: string
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

const DEFAULTS = {
  logDir: '/var/log',
  procDir: '/proc',
  container: DEFAULT_CONTAINER,
  dockerPath: DEFAULT_DOCKER,
  gitPath: DEFAULT_GIT,
  rateLimitPerMinute: 60,
  execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
} as const

/** Start the broker and resolve once the socket is accepting. */
export async function startBroker(
  options: BrokerOptions,
): Promise<RunningBroker> {
  const logDir = options.logDir ?? DEFAULTS.logDir
  const procDir = options.procDir ?? DEFAULTS.procDir
  const container = options.container ?? DEFAULTS.container
  if (!/^\w[\w.-]*$/u.test(container)) {
    throw new Error(
      `container must be a docker container name, got ${JSON.stringify(container)}`,
    )
  }
  const dockerPath = options.dockerPath ?? DEFAULTS.dockerPath
  const gitPath = options.gitPath ?? DEFAULTS.gitPath
  const checkout =
    options.checkout === undefined ? undefined : path.resolve(options.checkout)
  if (checkout !== undefined) {
    const stats = await stat(checkout).catch(() => null)
    if (stats?.isDirectory() !== true) {
      throw new Error(
        `--checkout must be an existing directory, got ${checkout}`,
      )
    }
  }
  const rateLimitPerMinute =
    options.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute
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
  const context: OpContext = {
    logDir,
    procDir,
    execTimeoutMs,
    container,
    dockerPath,
    gitPath,
    stateDir: path.dirname(auditPath),
    buildRoot,
    deployLock,
    ...(checkout === undefined ? {} : { checkout }),
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
  await mkdir(buildRoot, { recursive: true, mode: DIRECTORY_MODE }).catch(
    () => null,
  )
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    serve(socket, context, limiter, auditPath, now)
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

  return {
    async close() {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
      await unlink(options.socketPath).catch(() => null)
    },
  }
}

/** Answer one connection, one request at a time, so responses stay in request order. */
function serve(
  socket: net.Socket,
  context: OpContext,
  limiter: RateLimiter,
  auditPath: string,
  now: () => number,
): void {
  let closed = false
  const endWith = (response: BrokerResponse): void => {
    // `end` flushes the answer; destroying in its callback closes the readable side too, so a client
    // that never closes cannot keep the descriptor.
    socket.end(encode(response), () => socket.destroy())
  }
  /** Write an answer and resolve once it is flushed, so a deferred action can wait for it. */
  const sendAndWait = (response: BrokerResponse): Promise<void> =>
    new Promise(resolve => {
      if (closed || socket.destroyed) {
        resolve()
        return
      }
      socket.write(encode(response), () => resolve())
    })

  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  const reader = createLineReader({
    onLine(line) {
      queue = queue
        .then(() => answer(line, sendAndWait, context, limiter, auditPath, now))
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

  const finish = async (
    response: BrokerResponse,
    outcome: { bytes: number; truncated: boolean; error?: string },
    after?: () => Promise<void> | void,
  ): Promise<void> => {
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
      await send({
        ...(requestId === undefined ? {} : { id: requestId }),
        ok: false,
        error: {
          code: 'internal',
          message: 'the audit log could not be written',
        },
      })
      return
    }
    await send(response)
    if (after !== undefined) {
      // The caller's container may be replaced by this work, so give the answer time to arrive.
      await new Promise(resolve => {
        setTimeout(resolve, AFTER_RESPONSE_DELAY_MS)
      })
      // A failed deferred step is recorded in its own log; the answer has already gone out.
      await Promise.resolve(after()).catch(() => null)
    }
  }

  try {
    const request = parseRequest(line)
    op = request.op
    requestId = request.id
    args = request.args
    const definition = findOp(request.op)
    const budget = definition?.timeoutMs ?? context.execTimeoutMs
    const deadline = Date.now() + budget
    const deployment = await acquireDeployment(context, definition, budget)
    if (deployment.fault !== undefined) {
      await finish(faultAnswer(deployment.fault, requestId), {
        bytes: 0,
        truncated: false,
        error: deployment.fault.code,
      })
      return
    }
    const hold = deployment.hold
    try {
      const execution = await execute(
        request,
        context,
        limiter,
        started,
        deadline,
      )
      await finish(
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
      // Only when the operation never started does the answer release; otherwise it releases when
      // its own work settles.
      if (hold !== undefined && !hold.started) {
        hold.release()
      }
    }
  } catch (error) {
    let fault: BrokerFault
    if (error instanceof BrokerFault) {
      fault = error
    } else {
      const message =
        error instanceof Error ? error.message : 'the operation failed'
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
  hold?: DeploymentHold,
): Promise<Capped & Pick<Execution, 'after'>> {
  // Resolve before limiting: a caller-chosen name must not get a bucket of its own, or the limit
  // would only bound repeats of one spelling and the map would grow without limit.
  const definition = request.op === DESCRIBE_OP ? undefined : findOp(request.op)
  const bucket =
    request.op === DESCRIBE_OP
      ? DESCRIBE_OP
      : (definition?.name ?? UNKNOWN_BUCKET)
  if (!limiter.take(bucket, started)) {
    throw new BrokerFault(
      'too-many-requests',
      bucket === UNKNOWN_BUCKET
        ? 'unknown operations are rate-limited; wait a minute'
        : `${bucket} is rate-limited; wait a minute`,
    )
  }
  if (request.op !== DESCRIBE_OP && definition === undefined) {
    throw new BrokerFault(
      'unknown-op',
      `no operation named ${JSON.stringify(request.op)}`,
    )
  }
  const raw =
    definition === undefined
      ? describeOps()
      : await runOp(definition, request.args, context, deadline, hold)
  const value: Execution = typeof raw === 'string' ? { text: raw } : raw
  const capped =
    definition === undefined
      ? capOutput(value.text)
      : capOutput(value.text, definition.keep)
  return {
    ...capped,
    ...(value.after === undefined ? {} : { after: value.after }),
  }
}

/** One failed answer, with the request id when the caller sent one. */
function faultAnswer(
  fault: BrokerFault,
  requestId: string | undefined,
): BrokerResponse {
  return {
    ...(requestId === undefined ? {} : { id: requestId }),
    ok: false,
    error: { code: fault.code, message: fault.message },
  }
}

/** The lock a serial operation holds; `started` says whether the work has begun. */
interface DeploymentHold {
  readonly release: () => void
  started: boolean
}

/**
 * Take the deployment lock when the operation asks for it. A waiter that cannot get in within its
 * own budget answers with the fault instead of queueing indefinitely.
 */
async function acquireDeployment(
  context: OpContext,
  definition: OpDefinition | undefined,
  budget: number,
): Promise<{ hold?: DeploymentHold; fault?: BrokerFault }> {
  if (definition?.serial !== true) {
    return {}
  }
  try {
    return {
      hold: {
        release: await context.deployLock.acquire(budget),
        started: false,
      },
    }
  } catch (error) {
    if (error instanceof BrokerFault) {
      return { fault: error }
    }
    const message =
      error instanceof Error ? error.message : 'the operation failed'
    return { fault: new BrokerFault('internal', message) }
  }
}

function runOp(
  op: OpDefinition,
  args: Record<string, unknown>,
  context: OpContext,
  deadline: number,
  hold?: DeploymentHold,
): Promise<Execution | string> {
  // The lock wait comes out of the same budget, so a queued deployment cannot start after its
  // caller has already been told the operation timed out.
  const running = op.run(args, context)
  if (hold !== undefined) {
    hold.started = true
    // A caller timeout must not release the lock while the work is still running: the operation
    // releases it when *it* settles, whichever way that went.
    void running.finally(() => hold.release()).catch(() => null)
  }
  return withTimeout(
    running,
    Math.max(1, deadline - Date.now()) + TIMEOUT_SLACK_MS,
  )
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

function appendAudit(
  file: string,
  record: Record<string, unknown>,
): Promise<void> {
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
      done(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? false : true,
      )
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
