/**
 * The broker wire protocol: newline-delimited JSON over a unix stream socket.
 *
 * One request per line in, one response per line out. A bounded line keeps a peer from making the
 * broker buffer without limit. The socket never leaves the host, and it is unaffected by the
 * client's proxy environment — unlike the HTTP transports that were considered for this seam.
 */

import { MAX_LINE_BYTES, NEWLINE_BYTE } from './constants.ts'

export { MAX_LINE_BYTES } from './constants.ts'

/** Stable error codes; a caller may branch on these, never on the message. */
export type BrokerErrorCode =
  | 'bad-argument'
  | 'bad-json'
  | 'bad-request'
  | 'internal'
  | 'line-too-long'
  | 'timeout'
  | 'too-many-requests'
  | 'unavailable'
  | 'unknown-op'

export interface BrokerError {
  readonly code: BrokerErrorCode
  readonly message: string
}

/** One request, as parsed: the operation to run and the arguments it may take. */
export interface BrokerRequest {
  readonly id?: string
  readonly op: string
  readonly args: Record<string, unknown>
}

/** One answer. `result` is the operation's bounded output; `error` replaces it when set. */
export interface BrokerResponse {
  readonly id?: string
  readonly ok: boolean
  readonly result?: string
  readonly error?: BrokerError
  readonly truncated?: boolean
}

/** A failure the caller is meant to see, with a code it can branch on. */
export class BrokerFault extends Error {
  readonly code: BrokerErrorCode

  constructor(code: BrokerErrorCode, message: string) {
    super(message)
    this.name = 'BrokerFault'
    this.code = code
  }
}

/** Encode one response. */
export function encode(response: BrokerResponse): Buffer {
  return Buffer.from(`${JSON.stringify(response)}\n`, 'utf8')
}

/**
 * Parse one request line.
 *
 * Strict on purpose: an unexpected shape is refused rather than coerced, because everything after
 * this point assumes `args` is an object and `op` is a string.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function parseRequest(line: string): BrokerRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new BrokerFault('bad-json', 'the line is not JSON')
  }
  if (!isRecord(value) || Array.isArray(value)) {
    throw new BrokerFault('bad-request', 'a request must be a JSON object')
  }
  const op = value['op']
  if (typeof op !== 'string' || op === '') {
    throw new BrokerFault('bad-request', 'op must be a non-empty string')
  }
  // `null` is dropped by `??`, so what is left is an object or a value of another kind.
  const args: unknown = value['args'] ?? {}
  if (!isRecord(args) || Array.isArray(args)) {
    throw new BrokerFault('bad-request', 'args must be an object when present')
  }
  const id = value['id']
  if (id !== undefined && typeof id !== 'string') {
    throw new BrokerFault('bad-request', 'id must be a string when present')
  }
  return {
    ...(id === undefined ? {} : { id }),
    op,
    args,
  }
}

export interface LineReaderOptions {
  /** Ceiling for one line, in bytes. Default {@link MAX_LINE_BYTES}. */
  maxBytes?: number
  /** Called once per complete, non-empty line. */
  onLine(line: string): void
  /**
   * Called once when a line exceeds `maxBytes`; the reader stops, because the stream can no longer
   * be framed.
   */
  onOverflow?(): void
}

/**
 * Turn a byte stream into protocol lines.
 *
 * A line that overruns the ceiling is dropped whole and reported, rather than delivered truncated:
 * a cut-off request is not a request. The reader then stops: after an unterminated overrun the
 * stream's framing is gone, and after a terminated one the caller's answer is to close the
 * connection, so nothing later would be read anyway.
 */
export function createLineReader(options: LineReaderOptions): (chunk: Buffer | string) => void {
  const maxBytes = options.maxBytes ?? MAX_LINE_BYTES
  let buffer = Buffer.alloc(0)
  let overflowed = false

  return (chunk: Buffer | string): void => {
    // Once a line is too long the stream has lost its framing: where that line ends is unknown, so
    // nothing after it is a request any more.
    if (overflowed) {
      return
    }
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    let newline = buffer.indexOf(NEWLINE_BYTE)
    while (newline !== -1) {
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (line.length > maxBytes) {
        // A terminated line gets the same ceiling as an unterminated one.
        overflowed = true
        options.onOverflow?.()
        return
      }
      const text = line.toString('utf8')
      if (text.trim() !== '') {
        options.onLine(text)
      }
      newline = buffer.indexOf(NEWLINE_BYTE)
    }
    if (buffer.length > maxBytes) {
      overflowed = true
      buffer = Buffer.alloc(0)
      options.onOverflow?.()
    }
  }
}
