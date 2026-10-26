/**
 * One deployment at a time.
 *
 * A build retags `:dev`, and a recreate or rollback has compose start from that tag: if the two
 * overlap, compose can pick up an image the rollback never approved. The lock serializes the
 * operations; the broker owns one instance, so two brokers do not block each other.
 */
export class DeployLock {
  #tail: Promise<void> = Promise.resolve()

  /** Wait for the previous holder; the returned function releases this one. */
  async acquire(): Promise<() => void> {
    const previous = this.#tail
    let resolveHeld: (() => void) | undefined
    const held = new Promise<void>(resolve => {
      resolveHeld = resolve
    })
    this.#tail = previous.then(() => held)
    await previous
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
