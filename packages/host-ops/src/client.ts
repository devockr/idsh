/**
 * One request to the host broker, over its unix socket.
 *
 * A fresh connection per call keeps both sides stateless: the broker answers one request per
 * connection and closes on overflow, so there is nothing to reuse or resynchronise. The socket is
 * the only thing the container knows about the host — no credential ever crosses it.
 */
import net from 'node:net'

import {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  NEWLINE_BYTE,
} from './constants.ts'

/** Where the broker listens, and how long a call may take. */
export interface BrokerEndpoint {
  readonly socketPath: string
  readonly timeoutMs?: number
}

interface BrokerResponse {
  readonly ok?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/**
 * Run one operation and return its text.
 *
 * A transport failure says what the caller can do about it (start the broker, wait, raise the
 * timeout); a refusal keeps the broker's message, which is written for the caller.
 */
export function callBroker(
  endpoint: BrokerEndpoint,
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.socketPath)
    let buffer = Buffer.alloc(0)
    const state: {
      settled: boolean
      timer?: NodeJS.Timeout
      onAbort?: () => void
    } = { settled: false }

    const finish = (error: Error | null, result?: string): void => {
      if (state.settled) {
        return
      }
      state.settled = true
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
      }
      if (state.onAbort !== undefined) {
        signal?.removeEventListener('abort', state.onAbort)
      }
      socket.destroy()
      if (error === null) {
        resolve(result ?? '')
      } else {
        reject(error)
      }
    }

    state.timer = setTimeout(() => {
      finish(
        new Error(
          `the host broker did not answer within ${String(timeoutMs)} ms`,
        ),
      )
    }, timeoutMs)

    state.onAbort = (): void => {
      finish(new Error('the host operation was cancelled'))
    }
    if (signal?.aborted === true) {
      state.onAbort()
    } else {
      signal?.addEventListener('abort', state.onAbort, { once: true })
    }

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ op, args })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(new Error('the host broker answered past the line ceiling'))
        return
      }
      const newline = buffer.indexOf(NEWLINE_BYTE)
      if (newline === -1) {
        return
      }
      finish(...answer(buffer.subarray(0, newline).toString('utf8')))
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(
        new Error(
          `the host broker is not reachable at ${endpoint.socketPath} (${error.code ?? error.message})`,
        ),
      )
    })
    socket.once('close', () => {
      finish(
        new Error('the host broker closed the connection without an answer'),
      )
    })
  })
}

function answer(line: string): [Error | null, string?] {
  let response: BrokerResponse
  try {
    response = JSON.parse(line) as BrokerResponse
  } catch {
    return [
      new TypeError('the host broker answered with a line that is not JSON'),
    ]
  }
  if (response.ok === true) {
    return typeof response.result === 'string'
      ? [null, response.result]
      : [new Error('the host broker answered without a result')]
  }
  return [new Error(refusal(response))]
}

function refusal(response: BrokerResponse): string {
  const message = response.error?.message
  return typeof message === 'string' && message !== ''
    ? message
    : 'the host broker refused the request'
}
