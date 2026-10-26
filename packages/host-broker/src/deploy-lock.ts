/**
 * One deployment at a time.
 *
 * A build retags `:dev`, and a recreate or rollback has compose start from that tag: if the two
 * overlap, compose can pick up an image the rollback never approved. The lock serializes the
 * operations; the broker owns one instance, so two brokers do not block each other. The broker is
 * also the one that releases it: a waiter that runs out of its own budget gives up here, and a
 * holder releases in the broker's `finally`, whichever way the answer went.
 */
import { BrokerFault } from './protocol.ts'

export class DeployLock {
  #tail: Promise<void> = Promise.resolve()

  /**
   * Wait for the previous holder. `budgetMs` bounds the wait; the returned function releases.
   * A waiter that gives up removes itself from the queue, so it can never start work later.
   */
  async acquire(budgetMs: number): Promise<() => void> {
    const previous = this.#tail
    let resolveHeld: (() => void) | undefined
    const held = new Promise<void>(resolve => {
      resolveHeld = resolve
    })
    this.#tail = previous.then(() => held)
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new BrokerFault(
            'unavailable',
            'a deployment is in progress; try again when it finishes',
          ),
        )
      }, budgetMs)
    })
    try {
      await Promise.race([previous, expired])
    } catch (error) {
      // Give the next waiter its turn now; the holder still holds until it releases.
      resolveHeld?.()
      throw error
    } finally {
      clearTimeout(timer)
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      resolveHeld?.()
    }
  }
}
