/**
 * The bounds every answer shares: how much text may come back, and how often one operation may be
 * asked for. Both are reported rather than applied silently — a truncated answer says so, and a
 * refused one says which limit it hit.
 */

import {
  DEFAULT_WINDOW_MS,
  MAX_OUTPUT_BYTES,
  MAX_UTF8_SEQUENCE,
} from './constants.ts'

export { MAX_OUTPUT_BYTES } from './constants.ts'

export interface Capped {
  readonly text: string
  readonly truncated: boolean
}

/**
 * Trim text to the output ceiling.
 *
 * Bytes are the limit, not characters: a cut is moved back to a character boundary (so no U+FFFD
 * appears and the result cannot re-encode past the ceiling) and then, when the text has one, back to
 * the last line boundary inside it.
 */
export function capOutput(text: string): Capped {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false }
  }
  const cut = decodeAtMost(bytes, MAX_OUTPUT_BYTES)
  const boundary = cut.lastIndexOf('\n')
  return { text: boundary > 0 ? cut.slice(0, boundary) : cut, truncated: true }
}

/**
 * Decode at most `limit` bytes of a UTF-8 buffer, backing off to a character boundary.
 *
 * A plain `subarray(0, limit).toString()` replaces a half-cut character with U+FFFD, which both
 * splits one character and re-encodes to more bytes than the ceiling allows.
 */
function decodeAtMost(bytes: Buffer, limit: number): string {
  for (let end = limit; end > limit - MAX_UTF8_SEQUENCE && end > 0; end -= 1) {
    try {
      return new TextDecoder('utf8', { fatal: true }).decode(
        bytes.subarray(0, end),
      )
    } catch {
      // The cut landed inside a sequence; one byte shorter may be a boundary.
    }
  }
  return new TextDecoder('utf8').decode(bytes.subarray(0, limit))
}

/**
 * A fixed-window rate limiter, one window per key.
 *
 * Fixed windows are enough here: the limits guard against a runaway loop, not against a careful
 * attacker, who can always wait. `now` is injectable so the behaviour is testable without sleeping.
 */
export class RateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #windows = new Map<string, { start: number; count: number }>()

  constructor(limit: number, windowMs = DEFAULT_WINDOW_MS) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('limit must be a positive integer')
    }
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Take one slot for `key`; false means this window is exhausted. */
  take(key: string, now = Date.now()): boolean {
    const window = this.#windows.get(key)
    if (window === undefined || now - window.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 })
      return true
    }
    if (window.count >= this.#limit) {
      return false
    }
    window.count += 1
    return true
  }
}
