#!/usr/bin/env node
/**
 * `idsh-host` — start the host broker.
 *
 * Everything it needs is a path: the socket the container will connect to, and the audit log. Both
 * belong outside every bind mount, and the scheduler that keeps this process alive is the same one
 * that names them. No credentials are read here — the operations are host-local, and the router
 * hop (phase 3) will take its key from the same directory.
 */
import { parseArgs } from 'node:util'

import { startBroker } from './broker.ts'
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_TIMER_MS,
  TIMEOUT_SLACK_MS,
} from './constants.ts'

const USAGE = `Usage: idsh-host --socket <path> --audit <path> [options]

The host side of @idsh/host-ops. Run it as the deployment's user, from the host's scheduler.

  --socket <path>        The unix socket to create (required)
  --audit <path>         Append-only JSON Lines, one line per request (required)
  --log-dir <dir>        Where log.tail reads (default /var/log)
  --proc-dir <dir>       Where proc.read reads (default /proc)
  --container <name>     The container deploy.* inspects (default dsh)
  --docker <path>        The docker client deploy.* runs (default docker)
  --git <path>           The git client deploy.build runs (default git)
  --ip <path>            The ip client net.status runs (default: the usual locations)
  --ss <path>            The ss client net.sockets runs (default: the usual locations)
  --pnpm <path>          The pnpm client broker.update runs (default pnpm)
  --npm <path>           The npm client broker.update runs (default npm)
  --checkout <dir>       The checkout holding docker-compose.yml and docker-compose.dev.yml;
                          also the source broker.update rebuilds from when the CLI runs inside it
  --rate-limit <n>       Requests per operation per minute (default 60)
  --exec-timeout <ms>    How long one operation may take (default 10000)
  -h, --help             Show this help

A directory this process creates is 0700 and the socket is chmodded 0600, so only the uid running
this process can open it. An existing directory is left as it is, but one that is group- or
world-writable is refused. There is no shell here: see the operation table in the README.
`

function number(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.POSITIVE_INFINITY,
): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(value)}`,
    )
  }
  if (parsed > max) {
    throw new Error(
      `${name} must be at most ${String(max)}, got ${JSON.stringify(value)}`,
    )
  }
  return parsed
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      socket: { type: 'string' },
      audit: { type: 'string' },
      'log-dir': { type: 'string' },
      'proc-dir': { type: 'string' },
      container: { type: 'string' },
      docker: { type: 'string' },
      git: { type: 'string' },
      ip: { type: 'string' },
      ss: { type: 'string' },
      pnpm: { type: 'string' },
      npm: { type: 'string' },
      checkout: { type: 'string' },
      'rate-limit': { type: 'string' },
      'exec-timeout': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help === true) {
    process.stdout.write(USAGE)
    return
  }
  if (values.socket === undefined || values.audit === undefined) {
    process.stderr.write(USAGE)
    process.exitCode = 2
    return
  }

  const handlers: { shutdown?: () => void } = {}
  const broker = await startBroker({
    socketPath: values.socket,
    auditPath: values.audit,
    ...(values['log-dir'] === undefined ? {} : { logDir: values['log-dir'] }),
    ...(values['proc-dir'] === undefined
      ? {}
      : { procDir: values['proc-dir'] }),
    ...(values.container === undefined ? {} : { container: values.container }),
    ...(values.docker === undefined ? {} : { dockerPath: values.docker }),
    ...(values.git === undefined ? {} : { gitPath: values.git }),
    ...(values.ip === undefined ? {} : { ipPath: values.ip }),
    ...(values.ss === undefined ? {} : { ssPath: values.ss }),
    ...(values.pnpm === undefined ? {} : { pnpmPath: values.pnpm }),
    ...(values.npm === undefined ? {} : { npmPath: values.npm }),
    ...(values.checkout === undefined ? {} : { checkout: values.checkout }),
    // The supervisor restarts the process once it has drained; that is the self-update hand-off.
    stop: () => handlers.shutdown?.(),
    rateLimitPerMinute: number(values['rate-limit'], 60, '--rate-limit'),
    execTimeoutMs: number(
      values['exec-timeout'],
      DEFAULT_EXEC_TIMEOUT_MS,
      '--exec-timeout',
      // The wrapper schedules a timer this much later; past Node's ceiling it fires at 1 ms.
      MAX_TIMER_MS - TIMEOUT_SLACK_MS,
    ),
  })

  process.stderr.write(`idsh-host: listening on ${values.socket}\n`)

  handlers.shutdown = () => {
    void broker.close().then(
      () => {
        process.exitCode = 0
      },
      () => {
        process.exitCode = 1
      },
    )
  }

  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return
    }
    stopping = true
    process.stderr.write(`idsh-host: ${signal}, closing\n`)
    handlers.shutdown?.()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `idsh-host: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
