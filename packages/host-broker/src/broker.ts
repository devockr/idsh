/**
 * The broker: one unix socket, one typed table, one audit line per request.
 *
 * It runs on the host as the deployment's user, so it can read what the user can read. What it
 * refuses to do is the boundary: there is no shell, no caller-supplied path, and no caller-supplied
 * program. The socket's permissions are the other half — `0600` in a `0700` directory means only
 * that uid can open it at all.
 */
import { appendFile, chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DIRECTORY_MODE,
  FILE_MODE,
  LIVENESS_TIMEOUT_MS,
  MAX_AUDIT_ARGS_CHARS,
  SOCKET_MODE,
  TIMEOUT_SLACK_MS,
} from './constants.ts'
import { capOutput, RateLimiter } from './limits.ts'
import {
  BrokerFault,
  createLineReader,
  encode,
  parseRequest,
  type BrokerResponse,
} from './protocol.ts'
import { describeOps, findOp, type OpContext } from './sources.ts'

/** The operation that answers with the table itself, so the plugin never hard-codes it. */
export const DESCRIBE_OP = 'ops.describe'

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
  const send = (response: BrokerResponse): void => {
    if (!socket.destroyed) {
      socket.write(encode(response))
    }
  }

  let queue: Promise<void> = Promise.resolve()
  const reader = createLineReader({
    onLine(line) {
      queue = queue
        .then(() =>
          answer(line, send, context, limiter, auditPath, execTimeoutMs, now),
        )
        .catch(() => {
          // One broken request must not stall every later one on this connection.
        })
    },
    onOverflow() {
      send({
        ok: false,
        error: {
          code: 'line-too-long',
          message: 'a request line is limited to 16 KiB',
        },
      })
      socket.destroy()
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
    args = request.args
    if (!limiter.take(request.op, started)) {
      throw new BrokerFault(
        'too-many-requests',
        `${request.op} is rate-limited; wait a minute`,
      )
    }
    const result =
      request.op === DESCRIBE_OP
        ? describeOps()
        : await runOp(request.op, request.args, context, execTimeoutMs)
    const capped = capOutput(result)
    await finish(
      {
        ...(request.id === undefined ? {} : { id: request.id }),
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
      { ok: false, error: { code: fault.code, message: fault.message } },
      { bytes: 0, truncated: false, error: fault.code },
    )
  }
}

async function runOp(
  name: string,
  args: Record<string, unknown>,
  context: OpContext,
  timeoutMs: number,
): Promise<string> {
  const op = findOp(name)
  if (op === undefined) {
    throw new BrokerFault(
      'unknown-op',
      `no operation named ${JSON.stringify(name)}`,
    )
  }
  return withTimeout(op.run(args, context), timeoutMs + TIMEOUT_SLACK_MS)
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
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

async function appendAudit(
  file: string,
  record: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: DIRECTORY_MODE })
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE })
}

/**
 * Prepare the socket's directory and clear a stale socket.
 *
 * Refuses to clobber a non-socket, and refuses to steal a socket something is still listening on;
 * a second broker would otherwise silently take over the first one's path.
 */
async function prepareSocketDirectory(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
  await chmod(directory, DIRECTORY_MODE)

  const existing = await lstat(socketPath).catch(() => null)
  if (existing === null) {
    return
  }
  if (!existing.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket`)
  }
  if (await isLive(socketPath)) {
    throw new Error(`another broker is already listening on ${socketPath}`)
  }
  await unlink(socketPath)
}

function isLive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath)
    const done = (live: boolean): void => {
      socket.destroy()
      resolve(live)
    }
    socket.setTimeout(LIVENESS_TIMEOUT_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
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
