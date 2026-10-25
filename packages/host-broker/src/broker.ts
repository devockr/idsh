/**
 * The broker: one unix socket, one typed table, one audit line per request.
 *
 * It runs on the host as the deployment's user, so it can read what the user can read. What it
 * refuses to do is the boundary: there is no shell, no caller-supplied path, and no caller-supplied
 * program. The socket's permissions are the other half — `0600` in a directory only its owner may
 * write means only that uid can open it at all.
 */
import { chmod, lstat, mkdir, open, stat, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import {
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
  type OpContext,
  type OpDefinition,
} from './sources.ts'

/** The operation that answers with the table itself, so the plugin never hard-codes it. */
export const DESCRIBE_OP = 'ops.describe'

/** Every request the table does not contain shares this rate-limit bucket. */
const UNKNOWN_BUCKET = 'unknown'

export interface BrokerOptions {
  /** The socket to create. Its directory is created `0700`, the socket is made `0600`. */
  readonly socketPath: string
  /** Append-only JSON Lines; one line per request, refused ones included. */
  readonly auditPath: string
  /** Where `log.tail` reads. Default `/var/log`. */
  readonly logDir?: string
  /** Where `proc.read` reads. Default `/proc`; tests point it somewhere else. */
  readonly procDir?: string
  /** Requests per operation per minute. Default 60. */
  readonly rateLimitPerMinute?: number
  /** How long one operation may take. Default 10s. */
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
  rateLimitPerMinute: 60,
  execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
} as const

/** Start the broker and resolve once the socket is accepting. */
export async function startBroker(
  options: BrokerOptions,
): Promise<RunningBroker> {
  const logDir = options.logDir ?? DEFAULTS.logDir
  const procDir = options.procDir ?? DEFAULTS.procDir
  const rateLimitPerMinute =
    options.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute
  const execTimeoutMs = options.execTimeoutMs ?? DEFAULTS.execTimeoutMs
  const auditPath = options.auditPath
  const now = options.now ?? Date.now

  const context: OpContext = { logDir, procDir, execTimeoutMs }
  const limiter = new RateLimiter(rateLimitPerMinute)
  const sockets = new Set<net.Socket>()

  // The audit directory is made once, not per request: a request path that touches the filesystem
  // twice is a request path that can fail in a second way.
  await mkdir(path.dirname(auditPath), {
    recursive: true,
    mode: DIRECTORY_MODE,
  })
  await prepareSocketDirectory(options.socketPath)
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    serve(socket, context, limiter, auditPath, execTimeoutMs, now)
  })
  await listen(server, options.socketPath)
  await chmod(options.socketPath, SOCKET_MODE)

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
  execTimeoutMs: number,
  now: () => number,
): void {
  let closed = false
  const endWith = (response: BrokerResponse): void => {
    // `end` flushes the answer; destroying in its callback closes the readable side too, so a client
    // that never closes cannot keep the descriptor.
    socket.end(encode(response), () => socket.destroy())
  }
  const send = (response: BrokerResponse): void => {
    // Nothing may be written after the overflow answer has ended the socket.
    if (!closed && !socket.destroyed) {
      socket.write(encode(response))
    }
  }

  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  const reader = createLineReader({
    onLine(line) {
      pending += 1
      // A client that pipelines faster than the broker answers is a buffer with no ceiling;
      // pause the socket until the queue drains instead.
      if (pending >= INTAKE_QUEUE_LIMIT) {
        socket.pause()
      }
      queue = queue
        .then(() =>
          answer(line, send, context, limiter, auditPath, execTimeoutMs, now),
        )
        .catch(() => {
          // One broken request must not stall every later one on this connection.
        })
        .finally(() => {
          pending -= 1
          if (pending < INTAKE_QUEUE_LIMIT) {
            socket.resume()
          }
        })
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
  send: (response: BrokerResponse) => void,
  context: OpContext,
  limiter: RateLimiter,
  auditPath: string,
  execTimeoutMs: number,
  now: () => number,
): Promise<void> {
  const started = now()
  let op = '?'
  let requestId: string | undefined
  let args: Record<string, unknown> = {}

  const finish = async (
    response: BrokerResponse,
    outcome: { bytes: number; truncated: boolean; error?: string },
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
      send({
        ...(requestId === undefined ? {} : { id: requestId }),
        ok: false,
        error: {
          code: 'internal',
          message: 'the audit log could not be written',
        },
      })
      return
    }
    send(response)
  }

  try {
    const request = parseRequest(line)
    op = request.op
    requestId = request.id
    args = request.args
    const capped = await execute(
      request,
      context,
      limiter,
      execTimeoutMs,
      started,
    )
    await finish(
      {
        ...(requestId === undefined ? {} : { id: requestId }),
        ok: true,
        result: capped.text,
        ...(capped.truncated ? { truncated: true } : {}),
      },
      { bytes: Buffer.byteLength(capped.text), truncated: capped.truncated },
    )
  } catch (error) {
    let fault: BrokerFault
    if (error instanceof BrokerFault) {
      fault = error
    } else {
      const message =
        error instanceof Error ? error.message : 'the operation failed'
      fault = new BrokerFault('internal', message)
    }
    await finish(
      {
        ...(requestId === undefined ? {} : { id: requestId }),
        ok: false,
        error: { code: fault.code, message: fault.message },
      },
      { bytes: 0, truncated: false, error: fault.code },
    )
  }
}

/** Resolve, limit, run and bound one request. Separated so the answer path stays readable. */
async function execute(
  request: BrokerRequest,
  context: OpContext,
  limiter: RateLimiter,
  execTimeoutMs: number,
  started: number,
): Promise<Capped> {
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
  const result =
    definition === undefined
      ? describeOps()
      : await runOp(definition, request.args, context, execTimeoutMs)
  return capOutput(result)
}

function runOp(
  op: OpDefinition,
  args: Record<string, unknown>,
  context: OpContext,
  timeoutMs: number,
): Promise<string> {
  return withTimeout(op.run(args, context), timeoutMs + TIMEOUT_SLACK_MS)
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    // Node fires a delay above 2^31 - 1 ms at 1 ms instead; clamp rather than overflow.
    const delay = Math.min(ms, MAX_TIMER_MS)
    const timer = setTimeout(() => {
      reject(new BrokerFault('timeout', `no answer within ${ms} ms`))
    }, delay)
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

async function appendAudit(
  file: string,
  record: Record<string, unknown>,
): Promise<void> {
  const handle = await open(file, 'a', FILE_MODE)
  try {
    // `mode` on open applies only when the file is created, and rotation can install a wider one;
    // set it on the descriptor before the record goes in.
    await handle.chmod(FILE_MODE)
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    // One `write` can stop short; a torn line is the one thing this path must not produce.
    for (let written = 0; written < line.length;) {
      const { bytesWritten } = await handle.write(line, written)
      if (bytesWritten <= 0) {
        throw new Error('the audit write made no progress')
      }
      written += bytesWritten
    }
  } finally {
    await handle.close()
  }
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
