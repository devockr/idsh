/**
 * One request to the host broker, over its unix socket.
 *
 * A fresh connection per call keeps both sides stateless: the broker answers one request per
 * connection and closes on overflow, so there is nothing to reuse or resynchronise. The socket is
 * the only thing the container knows about the host — no credential ever crosses it.
 */
import net from 'node:net'

import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_TIMER_MS, NEWLINE_BYTE } from './constants.ts'

/** Where the broker listens, and how long a call may take. */
export interface BrokerEndpoint {
  readonly socketPath: string
  readonly timeoutMs?: number
}

/** One answer: the broker's text, and whether it was capped on the way out. */
export interface BrokerAnswer {
  readonly text: string
  readonly truncated: boolean
}

interface BrokerResponse {
  readonly ok?: unknown
  readonly result?: unknown
  readonly truncated?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/**
 * Run one operation and return its answer.
 *
 * A transport failure says what the caller can do about it (start the broker, wait, raise the
 * timeout); a refusal keeps the broker's message, which is written for the caller. The timeout is
 * clamped to Node's timer ceiling, so a profile cannot ask for a deadline that fires at 1 ms.
 */
export function callBroker(
  endpoint: BrokerEndpoint,
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BrokerAnswer> {
  const timeoutMs = Math.min(endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMER_MS)
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.socketPath)
    let buffer = Buffer.alloc(0)
    const state: {
      settled: boolean
      timer?: NodeJS.Timeout
      onAbort?: () => void
    } = { settled: false }

    const finish = (error: Error | null, answer?: BrokerAnswer): void => {
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
      if (error === null && answer !== undefined) {
        resolve(answer)
      } else {
        reject(error ?? new Error('the host broker gave no answer'))
      }
    }

    state.timer = setTimeout(() => {
      finish(new Error(`the host broker did not answer within ${String(timeoutMs)} ms`))
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
      finish(new Error('the host broker closed the connection without an answer'))
    })
  })
}

function answer(line: string): [Error | null, BrokerAnswer?] {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    return [new TypeError('the host broker answered with a line that is not JSON')]
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [new TypeError('the host broker answered without an object')]
  }
  const response = value as BrokerResponse
  if (response.ok === true) {
    if (typeof response.result !== 'string') {
      return [new Error('the host broker answered without a result')]
    }
    return [null, { text: response.result, truncated: response.truncated === true }]
  }
  return [new Error(refusal(response))]
}

function refusal(response: BrokerResponse): string {
  const message = response.error?.message
  return typeof message === 'string' && message !== ''
    ? message
    : 'the host broker refused the request'
}
