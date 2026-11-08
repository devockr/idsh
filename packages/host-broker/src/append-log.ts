import { constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'

import { FILE_MODE } from './constants.ts'
import { BrokerFault } from './protocol.ts'

/** How long opening an append-only log may take before the path is treated as unresponsive. */
const OPEN_TIMEOUT_MS = 5_000

/**
 * Open an append-only log, and refuse anything that is not a regular file. The open is nonblocking
 * so a FIFO cannot sit in the thread pool; a FIFO with no reader fails with ENXIO, one with a
 * reader opens and is then rejected by the file-type check. The timeout stays as a backstop for a
 * path that never answers at all.
 */
export async function openAppendLog(file: string): Promise<FileHandle> {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK
  const pending = open(file, flags, FILE_MODE)
  let timer: NodeJS.Timeout | undefined
  let handle: FileHandle
  try {
    handle = await new Promise<FileHandle>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new BrokerFault(
            'unavailable',
            `${file} did not open within ${String(OPEN_TIMEOUT_MS / 1000)}s; an unresponsive path would hold the deployment`,
          ),
        )
      }, OPEN_TIMEOUT_MS)
      pending.then(resolve, reject)
    })
  } catch (error) {
    // The backstop can fire while the open is still pending (a path that answers after the bound):
    // close the handle if it ever arrives instead of leaking it.
    void pending.then(
      opened => opened.close().catch(() => null),
      () => null,
    )
    if ((error as NodeJS.ErrnoException).code === 'ENXIO') {
      // A UNIX socket in that spot answers ENXIO as well, so the message does not name only FIFOs.
      throw new BrokerFault(
        'unavailable',
        `${file} is a FIFO or socket with no reader; a log must be a regular file`,
      )
    }
    throw error
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new BrokerFault('unavailable', `${file} is not a regular file; a log must be one`)
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => null)
    throw error
  }
}
