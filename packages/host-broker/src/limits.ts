/**
 * The bounds every answer shares: how much text may come back, and how often one operation may be
 * asked for. Both are reported rather than applied silently — a truncated answer says so, and a
 * refused one says which limit it hit.
 */

import { DEFAULT_WINDOW_MS, MAX_OUTPUT_BYTES } from './constants.ts'

export { MAX_OUTPUT_BYTES } from './constants.ts'

export interface Capped {
  readonly text: string
  readonly truncated: boolean
}

/**
 * Trim text to the output ceiling on a line boundary.
 *
 * Bytes are the limit, not characters: a line is dropped only when it cannot fit, so a multi-byte
 * character is never split in half.
 */
export function capOutput(text: string): Capped {
  if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false }
  }
  const cut = Buffer.from(text).subarray(0, MAX_OUTPUT_BYTES).toString('utf8')
  const boundary = cut.lastIndexOf('\n')
  return { text: boundary > 0 ? cut.slice(0, boundary) : cut, truncated: true }
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
