/**
 * One deployment at a time.
 *
 * A build retags `:dev`, and a recreate or rollback has compose start from that tag: if the two
 * overlap, compose can pick up an image the rollback never approved. The lock serializes the
 * operations; the broker owns one instance, so two brokers do not block each other. There is no
 * queue: a deployment that finds the lock taken is refused, and the caller tries again when it is
 * done — nobody can know how long the running one will take.
 */
export class DeployLock {
  #held = false

  /** Take the lock, or `undefined` when a deployment is already running. */
  tryAcquire(): (() => void) | undefined {
    if (this.#held) {
      return undefined
    }
    this.#held = true
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.#held = false
    }
  }
}
