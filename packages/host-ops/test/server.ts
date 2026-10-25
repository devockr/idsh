import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface BrokerRequest {
  readonly op: string
  readonly args: unknown
}

export interface FakeBroker {
  readonly socketPath: string
  readonly requests: BrokerRequest[]
  close(): Promise<void>
}

/** A stand-in for the broker: it reads one line per connection and answers what the handler says. */
export async function fakeBroker(
  handler: (request: BrokerRequest) => string | null,
): Promise<FakeBroker> {
  const requests: BrokerRequest[] = []
  const server = net.createServer(socket => {
    // A client that hangs up mid-write must not become an uncaught error in the harness.
    socket.on('error', () => socket.destroy())
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      const request = JSON.parse(buffer.slice(0, newline)) as BrokerRequest
      requests.push(request)
      const answer = handler(request)
      if (answer !== null) {
        socket.write(answer)
      }
    })
  })
  const root = await mkdtemp(path.join(tmpdir(), 'idsh-host-ops-'))
  const socketPath = path.join(root, 'host.sock')
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
