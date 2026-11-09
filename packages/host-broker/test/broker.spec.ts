import { strict as assert } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  mkdir,
  symlink,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import {
  capOutput,
  createLineReader,
  BUILD_TIMEOUT_MS,
  DEFAULT_PROC_LINES,
  MAX_ERROR_CHARS,
  MAX_LINE_BYTES,
  MAX_PATTERN_CHARS,
  MAX_PROC_LINES,
  MAX_OUTPUT_BYTES,
  parseRequest,
  RateLimiter,
  startBroker,
  TAIL_WINDOW_BYTES,
  type BrokerResponse,
  type RunningBroker,
} from '@idsh/host-broker'

// The bounds these tests assert against; named here because the broker keeps them internal.
const ALIGN = 32
const COMMIT_CHARS = 40
/** Long enough for the deferred work of one operation to land. */
const FLUSH_MS = 700
/** The probe's bound, and the bound of each local query, as `gcb.update` declares them. */
const GCB_PROBE_MS = 60_000
/** The bounded pull and the host-broker wait, both part of the declared budget. */
const GCB_PULL_MS = 60_000
/** How often the host-half wait looks again; the barrier test relies on it. */
const GCB_POLL_MS = 2_000
/** A FIFO log must be refused immediately, not through the five-second backstop. */
const FIFO_REFUSAL_MS = 3_000
/** How long the barrier test waits for the stand-in supervisor to publish its replacement. */
const REPLACEMENT_WAIT_MS = 5_000
const GCB_HOST_WAIT_MS = 300_000
/** The git reads around the pull (status, ssh config, commit), budgeted at the query deadline each. */
const GCB_PRELUDE_STEPS = 3
const GCB_QUERY_MS = 10_000
/** The queries gcb.update runs: services, images, replicas, ps and inspect. */
const GCB_QUERY_COUNT = 8
/** How long the test gives the deploy lock to free before it gives up: patience, not a duration. */
const LOCK_WAIT_MS = 5_000
/** The interval between two attempts while waiting for the lock. */
const POLL_MS = 100
const ODD_BYTES = 33
const FIXED_NOW = 1_700_000_000_000

/**
 * Poll until `attempt` agrees, up to `deadlineMs`. The deploy lock frees when the deferred work
 * finishes, which is behaviour, so the test waits for it instead of sleeping past a guess.
 */
async function waitFor(attempt: () => Promise<boolean>, deadlineMs = LOCK_WAIT_MS): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await attempt()) {
      return
    }
    if (Date.now() - started > deadlineMs) {
      throw new Error('the condition did not hold in time')
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

// oxlint-disable-next-line no-magic-numbers -- a sha256 is 64 hex characters
const ROLLBACK_TARGET = 'sha256:' + 'a'.repeat(64)

/** A commit id is 40 hex characters; a sha256 digest is 64. */
const SHA_LENGTH = 40
const DIGEST_LENGTH = 64

/** The image a recreate finds running in the tests below; it is its own rollback target. */
const RUNNING_IMAGE = `sha256:${'e'.repeat(DIGEST_LENGTH)}`

const roots: string[] = []

after(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }).catch(() => null)))
})

const SMALL_LINE_LIMIT = 10
const LONG_ROW_CHARS = 40_000
const OUTPUT_CAP_BYTES = MAX_OUTPUT_BYTES
const MODE_MASK = 0o777
const SOCKET_MODE = 0o600
const DIRECTORY_MODE = 0o700

interface FakeHost {
  root: string
  logDir: string
  procDir: string
  socketPath: string
  auditPath: string
}

/**
 * A throwaway host: a log directory, a proc directory, a socket and an audit log.
 *
 * @returns The paths the broker is started with.
 */
async function fakeHost(): Promise<FakeHost> {
  const root = await mkdtemp(path.join(tmpdir(), 'idsh-host-'))
  roots.push(root)
  const logDir = path.join(root, 'log')
  const procDir = path.join(root, 'proc')
  await mkdir(logDir)
  await mkdir(procDir)
  await writeFile(
    path.join(logDir, 'messages'),
    ['boot ok', 'error: disk 1 failed', 'warn: smart pending', 'error: retry failed'].join('\n'),
  )
  await writeFile(
    path.join(procDir, 'mdstat'),
    'Personalities : [raid1]\nmd0 : active raid1 sda1[0]\n',
  )
  return {
    root,
    logDir,
    procDir,
    socketPath: path.join(root, 'sock', 'host.sock'),
    auditPath: path.join(root, 'audit.jsonl'),
  }
}

interface Client {
  request(message: {
    id?: string
    op: string
    args?: Record<string, unknown>
  }): Promise<BrokerResponse>
  close(): void
}

/**
 * A line-oriented client: send one request, await the next response.
 *
 * @param socketPath The broker's socket.
 * @returns The client.
 */
function client(socketPath: string): Client {
  const socket = net.connect(socketPath)
  let buffer = ''
  let waiting: ((response: BrokerResponse) => void) | undefined
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') {
        continue
      }
      const resolve = waiting
      waiting = undefined
      resolve?.(JSON.parse(line) as BrokerResponse)
    }
  })
  return {
    async request(message) {
      await ready
      return new Promise<BrokerResponse>(resolve => {
        waiting = resolve
        socket.write(`${JSON.stringify(message)}\n`)
      })
    },
    close() {
      socket.destroy()
    },
  }
}

void test('parseRequest accepts the shape it documents', () => {
  assert.deepEqual(parseRequest('{"op":"proc.read","args":{"file":"mdstat"}}'), {
    op: 'proc.read',
    args: { file: 'mdstat' },
  })
  assert.deepEqual(parseRequest('{"id":"1","op":"x","args":{}}'), {
    id: '1',
    op: 'x',
    args: {},
  })
  // args is optional, and defaults to an empty object rather than undefined.
  assert.deepEqual(parseRequest('{"op":"x"}'), { op: 'x', args: {} })
})

void test('parseRequest refuses what it cannot interpret', () => {
  const cases = [
    'not json',
    '[]',
    'null',
    '{}',
    '{"op":""}',
    '{"op":"x","args":[]}',
    '{"op":"x","id":2}',
  ]
  for (const line of cases) {
    assert.throws(() => parseRequest(line), Error, line)
  }
})

void test('the line reader splits, skips blank lines and reports an overrun', () => {
  const lines: string[] = []
  const overflow: Array<true> = []
  const read = createLineReader({
    onLine: line => {
      lines.push(line)
    },
    onOverflow: () => overflow.push(true),
    maxBytes: SMALL_LINE_LIMIT,
  })
  read('{"a":1}\n{"b"')
  read(':2}\n\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  assert.deepEqual(overflow, [])
  read('x'.repeat(SMALL_LINE_LIMIT + 1))
  assert.deepEqual(overflow, [true])
  // The stream has lost its framing: nothing after the overflow is delivered.
  read('{"c":3}\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
})

void test('a terminated line over the ceiling is dropped too', () => {
  const lines: string[] = []
  const overflow: Array<true> = []
  const read = createLineReader({
    onLine: line => {
      lines.push(line)
    },
    onOverflow: () => overflow.push(true),
    maxBytes: SMALL_LINE_LIMIT,
  })
  read(`${'x'.repeat(SMALL_LINE_LIMIT + 1)}\n`)
  assert.deepEqual(lines, [])
  assert.deepEqual(overflow, [true])
})

void test('capOutput trims to the ceiling on a line boundary', () => {
  const short = 'one\ntwo\n'
  assert.deepEqual(capOutput(short), { text: short, truncated: false })

  const long = `${'x'.repeat(LONG_ROW_CHARS)}\n${'y'.repeat(LONG_ROW_CHARS)}\n`
  const capped = capOutput(long)
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.endsWith('\n'))
})

void test('run answers the policy verdict, and refuses what the declaration does not allow', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const verdict = await connection.request({
      op: 'run',
      args: { argv: ['ping', '-c', '3', '1.1.1.1'], dryRun: true },
    })
    assert.equal(verdict.ok, true, JSON.stringify(verdict.error))
    assert.equal(
      verdict.result,
      'would run: ping -c 3 1.1.1.1\nnothing was executed; dryRun answered the policy verdict only',
    )

    for (const argv of [
      // A flag before the object, which is the form iproute2 documents.
      ['ip', '-4', 'addr'],
      ['ip', 'addr'],
      // A +flag is a flag: dig's only spelling.
      ['dig', '+short', 'example.com'],
      // A compressed IPv6 literal starts with a colon and is still a host.
      ['ping', '::1'],
      ['ping', 'fe80::1'],
      // A link-local literal carries its zone.
      ['ping', 'fe80::1%eth0'],
      // dig without a target is a valid default query, so it stays optional.
      ['dig'],
    ] as const) {
      const accepted = await connection.request({ op: 'run', args: { argv, dryRun: true } })
      assert.equal(accepted.ok, true, `${argv.join(' ')}: ${JSON.stringify(accepted.error)}`)
    }

    for (const argv of [
      // Not declared, so not a program this broker starts.
      ['rm', '-rf', '/'],
      // A declared binary with a subcommand it does not have.
      ['ip', 'link', 'set', 'eth0', 'down'],
      // A flag that is not in the declaration.
      ['df', '-h;rm'],
      // The declared spelling, not a second one: `--h` was never in the table.
      ['df', '--h'],
      // A colon run names no host.
      ['ping', ':::'],
      // A probe needs something to probe.
      ['ping'],
      ['traceroute'],
      ['ping', '-c', '3'],
      // A value flag without its value.
      ['ping', '-c'],
      // More positionals than the declaration allows.
      ['ping', '1.1.1.1', '8.8.8.8'],
      // A positional that could be read as a flag.
      ['ping', '--help'],
      // Prototype names are not declarations, in the binary table or the flag table.
      ['constructor'],
      ['toString'],
      ['__proto__'],
      ['ping', '--toString', '1.1.1.1'],
      ['df', '-toString'],
      // A flag the binary declares, on a binary that does not.
      ['dig', '-4', 'example.com'],
      // The plus form only in the plus spelling: dig rejects `-+short` itself.
      ['dig', '-+short', 'example.com'],
    ] as const) {
      const refused = await connection.request({ op: 'run', args: { argv } })
      assert.equal(refused.ok, false, argv.join(' '))
      assert.equal(refused.error?.code, 'bad-argument', argv.join(' '))
    }

    const wrongType = await connection.request({
      op: 'run',
      args: { argv: ['df', '-h'], dryRun: 'yes' },
    })
    assert.equal(wrongType.ok, false)
    assert.equal(wrongType.error?.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('run uses the configured path where a source already owns the binary', async () => {
  const host = await fakeHost()
  // The fake programs answer their own argv, so the assertion proves which path ran — `ip addr` is
  // `addr` only if the broker spawned the configured one.
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    ipPath: '/bin/echo',
    ssPath: '/bin/echo',
  })
  const connection = client(host.socketPath)
  try {
    for (const [argv, expected] of [
      [['ip', 'addr'], 'addr'],
      [['ip', '-4', 'route'], '-4 route'],
      [['ss', '-t'], '-t'],
    ] as const) {
      const answer = await connection.request({ op: 'run', args: { argv } })
      assert.equal(answer.ok, true, JSON.stringify(answer.error))
      assert.equal((answer.result ?? '').trim(), expected, argv.join(' '))
    }
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('run looks for a declared binary outside an inherited PATH', async () => {
  const host = await fakeHost()
  // A `df` first on the inherited PATH answers `HIJACKED`; the fixed list is what keeps it from
  // being the one that runs. The process environment is the seam because the broker spawns its
  // children from it.
  const fakeDir = path.join(host.root, 'bin')
  await mkdir(fakeDir, { recursive: true })
  await writeFile(path.join(fakeDir, 'df'), '#!/bin/sh\necho HIJACKED\n', { mode: 0o755 })
  const original = process.env.PATH
  process.env.PATH = `${fakeDir}:${original ?? ''}`
  let broker: RunningBroker | undefined
  try {
    broker = await startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
    })
    const connection = client(host.socketPath)
    try {
      const answer = await connection.request({ op: 'run', args: { argv: ['df', '-h'] } })
      assert.equal(answer.ok, true, JSON.stringify(answer.error))
      assert.doesNotMatch(answer.result ?? '', /HIJACKED/u)
    } finally {
      connection.close()
    }
  } finally {
    process.env.PATH = original
    await broker?.close()
  }
})

void test('run executes a declared binary and answers its output', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'run', args: { argv: ['df', '-h'] } })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.notEqual((answer.result ?? '').trim(), '')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('the rate limiter opens a window per key and refills', () => {
  const limiter = new RateLimiter(2, 1000)
  assert.equal(limiter.take('a', 0), true)
  assert.equal(limiter.take('a', 1), true)
  assert.equal(limiter.take('a', 2), false)
  assert.equal(limiter.take('b', 2), true)
  assert.equal(limiter.take('a', 1000), true)
})

interface DescribedOp {
  name: string
  summary: string
  input: { required?: string[] }
  confirm?: boolean
  preview?: string
  timeoutMs?: number
}

interface DescribedTable {
  protocol: number
  version: string
  ops: DescribedOp[]
}

/** The table inside an `ops.describe` answer, with the protocol it was built for. */
function describedTable(result: string | undefined): DescribedTable {
  return JSON.parse(result ?? '{}') as DescribedTable
}

interface AuditEntry {
  op: string
  ok: boolean
  error?: string
}

void test('the broker answers, audits, and keeps its socket private', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const socketStats = await stat(host.socketPath)
  const directoryStats = await stat(path.join(host.root, 'sock'))
  assert.equal(socketStats.mode & MODE_MASK, SOCKET_MODE)
  assert.equal(directoryStats.mode & MODE_MASK, DIRECTORY_MODE)

  const connection = client(host.socketPath)
  try {
    const tail = await connection.request({
      id: 'a',
      op: 'log.tail',
      args: { file: 'messages', lines: 2, pattern: 'error' },
    })
    assert.equal(tail.id, 'a')
    assert.equal(tail.ok, true)
    assert.equal(tail.result, 'error: disk 1 failed\nerror: retry failed')

    const proc = await connection.request({
      op: 'proc.read',
      args: { file: 'mdstat' },
    })
    assert.match(proc.result ?? '', /raid1/)

    const described = await connection.request({
      op: 'ops.describe',
      args: { protocol: 1 },
    })
    const ops = describedTable(described.result).ops
    assert.deepEqual(
      ops.map(op => op.name),
      [
        'log.tail',
        'proc.read',
        'deploy.status',
        'deploy.log',
        'deploy.versions',
        'deploy.source',
        'deploy.build',
        'deploy.main',
        'deploy.rollback',
        'deploy.recreate',
        'net.status',
        'net.sockets',
        'broker.status',
        'broker.update',
        'proc.list',
        'run',
        'disk.usage',
      ],
    )
    // The plugin refuses an operation without a summary, so a describeTable that dropped it would
    // stay green on names alone while every tool vanished.
    for (const op of ops) {
      assert.equal(typeof op.summary, 'string')
      assert.notEqual(op.summary.trim(), '')
    }
    const table = describedTable(described.result)
    // The answer says which protocol it is shaped for, and which broker produced it: that is what a
    // client compares with its own build.
    assert.equal(table.protocol, 1)
    const ownVersion = (
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string
      }
    ).version
    assert.equal(table.version, ownVersion)
    const describedTail = ops.find(op => op.name === 'log.tail')
    assert.equal(describedTail?.input.required?.[0], 'file')
    // The build operations name the read-only one that resolves them, so the person is asked about
    // the source rather than the request.
    for (const name of ['deploy.build', 'deploy.main']) {
      assert.equal(ops.find(op => op.name === name)?.preview, 'deploy.source')
    }

    const unknown = await connection.request({
      id: 'b',
      op: 'nope',
      args: {},
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error?.code, 'unknown-op')
    // A refusal is matchable to its request too.
    assert.equal(unknown.id, 'b')

    const badArg = await connection.request({
      op: 'log.tail',
      args: { file: '../etc/passwd' },
    })
    assert.equal(badArg.ok, false)
    assert.equal(badArg.error?.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }

  const auditText = await readFile(host.auditPath, 'utf8')
  const audit = auditText
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as AuditEntry)
  assert.equal(audit.length, 5)
  assert.deepEqual(
    audit.map(entry => entry.op),
    ['log.tail', 'proc.read', 'ops.describe', 'nope', 'log.tail'],
  )
  assert.equal(audit[0].ok, true)
  assert.equal(audit[3].error, 'unknown-op')
  // The refused request is recorded too, and never as a success.
  assert.equal(audit[4].ok, false)
})

void test('a live socket is not taken over, and a non-socket path is refused', async () => {
  const host = await fakeHost()
  const first = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  await assert.rejects(
    startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
    }),
    /already listening/u,
  )
  await first.close()

  // A path that is not a socket is never replaced: another program's file is not ours to unlink.
  await writeFile(host.socketPath, '')
  await assert.rejects(
    startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
    }),
    /is not a socket/u,
  )
})

void test('a stale socket, left by a killed broker, is replaced', async () => {
  const host = await fakeHost()
  await mkdir(path.join(host.root, 'sock'))
  // Node unlinks its own socket on a clean close; only a killed process leaves one behind.
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(host.socketPath)}, () => process.stdout.write('ready'))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.once('exit', code =>
        reject(new Error(`the socket holder exited early (${String(code)})`)),
      )
    })
  } finally {
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
  }
  const stale = await stat(host.socketPath)
  assert.equal(stale.isSocket(), true)

  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  const answer = await connection.request({
    op: 'proc.read',
    args: { file: 'mdstat' },
  })
  assert.equal(answer.ok, true)
  connection.close()
  await broker.close()
})

void test('capOutput never splits a character or passes its ceiling', () => {
  const text = `${'a'.repeat(OUTPUT_CAP_BYTES - 1)}😀${'b'.repeat(10)}`
  const capped = capOutput(text)
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.includes('\uFFFD'))
})

/** A log big enough to exercise the tail window; each row is exactly `rowLength` bytes. */
function bigLog(rowCount: number, head: string, rowLength = 32): { content: string; last: string } {
  const row = (index: number) =>
    `R${String(index).padStart(7, '0')}-${'x'.repeat(rowLength - 10)}\n`
  const content = head + Array.from({ length: rowCount }, (_, i) => row(i)).join('')
  return { content, last: row(rowCount - 1).trimEnd() }
}

void test('log.tail keeps the first whole row when the window starts on a boundary', async () => {
  const host = await fakeHost()
  const { content } = bigLog(
    // oxlint-disable-next-line no-magic-numbers -- a log larger than the tail window
    9000,
    '',
  )
  // The window starts at row 808. Only that row matches the pattern, so it is exactly the row the
  // off-by-one used to drop — a test that read the last rows would pass either way.
  assert.equal(content.length % ALIGN, 0)
  assert.equal((content.length - TAIL_WINDOW_BYTES) % ALIGN, 0)
  await writeFile(path.join(host.logDir, 'syslog'), content)

  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'log.tail',
      args: { file: 'syslog', lines: 2, pattern: 'R0000808-' },
    })
    assert.match(answer.result ?? '', /^R0000808-/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('log.tail drops the partial first row when the window starts inside one', async () => {
  const host = await fakeHost()
  // 33-byte rows put the window start inside a row rather than on one of its boundaries.
  const { content, last } = bigLog(
    // oxlint-disable-next-line no-magic-numbers -- a shorter log than the tail window
    8000,
    '',
    ODD_BYTES,
  )
  assert.notEqual((content.length - TAIL_WINDOW_BYTES) % ODD_BYTES, 0)
  await writeFile(path.join(host.logDir, 'syslog'), content)

  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'log.tail',
      args: { file: 'syslog', lines: 3 },
    })
    const rows = (answer.result ?? '').split('\n')
    assert.equal(rows.length, 3)
    assert.equal(rows[2], last)
    // No row may be a partial one: every returned row is whole.
    for (const row of rows) {
      assert.match(row, /^R\d{7}-x+$/u)
    }
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a request whose audit cannot be written answers internal', async () => {
  const host = await fakeHost()
  // The directory itself as the log: appendFile answers EISDIR for every uid, unlike a 0500
  // directory, which root can still write into.
  const locked = path.join(host.root, 'locked')
  await mkdir(locked)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: locked,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'proc.read',
      args: { file: 'mdstat' },
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.error?.code, 'internal')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('an over-long line is answered before the connection closes', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const socket = net.connect(host.socketPath)
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  const answer = await new Promise<BrokerResponse>((resolve, reject) => {
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        resolve(JSON.parse(buffer.slice(0, newline)) as BrokerResponse)
      }
    })
    socket.once('error', reject)
    socket.once('connect', () => {
      // Both in one write: the answer must be flushed before the server closes.
      socket.write(
        `${'x'.repeat(MAX_LINE_BYTES + 1)}\n{"op":"proc.read","args":{"file":"mdstat"}}\n`,
      )
    })
  })
  assert.equal(answer.error?.code, 'line-too-long')
  await closed
  // The refusal that never reaches `answer` is still audited.
  const auditText = await readFile(host.auditPath, 'utf8')
  const audit = auditText
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as AuditEntry)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].op, '?')
  assert.equal(audit[0].error, 'line-too-long')
  await broker.close()
})

void test('an existing audit file is narrowed to 0600', async () => {
  const host = await fakeHost()
  await writeFile(host.auditPath, '')
  await chmod(
    host.auditPath,
    // oxlint-disable-next-line no-magic-numbers -- a readable file mode
    0o644,
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'proc.read',
      args: { file: 'mdstat' },
    })
    assert.equal(answer.ok, true)
  } finally {
    connection.close()
    await broker.close()
  }
  const stats = await stat(host.auditPath)
  assert.equal(
    stats.mode & MODE_MASK,
    // oxlint-disable-next-line no-magic-numbers -- an owner-only file mode
    0o600,
  )
})

void test('an exec timeout past the timer ceiling is clamped where it is used', async () => {
  const host = await fakeHost()
  const warnings: string[] = []
  const onWarning = (warning: Error) => warnings.push(warning.name)
  process.on('warning', onWarning)
  try {
    const broker = await startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
      execTimeoutMs: 3_000_000_000,
    })
    const connection = client(host.socketPath)
    try {
      const answer = await connection.request({ op: 'disk.usage', args: {} })
      assert.equal(answer.ok, true)
    } finally {
      connection.close()
      await broker.close()
    }
    // Warnings are delivered on a later tick than the call that raised them.
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    process.off('warning', onWarning)
  }
  assert.ok(!warnings.includes('TimeoutOverflowWarning'))
})

void test('deploy.status and deploy.log drive the docker client', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(dockerPath, '#!/bin/sh\nprintf "%s\\n" "$*"\n', {
    mode: 0o755,
  })
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    container: 'web',
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const status = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(status.ok, true)
    assert.match(status.result ?? '', /^inspect --type container --format .*web$/mu)
    assert.match(status.result ?? '', /\{\{\.Config\.Image\}\}/u)
    assert.match(status.result ?? '', /container=\{\{\.Id\}\}/u)
    assert.match(status.result ?? '', /index \.State "Health"/u)
    assert.match(status.result ?? '', /\{\{\.State\.ExitCode\}\}/u)
    const tail = await connection.request({
      op: 'deploy.log',
      args: { lines: 3 },
    })
    assert.equal(tail.result, 'logs --tail 3 web\n')
    const bad = await connection.request({
      op: 'deploy.log',
      args: { lines: 0 },
    })
    assert.equal(bad.error?.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.versions reads the state and the versions inside the container', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  "inspect --type container --format {{.Id}} web") echo "WARNING: id read" >&2; echo abc ;;',
      '  "exec abc dsh --version") echo "WARNING: platform mismatch" >&2; echo 0.2.1-rc.5 ;;',
      '  "exec abc gcb --version") echo 0.4.0 ;;',
      '  *) printf "%s\n" "$*" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    container: 'web',
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.versions', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(
      answer.result ?? '',
      /^web: inspect --type container --format .*image-id=\{\{\.Image\}\}.* abc$/mu,
    )
    assert.match(answer.result ?? '', /^dsh: 0\.2\.1-rc\.5$/mu)
    // stdout only: a warning on stderr is not part of the parsed value.
    assert.doesNotMatch(answer.result ?? '', /WARNING/u)
    assert.match(answer.result ?? '', /^gcb: 0\.4\.0$/mu)
    // No argument is accepted; a missing binary is covered by the test below.
    const args = await connection.request({ op: 'deploy.versions', args: { container: 'x' } })
    assert.equal(args.error?.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.versions names an unavailable probe and still answers', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  "inspect --type container --format {{.Id}} web") echo "WARNING: id read" >&2; echo abc ;;',
      '  "exec abc dsh --version") echo 0.2.1-rc.5 ;;',
      '  "exec abc gcb --version") printf "no such file\nthe cause is here\n" >&2; exit 7 ;;',
      '  *) printf "%s\n" "$*" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    container: 'web',
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.versions', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^dsh: 0\.2\.1-rc\.5$/mu)
    // The cause is the last line of the failure, as runFixed keeps it for docker.
    assert.match(answer.result ?? '', /^gcb: unavailable — the cause is here$/mu)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a docker call that exceeds the deadline answers timeout', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(dockerPath, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    execTimeoutMs: 100,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.error?.code, 'timeout')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('docker streams merge in arrival order', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    "#!/bin/sh\nprintf '1 stdout\\n'\nprintf '2 stderr\\n' >&2\nprintf '3 stdout\\n'\nprintf '4 stderr\\n' >&2\n",
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.log', args: {} })
    const lines = answer.result ?? ''
    // Threads and pipes interleave nondeterministically, but each stream keeps its own order and
    // no line is welded to the next: the old concatenation lost both.
    assert.match(lines, /1 stdout[\s\S]*3 stdout/u)
    assert.match(lines, /2 stderr[\s\S]*4 stderr/u)
    assert.equal(lines.endsWith('\n'), true)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a program that exits non-zero carries its own message', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    "#!/bin/sh\nfor i in $(seq 1 40); do printf 'line %d: explaining the failure\\n' \"$i\"; done\nprintf 'FINAL: the actual cause\\n' >&2\nexit 1\n",
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /FINAL: the actual cause/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a log past the buffer ceiling keeps its newest lines', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    "#!/bin/sh\nhead -c 1200000 /dev/zero | tr '\\0' 'x'\nprintf '\\nEND\\n'\n",
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.log', args: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.truncated, true)
    assert.match(answer.result ?? '', /END\n?$/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a missing docker client names the failure', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath: path.join(host.root, 'no-docker'),
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /ENOENT/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a container name that is not one is refused', async () => {
  const host = await fakeHost()
  await assert.rejects(
    startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      container: '-f',
    }),
    /container must be a docker container name/u,
  )
})

void test('capOutput keeps a tail of whole rows, never half a character', () => {
  const row = `${'x'.repeat(MAX_PATTERN_CHARS - 1)}😀\n`
  const text = row.repeat(500)
  const capped = capOutput(text, 'tail')
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.includes('\uFFFD'))
  assert.ok(capped.text.endsWith(`${'x'.repeat(MAX_PATTERN_CHARS - 1)}😀\n`))
})

void test('capOutput backs off a cut that lands inside a character', () => {
  // 65 536 bytes back from the end falls on the emoji's third byte.
  const text = `${'x'.repeat(100)}😀${'x'.repeat(MAX_OUTPUT_BYTES - 2)}`
  const capped = capOutput(text, 'tail')
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.includes('\uFFFD'))
  assert.equal(capped.text, 'x'.repeat(Buffer.byteLength(capped.text)))
})

void test('a window that starts on a surrogate half drops it, not the character', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const line = `${'x'.repeat(60)}😀${'y'.repeat(MAX_ERROR_CHARS - 1)}`
  await writeFile(dockerPath, `#!/bin/sh\nprintf '%s\\n' '${line}'\nexit 1\n`, {
    mode: 0o755,
  })
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.error?.message, 'y'.repeat(MAX_ERROR_CHARS - 1))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a tail window that is one long line is not emptied', () => {
  const text = `${'x'.repeat(MAX_LINE_BYTES * 5)}\n`
  const capped = capOutput(text, 'tail')
  assert.equal(capped.truncated, true)
  assert.ok(capped.text.length > 0)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
})

void test('a timed-out program does not leave its child behind', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const pidFile = path.join(host.root, 'child.pid')
  await writeFile(dockerPath, `#!/bin/sh\nsleep 5 &\necho $! > '${pidFile}'\nwait\n`, {
    mode: 0o755,
  })
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    // Generous: the program must start and write its pid before the deadline.
    execTimeoutMs: 2000,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(answer.error?.code, 'timeout')
    const pidText = await readFile(pidFile, 'utf8')
    const pid = Number(pidText.trim())
    assert.ok(Number.isInteger(pid) && pid > 0)
    // The group is killed before the answer; let the signal land.
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.throws(() => process.kill(pid, 0), /ESRCH/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a head op keeps the opening of a large program output', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    "#!/bin/sh\nprintf 'FIRST\\n'\nhead -c 1200000 /dev/zero | tr '\\0' 'x'\nprintf '\\n'\n",
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(answer.ok, true)
    assert.equal(answer.truncated, true)
    // A head cap keeps whole lines: the first row survives, the huge second one does not.
    assert.equal(answer.result, 'FIRST')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.recreate runs compose in the checkout and is marked confirm', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    '#!/bin/sh\nprintf "cwd=%s\\nuid=%s\\ngid=%s\\nargs=%s\\n" "$PWD" "$(printenv UID)" "$(printenv GID)" "$*"\n',
    {
      mode: 0o755,
    },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const described = await connection.request({
      op: 'ops.describe',
      args: { protocol: 1 },
    })
    const ops = describedTable(described.result).ops
    const recreate = ops.find(op => op.name === 'deploy.recreate')
    assert.equal(recreate?.confirm, true)
    assert.equal(ops.find(op => op.name === 'deploy.rollback')?.confirm, true)
    const update = ops.find(op => op.name === 'broker.update')
    assert.ok(update !== undefined)
    assert.equal(update.confirm, true)
    assert.equal(update.timeoutMs, BUILD_TIMEOUT_MS)
    assert.ok(ops.some(op => op.name === 'broker.status'))

    const main = ops.find(op => op.name === 'deploy.main')
    assert.ok(main !== undefined)
    assert.equal(main.confirm, true)
    assert.equal(main.timeoutMs, BUILD_TIMEOUT_MS)

    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /^recreate queued/u)
    // The acknowledgement is written before the deferred work runs: no log yet.
    const logPath = path.join(host.root, 'compose.log')
    await assert.rejects(readFile(logPath, 'utf8'))
    // Then the delayed launch happens, detached; poll rather than guess a delay.
    let log = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      log = await readFile(logPath, 'utf8').catch(() => '')
      if (log.includes('up -d --no-build')) {
        break
      }
    }
    assert.match(log, new RegExp(`cwd=${checkout}`, 'u'))
    assert.match(log, new RegExp(`uid=${String(process.getuid?.())}`, 'u'))
    assert.match(log, new RegExp(`gid=${String(process.getgid?.())}`, 'u'))
    assert.match(
      log,
      /args=compose -f docker-compose\.yml -f docker-compose\.dev\.yml up -d --no-build/u,
    )
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a recreate that comes up dead is rolled back and logged', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const recovered = path.join(host.root, 'recovered')
  const composed = path.join(host.root, 'composed')
  // Compose "succeeds"; the first inspect says the container exited, and the tag flips a marker so
  // the inspect after the rollback sees a running container.
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `LOG="${calls}"`,
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "$LOG"; : > "${composed}" ;;
  *"--format {{.Image}}"*) echo "${RUNNING_IMAGE}" ;;
  *"{{.Id}}"*)
    echo "WARNING: Error loading config file" >&2
    if [ -f "${recovered}" ]; then echo "rolled-back-id"; elif [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*)
    echo "WARNING: daemon deprecated flag" >&2
    echo "state $*" >> "$LOG"
    if [ -f "${recovered}" ]; then echo "status=running health=healthy image=${RUNNING_IMAGE}"; else echo "status=exited health=none image=${RUNNING_IMAGE}"; fi ;;
  "tag "*)
    echo "tag $*" >> "$LOG"; : > "${recovered}" ;;
  *) echo "other $*" >> "$LOG" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('rolled back to'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /did not come up \(status=exited health=none\); rolling back/u)
    assert.match(log, new RegExp(`rolled back to ${RUNNING_IMAGE}; dsh is up`, 'u'))
    const recorded = await readFile(calls, 'utf8')
    // The whole log, not just the state lines: a warning that leaked anywhere is the bug.
    assert.doesNotMatch(recorded, /WARNING/u)
    const reads = recorded.split(/\r?\n/u).filter(line => line.startsWith('state '))
    assert.ok(reads.length > 0, 'the state was read')
    for (const line of reads) {
      assert.doesNotMatch(line, /WARNING/u)
      assert.match(line, / (runner-id|rolled-back-id)$/u)
    }
    assert.equal(recorded.match(/compose up/gu)?.length, 2)
    assert.match(recorded, new RegExp(`tag tag ${RUNNING_IMAGE} devockr/idsh:dev`, 'u'))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a recreate with no healthcheck is not healthy, so it rolls back', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const composed = path.join(host.root, 'composed')
  const recovered = path.join(host.root, 'recovered')
  // Running, but the compose file declares no healthcheck: per the contract that is a failure.
  const script = [
    '#!/bin/sh',
    `LOG="${calls}"`,
    `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "$LOG"; : > "${composed}" ;;
  *"--format {{.Image}}"*) echo "${RUNNING_IMAGE}" ;;
  *"{{.Id}}"*) if [ -f "${recovered}" ]; then echo "rolled-back-id"; elif [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*)
    if [ -f "${recovered}" ]; then echo "status=running health=healthy image=${RUNNING_IMAGE}"; else echo "status=running health=none image=${RUNNING_IMAGE}"; fi ;;
  "tag "*) echo "tag $*" >> "$LOG"; : > "${recovered}" ;;
esac`,
  ].join('\n')
  await writeFile(dockerPath, script, { mode: 0o755 })
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('no healthcheck'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(
      log,
      /did not come up \(status=running health=none — no healthcheck is declared in the compose file\); rolling back/u,
    )
    assert.match(await readFile(calls, 'utf8'), new RegExp(`tag tag ${RUNNING_IMAGE}`, 'u'))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a recreate that is still starting is waited for, not failed', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const up = path.join(host.root, 'up')
  const composed = path.join(host.root, 'composed')
  const calls = path.join(host.root, 'calls.log')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "${calls}"; : > "${composed}" ;;
  *"{{.Id}}"*) if [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*)
    if [ -f "${up}" ]; then echo "status=running health=healthy image=${RUNNING_IMAGE}"; else echo "status=running health=starting image=${RUNNING_IMAGE}"; : > "${up}"; fi ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () => (await readFile(logPath, 'utf8').catch(() => '')).includes('is up'))
    const log = await readFile(logPath, 'utf8')
    // The first answer was "starting": the poller waited, it did not fail or roll back.
    assert.match(log, /is up \(status=running health=healthy\)/u)
    assert.doesNotMatch(log, /rolling back/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.main verifies what it recreates and rolls back when it is dead', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  const calls = path.join(host.root, 'calls.log')
  const recovered = path.join(host.root, 'recovered')
  const composed = path.join(host.root, 'composed')
  const sha = 'a'.repeat(SHA_LENGTH)
  const previousImage = `sha256:${'b'.repeat(DIGEST_LENGTH)}`
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *ls-remote*) echo "${sha} refs/heads/main" ;;
esac
exit 0
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "run "*) exit 0 ;;
  *"--format {{.Image}}"*)
    echo "WARNING: Error loading config file" >&2
    echo "${previousImage}" ;;
  *"{{.Id}}"*)
    echo "WARNING: Error loading config file" >&2
    if [ -f "${recovered}" ]; then echo "rolled-back-id"; elif [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*)
    if [ -f "${recovered}" ]; then echo "status=running health=healthy image=${previousImage}"; else echo "status=exited health=none image=${previousImage}"; fi ;;
  "tag "*) echo "tag $*" >> "${calls}"; : > "${recovered}" ;;
  "compose "*) echo "compose up" >> "${calls}"; : > "${composed}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.main', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('rolled back to'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /did not come up \(status=exited health=none\); rolling back/u)
    assert.match(log, new RegExp(`rolled back to ${previousImage}; dsh is up`, 'u'))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a compose that fails is not a successful recreate, even if the container looks fine', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const composed = path.join(host.root, 'composed')
  const recovered = path.join(host.root, 'recovered')
  const tried = path.join(host.root, 'tried')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    : > "${composed}"; echo "compose up" >> "${calls}"
    if [ -f "${tried}" ]; then exit 0; else : > "${tried}"; exit 1; fi ;;
  *"--format {{.Image}}"*) echo "${RUNNING_IMAGE}" ;;
  *"{{.Id}}"*) if [ -f "${recovered}" ]; then echo "rolled-back-id"; elif [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*) echo "status=running health=healthy image=${RUNNING_IMAGE}" ;;
  "tag "*) echo "tag $*" >> "${calls}"; : > "${recovered}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('compose exited with 1'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /did not come up \(compose exited with 1\); rolling back/u)
    // No direct-success line: the healthy container did not make the failed compose a success.
    assert.doesNotMatch(log, /^verify: dsh is up /mu)
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('rolled back to'),
    )
    // The rollback's own compose succeeded, and its outcome is what gets reported: the image that
    // was running before the failed recreate, not the older one in the recorded file.
    assert.match(
      await readFile(logPath, 'utf8'),
      new RegExp(`rolled back to ${RUNNING_IMAGE}; dsh is up`, 'u'),
    )
    assert.match(await readFile(calls, 'utf8'), new RegExp(`tag tag ${RUNNING_IMAGE}`, 'u'))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a no-op up that leaves the container alone is not a failure', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "${calls}" ;;
  "image inspect "*) echo "${RUNNING_IMAGE}" ;;
  *"{{.Id}}"*) echo "same-id" ;;
  *"--format status="*) echo "status=running health=healthy image=${RUNNING_IMAGE}" ;;
  "tag "*) echo "tag $*" >> "${calls}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    // A bind-mount-only change (a profile) leaves the container alone and compose says Running:
    // that is the documented reason to recreate, and it must not be answered with a rollback.
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('compose left'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /compose left dsh in place \(the container is unchanged\); it is up/u)
    assert.doesNotMatch(log, /rolling back/u)
    assert.doesNotMatch(await readFile(calls, 'utf8').catch(() => ''), /tag /u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a rollback whose compose fails is reported as a failure', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const composed = path.join(host.root, 'composed')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    : > "${composed}"; echo "compose up" >> "${calls}"; exit 1 ;;
  *"{{.Id}}"*) if [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*) echo "status=exited health=none image=${RUNNING_IMAGE}" ;;
  "tag "*) echo "tag $*" >> "${calls}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes("rollback's compose exited"),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /the rollback's compose exited with 1/u)
    assert.doesNotMatch(log, /rolled back to .* is up/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a recreate that ends on another image says so', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const composed = path.join(host.root, 'composed')
  const recovered = path.join(host.root, 'recovered')
  const other = `sha256:${'f'.repeat(DIGEST_LENGTH)}`
  // The image read before the swap fails, so the recorded file is the target; after the rescue the
  // container runs a different image, which is the only thing that actually says it was not restored.
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    : > "${composed}"; echo "compose up" >> "${calls}" ;;
  *"--format {{.Image}}"*) if [ -f "${composed}" ]; then echo "${other}"; fi ;;
  *"{{.Id}}"*) echo "runner-id" ;;
  *"--format status="*)
    if [ -f "${recovered}" ]; then echo "status=running health=healthy image=${other}"; else echo "status=running health=unhealthy image=${other}"; fi ;;
  "tag "*) echo "tag $*" >> "${calls}"; : > "${recovered}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('but the deployment runs'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(
      log,
      new RegExp(`rolled back to ${ROLLBACK_TARGET}, but the deployment runs ${other}`, 'u'),
    )
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a failed compose that left the running container alone restores nothing', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  // The recorded target predates the running container; compose fails without touching it.
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "${calls}"; exit 1 ;;
  *"{{.Id}}"*) echo "same-id" ;;
  *"--format status="*) echo "status=running health=healthy image=${ROLLBACK_TARGET}" ;;
  "tag "*) echo "tag $*" >> "${calls}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('nothing is rolled back'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(
      log,
      /dsh is unchanged and healthy after compose exited with 1; restoring the image already running would change nothing, so nothing is rolled back/u,
    )
    // The healthy deployment was not replaced by the older recorded image.
    assert.doesNotMatch(await readFile(calls, 'utf8').catch(() => ''), /tag /u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a recreate restores the image that was running, not the older recorded one', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const composed = path.join(host.root, 'composed')
  const recovered = path.join(host.root, 'recovered')
  const running = `sha256:${'c'.repeat(DIGEST_LENGTH)}`
  const older = `sha256:${'d'.repeat(DIGEST_LENGTH)}`
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    : > "${composed}"; echo "compose up" >> "${calls}" ;;
  *"--format {{.Image}}"*) echo "${running}" ;;
  *"{{.Id}}"*) if [ -f "${recovered}" ]; then echo "rolled-back-id"; elif [ -f "${composed}" ]; then echo "runner-id"; else echo "old-id"; fi ;;
  *"--format status="*)
    if [ -f "${recovered}" ]; then echo "status=running health=healthy image=${running}"; else echo "status=exited health=none image=${running}"; fi ;;
  "tag "*) echo "tag $*" >> "${calls}"; : > "${recovered}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  // The recorded file points at an image older than the one running now.
  await writeFile(path.join(host.root, 'rollback'), `${older}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('rolled back to'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, new RegExp(`rolled back to ${running}; dsh is up`, 'u'))
    const recorded = await readFile(calls, 'utf8')
    assert.match(recorded, new RegExp(`tag tag ${running} devockr/idsh:dev`, 'u'))
    assert.doesNotMatch(recorded, new RegExp(`tag tag ${older}`, 'u'))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a rescue to a registry digest is a success, not a mismatch', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  const composed = path.join(host.root, 'composed')
  const recovered = path.join(host.root, 'recovered')
  // A pulled deployment records a registry digest, while the container reports its image id.
  const digest = `ghcr.io/devockr/idsh@sha256:${'d'.repeat(DIGEST_LENGTH)}`
  const imageId = `sha256:${'c'.repeat(DIGEST_LENGTH)}`
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    : > "${composed}"; echo "compose up" >> "${calls}" ;;
  "image inspect "*) echo "${imageId}" ;;
  *"--format {{.Image}}"*) if [ -f "${composed}" ]; then echo "${imageId}"; fi ;;
  *"{{.Id}}"*) echo "runner-id" ;;
  *"--format status="*)
    if [ -f "${recovered}" ]; then echo "status=running health=healthy image=${imageId}"; else echo "status=exited health=none image=${imageId}"; fi ;;
  "tag "*) echo "tag $*" >> "${calls}"; : > "${recovered}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${digest}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('rolled back to'),
    )
    assert.match(
      await readFile(logPath, 'utf8'),
      new RegExp(`rolled back to ${digest}; dsh is up`, 'u'),
    )
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a rollback that leaves another image running is not called a success', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  // The compose file starts its own image: the tag moves, compose brings that image up healthy,
  // and the deployment is not the target — which must not read as "rolled back".
  const other = `sha256:${'f'.repeat(DIGEST_LENGTH)}`
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "${calls}" ;;
  "image inspect "*) echo "${ROLLBACK_TARGET}" ;;
  *"--format {{.Image}}"*) echo "${other}" ;;
  *"{{.Id}}"*) echo "runner-id" ;;
  *"--format status="*) echo "status=running health=healthy image=${other}" ;;
  "tag "*) echo "tag $*" >> "${calls}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.rollback', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes('but runs'),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(
      log,
      new RegExp(
        `is up \\(status=running health=healthy\\) but runs ${other}, not ${ROLLBACK_TARGET}`,
        'u',
      ),
    )
    assert.doesNotMatch(log, /rolled back to .*; dsh is up/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a failed compose does not spend the window waiting for a container', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  // Compose fails and no container exists: the id read must not retry for the whole window, since
  // the deploy lock is held throughout.
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose -f docker-compose.yml -f docker-compose.dev.yml up -d --no-build")
    echo "compose up" >> "${calls}"; exit 1 ;;
  "image inspect "*) echo "${ROLLBACK_TARGET}" ;;
  "tag "*) echo "tag $*" >> "${calls}" ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    // The whole test's waitFor budget is 5 s: without the single attempt this took 180 s.
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes("the rollback's compose exited"),
    )
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /did not come up \(compose exited with 1\); rolling back/u)
    assert.match(log, /the rollback's compose exited with 1/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a checkout with a broker overlay gets it between the base and the channel', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `echo "$*" >> "${calls}"
case "$*" in
  "compose "*) exit 1 ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(checkout, 'docker-compose.broker.yml'), 'services: {}\n')
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const logPath = path.join(host.root, 'compose.log')
    await waitFor(async () =>
      (await readFile(logPath, 'utf8').catch(() => '')).includes("the rollback's compose exited"),
    )
    const compose = (await readFile(calls, 'utf8'))
      .split(/\r?\n/u)
      .find(line => line.startsWith('compose '))
    assert.equal(
      compose,
      'compose -f docker-compose.yml -f docker-compose.broker.yml -f docker-compose.dev.yml up -d --no-build',
    )
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('the compose the broker spawns inherits its environment', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const calls = path.join(host.root, 'calls.log')
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `case "$*" in
  "compose "*) echo "compose-gcb=\${GCB_IMAGE:-unset}" >> "${calls}"; exit 1 ;;
esac`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(checkout, 'docker-compose.broker.yml'), 'services: {}\n')
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  const previous = process.env['GCB_IMAGE']
  process.env['GCB_IMAGE'] = 'ghcr.io/test/gcb:sha-x'
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    // The broker does not know the image; the deployment's environment has to, and compose gets it
    // from the process the broker spawned.
    await waitFor(async () =>
      (await readFile(calls, 'utf8').catch(() => '')).includes(
        'compose-gcb=ghcr.io/test/gcb:sha-x',
      ),
    )
  } finally {
    connection.close()
    await broker.close()
    if (previous === undefined) {
      delete process.env['GCB_IMAGE']
    } else {
      process.env['GCB_IMAGE'] = previous
    }
  }
})

void test('deploy.recreate without a checkout is refused', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath: path.join(host.root, 'docker'),
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /no checkout configured/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a checkout that is not a directory is refused at boot', async () => {
  const host = await fakeHost()
  const notADirectory = path.join(host.root, 'not-a-dir')
  await writeFile(notADirectory, '')
  await assert.rejects(
    startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      checkout: notADirectory,
    }),
    /--checkout must be an existing directory/u,
  )
})

void test('a failed launch is recorded and the broker keeps serving', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(dockerPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    await unlink(dockerPath)
    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true)
    const logPath = path.join(host.root, 'compose.log')
    let log = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      log = await readFile(logPath, 'utf8').catch(() => '')
      if (log.includes('spawn failed')) {
        break
      }
    }
    assert.match(log, /spawn failed/u)
    // The broker is still there: the missing client is an answer, not a crash.
    const still = await connection.request({ op: 'deploy.status', args: {} })
    assert.equal(still.ok, false)
    assert.match(JSON.stringify(still.error), /ENOENT/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.build resolves a PR, pins main and builds :dev', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const dockerLog = path.join(host.root, 'docker.log')
  const gitPath = path.join(host.root, 'git')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$*" >> '${gitLog}'
case "$*" in
  *"ls-remote origin refs/heads/*"*)
    printf 'aaaaaaaa11111111111111111111111111111111 refs/heads/main\\n'
    printf 'bbbbbbbb22222222222222222222222222222222 refs/heads/feat\\n'
    ;;
  *"ls-remote origin refs/pull/7/head"*)
    printf 'bbbbbbbb22222222222222222222222222222222 refs/pull/7/head\\n'
    ;;
  *" clone "*)
    for last; do :; done
    mkdir -p "$last"
    ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$*" in
  *"--type image"*) printf '["devockr/idsh:dev@sha256:abc"]\\n' ;;
  *inspect*) echo 'sha256:prev' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'deploy.build',
      args: { pr: 7 },
    })
    assert.equal(answer.ok, true)
    assert.match(
      answer.result ?? '',
      /^built PR #7 \(bbbbbbbb2222[^)]*\) as devockr\/idsh:dev; main aaaaaaaa1111/u,
    )
    const git = await readFile(gitLog, 'utf8')
    assert.match(git, /ls-remote origin refs\/pull\/7\/head/u)
    assert.match(
      git,
      /checkout aaaaaaaa11111111111111111111111111111111 -- Dockerfile Dockerfile\.dev entrypoint\.sh tools \.dockerignore Dockerfile\.dev\.dockerignore/u,
    )
    const docker = await readFile(dockerLog, 'utf8')
    assert.match(docker, /build --tag devockr\/idsh:dev/u)
    assert.match(docker, /--label idsh\.keep=1/u)
    assert.match(docker, /--entrypoint sh/u)
    assert.match(
      docker,
      new RegExp(`--user ${String(process.getuid?.())}:${String(process.getgid?.())}`, 'u'),
    )
    assert.match(docker, /--file .*Dockerfile\.dev/u)
    const rollback = await readFile(path.join(host.root, 'rollback'), 'utf8')
    // A pulled image's digest is the rollback target, not its local id.
    assert.equal(rollback, 'devockr/idsh:dev@sha256:abc\n')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.build refuses an ambiguous source and a fork head', async () => {
  const host = await fakeHost()
  const gitPath = path.join(host.root, 'git')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *"refs/pull/8/head"*) printf 'cccccccc33333333333333333333333333333333 refs/pull/8/head\\n' ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(dockerPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const both = await connection.request({
      op: 'deploy.build',
      args: { pr: 7, sha: 'aaaaaaaa' },
    })
    assert.equal(both.error?.code, 'bad-argument')
    assert.match(JSON.stringify(both.error), /exactly one/u)

    const fork = await connection.request({
      op: 'deploy.build',
      args: { pr: 8 },
    })
    assert.equal(fork.error?.code, 'unavailable')
    assert.match(JSON.stringify(fork.error), /not on an origin branch/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.build takes the tip of an origin branch by sha', async () => {
  const host = await fakeHost()
  const gitPath = path.join(host.root, 'git')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*)
    printf 'aaaaaaaa11111111111111111111111111111111 refs/heads/main\\n'
    printf 'bbbbbbbb22222222222222222222222222222222 refs/heads/feat\\n'
    ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$*" in
  *inspect*) echo 'sha256:prev' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'deploy.build',
      args: { sha: 'bbbbbbbb' },
    })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /^built sha bbbbbbbb/u)
    const rollback = await readFile(path.join(host.root, 'rollback'), 'utf8')
    assert.equal(rollback, 'sha256:prev\n')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a failed build still records the rollback target and its log', async () => {
  const host = await fakeHost()
  const gitPath = path.join(host.root, 'git')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  *inspect*) echo 'sha256:prev' ;;
  build) printf 'boom: the build failed\\n'; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({
      op: 'deploy.build',
      args: { sha: 'aaaaaaaa' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /boom/u)
    const rollback = await readFile(path.join(host.root, 'rollback'), 'utf8')
    assert.equal(rollback, 'sha256:prev\n')
    const log = await readFile(path.join(host.root, 'build.log'), 'utf8')
    assert.match(log, /boom: the build failed/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a planted build directory is swept at boot', async () => {
  const host = await fakeHost()
  const key = createHash('sha256').update(path.resolve(host.socketPath)).digest('hex').slice(
    0,
    // oxlint-disable-next-line no-magic-numbers -- the broker names a build root by this prefix
    16,
  )
  const junk = path.join(host.root, 'build', key, 'junk')
  await mkdir(junk, { recursive: true })
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  await broker.close()
  await assert.rejects(stat(junk))
})

void test('two sockets with the same name keep separate build roots', async () => {
  const host = await fakeHost()
  const first = await startBroker({
    socketPath: path.join(host.root, 'sock', 'a', 'host.sock'),
    auditPath: path.join(host.root, 'a.jsonl'),
    logDir: host.logDir,
    procDir: host.procDir,
  })
  try {
    const before = await readdir(path.join(host.root, 'build'))
    assert.equal(before.length, 1)
    const second = await startBroker({
      socketPath: path.join(host.root, 'sock', 'b', 'host.sock'),
      auditPath: path.join(host.root, 'b.jsonl'),
      logDir: host.logDir,
      procDir: host.procDir,
    })
    try {
      const after = await readdir(path.join(host.root, 'build'))
      assert.equal(after.length, 2)
      assert.ok(after.includes(before[0]))
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
  }
})

void test('deploy.rollback retags the recorded image and recreates', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
echo "$*"
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.rollback', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', new RegExp('^rollback queued to ' + ROLLBACK_TARGET, 'u'))
    // The tag and compose are deferred: nothing has happened when the answer arrives.
    const logPath = path.join(host.root, 'compose.log')
    await assert.rejects(readFile(logPath, 'utf8'))
    let log = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      log = await readFile(logPath, 'utf8').catch(() => '')
      if (log.includes('up -d --no-build')) {
        break
      }
    }
    assert.match(
      log,
      /compose -f docker-compose\.yml -f docker-compose\.dev\.yml up -d --no-build/u,
    )
    const docker = await readFile(dockerLog, 'utf8')
    assert.match(docker, new RegExp('tag ' + ROLLBACK_TARGET + ' devockr/idsh:dev', 'u'))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.rollback without a recorded target is refused', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    checkout: host.root,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.rollback', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /no rollback target/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.rollback refuses a rollback file with more than one line', async () => {
  const host = await fakeHost()
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\nextra\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    checkout: host.root,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.rollback', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /does not name one image/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a deployment in progress refuses a rollback until it finishes', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$1" in
  run) sleep 0.8 ;;
  inspect) echo '${ROLLBACK_TARGET}' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const building = client(host.socketPath)
  const rolling = client(host.socketPath)
  try {
    const build = building.request({
      op: 'deploy.build',
      args: { sha: 'aaaaaaaa' },
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const refused = await rolling.request({ op: 'deploy.rollback', args: {} })
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused.error), /deployment is in progress/u)
    const mainRefused = await rolling.request({ op: 'deploy.main', args: {} })
    assert.equal(mainRefused.ok, false)
    assert.match(JSON.stringify(mainRefused.error), /deployment is in progress/u)
    const built = await build
    assert.equal(built.ok, true, JSON.stringify(built.error))
    const again = await rolling.request({ op: 'deploy.rollback', args: {} })
    assert.equal(again.ok, true, JSON.stringify(again.error))
    let log = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      log = await readFile(dockerLog, 'utf8')
      if (log.includes('tag ' + ROLLBACK_TARGET)) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(log.includes('tag ' + ROLLBACK_TARGET))
    assert.ok(
      log.indexOf('build --tag devockr/idsh:dev') < log.indexOf('tag ' + ROLLBACK_TARGET),
      'the build finished before the retried rollback tagged',
    )
  } finally {
    building.close()
    rolling.close()
    await broker.close()
  }
})

void test('a deployment in progress is refused, not queued past its budget', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  run) sleep 2.5 ;;
  inspect) echo '${ROLLBACK_TARGET}' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const building = client(host.socketPath)
  const rolling = client(host.socketPath)
  try {
    const build = building.request({
      op: 'deploy.build',
      args: { sha: 'aaaaaaaa' },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    const refused = await rolling.request({ op: 'deploy.rollback', args: {} })
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused.error), /a deployment is in progress/u)
    await build
  } finally {
    building.close()
    rolling.close()
    await broker.close()
  }
})

void test('a build refuses a FIFO where its log belongs', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  inspect) echo '${ROLLBACK_TARGET}' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), `${ROLLBACK_TARGET}\n`)
  // A FIFO where the build log belongs: opening it must fail, not hold the deployment.
  execFileSync('mkfifo', [path.join(host.root, 'build.log')])
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const started = Date.now()
    const answer = await connection.request({ op: 'deploy.build', args: { sha: 'aaaaaaaa' } })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /FIFO or socket with no reader/u)
    // The nonblocking open fails immediately, not through the five-second backstop.
    assert.ok(Date.now() - started < FIFO_REFUSAL_MS)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a failed answer leaves no tag behind', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  // A directory where the audit file belongs: appending fails even when the tests run as root.
  const auditPath = path.join(host.root, 'audit-directory')
  await mkdir(auditPath)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.rollback', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /audit/u)
  } finally {
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    connection.close()
    await broker.close()
  }
  const docker = await readFile(dockerLog, 'utf8').catch(() => '')
  assert.doesNotMatch(docker, /\btag\b/u)
  await assert.rejects(readFile(path.join(host.root, 'compose.log'), 'utf8'))
})

void test('a failing tag is recorded and no compose runs', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  tag) echo 'cannot tag' >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.rollback', args: {} })
    assert.equal(answer.ok, true)
    const logPath = path.join(host.root, 'compose.log')
    let log = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      log = await readFile(logPath, 'utf8').catch(() => '')
      if (log.includes('rollback tag failed')) {
        break
      }
    }
    assert.match(log, /rollback tag failed: .*cannot tag/u)
    assert.doesNotMatch(log, /up -d --no-build/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a rollback in flight refuses a build until its work is done', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$*" in
  *"--format status="*) echo 'status=running health=healthy' ;;
  inspect*) echo '${ROLLBACK_TARGET}' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const rolling = client(host.socketPath)
  const building = client(host.socketPath)
  try {
    const rolled = await rolling.request({ op: 'deploy.rollback', args: {} })
    assert.equal(rolled.ok, true, JSON.stringify(rolled.error))
    // The deferred tag and compose are still running: a build must be refused, not queued.
    const refused = await building.request({
      op: 'deploy.build',
      args: { sha: 'aaaaaaaa' },
    })
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused.error), /deployment is in progress/u)
    await waitFor(async () => {
      const built = await building.request({
        op: 'deploy.build',
        args: { sha: 'aaaaaaaa' },
      })
      return built.ok
    })
    const log = await readFile(dockerLog, 'utf8')
    assert.ok(log.includes('tag ' + ROLLBACK_TARGET))
    assert.ok(
      log.indexOf('tag ' + ROLLBACK_TARGET) < log.indexOf('build --tag devockr/idsh:dev'),
      'the rollback tagged before the retried build rebuilt',
    )
  } finally {
    rolling.close()
    building.close()
    await broker.close()
  }
})

void test('a lost answer leaves one audit line and the work still runs', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
echo "$*"
case "$1" in
  image) sleep 0.3 ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  await writeFile(path.join(host.root, 'rollback'), ROLLBACK_TARGET + '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    checkout,
  })
  const socket = net.connect(host.socketPath)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    socket.write(JSON.stringify({ op: 'deploy.rollback', args: {} }) + '\n')
    // The broker is inside the read-only inspect; the caller goes away before the answer.
    await new Promise(resolve => setTimeout(resolve, 50))
    socket.destroy()
    const logPath = path.join(host.root, 'compose.log')
    let composed = false
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const log = await readFile(logPath, 'utf8').catch(() => '')
      if (log.includes('up -d --no-build')) {
        composed = true
        break
      }
    }
    assert.ok(composed, 'the deferred compose still runs')
    const auditText = await readFile(host.auditPath, 'utf8')
    const audit = auditText
      .trim()
      .split('\n')
      .filter(line => line !== '')
    assert.equal(audit.length, 1, audit.join('\n'))
    assert.match(audit[0] ?? '', /"op":"deploy\.rollback"/u)
    assert.match(audit[0] ?? '', /"ok":true/u)
    const docker = await readFile(dockerLog, 'utf8')
    assert.match(docker, new RegExp('tag ' + ROLLBACK_TARGET, 'u'))
  } finally {
    socket.destroy()
    await broker.close()
  }
})

void test('deploy.main builds main and recreates from it', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$1" in
  image)
    case "$2" in
      ls) printf 'sha256:old1\\nsha256:old2\\n${ROLLBACK_TARGET}\\nsha256:new\\n' ;;
      inspect)
        case "$5" in
          devockr/idsh:dev) echo "sha256:new" ;;
          *) echo "sha256:unrelated" ;;
        esac ;;
      rm) echo "removed $3" ;;
    esac ;;
  inspect) echo '${ROLLBACK_TARGET}' ;;
  compose) echo "$*" ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.main', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(
      answer.result ?? '',
      /^built main \(aaaaaaaa1[0-9a-f]*\) as devockr\/idsh:dev; recreating/u,
    )
    // The acknowledgement is written before the deferred work runs: no log yet.
    const logPath = path.join(host.root, 'compose.log')
    await assert.rejects(readFile(logPath, 'utf8'))
    let log = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      log = await readFile(logPath, 'utf8').catch(() => '')
      if (log.includes('up -d --no-build')) {
        break
      }
    }
    assert.match(
      log,
      /compose -f docker-compose\.yml -f docker-compose\.dev\.yml up -d --no-build/u,
    )
    const docker = await readFile(dockerLog, 'utf8')
    assert.match(docker, /build --tag devockr\/idsh:dev --label idsh\.keep=1/u)
    // The build retires the labelled images it made unnecessary: neither the new image nor the
    // recorded target is removed.
    assert.match(docker, /image ls --quiet --no-trunc --filter label=idsh\.keep=1/u)
    assert.match(docker, /image rm sha256:old1/u)
    assert.match(docker, /image rm sha256:old2/u)
    // The recorded target is kept even though it carries the label, and so is the new image.
    assert.doesNotMatch(docker, new RegExp(`image rm ${ROLLBACK_TARGET}`, 'u'))
    assert.doesNotMatch(docker, /image rm sha256:new/u)
    const rollback = await readFile(path.join(host.root, 'rollback'), 'utf8')
    assert.equal(rollback, ROLLBACK_TARGET + '\n')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('net.status reads the ip tables it is asked for', async () => {
  const host = await fakeHost()
  const ipPath = path.join(host.root, 'ip')
  await writeFile(
    ipPath,
    `#!/bin/sh
echo "ip $*"
`,
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    ipPath,
  })
  const connection = client(host.socketPath)
  try {
    const all = await connection.request({ op: 'net.status', args: {} })
    assert.equal(all.ok, true)
    assert.match(
      all.result ?? '',
      /## addr\nip -br addr\n## route \(ipv4\)\nip -4 -br route\n## route \(ipv6\)\nip -6 -br route\n## neigh\nip -br neigh/u,
    )

    const route = await connection.request({
      op: 'net.status',
      args: { what: 'route' },
    })
    assert.equal(route.ok, true)
    assert.equal(route.result, '## route (ipv4)\nip -4 -br route\n## route (ipv6)\nip -6 -br route')

    // An unknown string must not widen to "all": the published enum is the contract.
    const unknown = await connection.request({
      op: 'net.status',
      args: { what: 'routes' },
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error?.code, 'bad-argument')
    assert.match(JSON.stringify(unknown.error), /what must be one of/u)

    const notString = await connection.request({
      op: 'net.status',
      args: { what: 3 },
    })
    assert.equal(notString.ok, false)
    assert.equal(notString.error?.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('net.sockets reads the ss tables it is asked for', async () => {
  const host = await fakeHost()
  const ssPath = path.join(host.root, 'ss')
  await writeFile(
    ssPath,
    `#!/bin/sh
echo "ss $*"
`,
    { mode: 0o755 },
  )
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    ssPath,
  })
  const connection = client(host.socketPath)
  try {
    const all = await connection.request({ op: 'net.sockets', args: {} })
    assert.equal(all.ok, true)
    assert.match(all.result ?? '', /## listen\nss -tulpn\n## connections\nss -tunp/u)

    const listen = await connection.request({
      op: 'net.sockets',
      args: { what: 'listen' },
    })
    assert.equal(listen.result, '## listen\nss -tulpn')

    const connections = await connection.request({
      op: 'net.sockets',
      args: { what: 'connections' },
    })
    assert.equal(connections.result, '## connections\nss -tunp')

    const refused = await connection.request({
      op: 'net.sockets',
      args: { what: 'sockets' },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.status reports the broker it is asked', async () => {
  const host = await fakeHost()
  const checkout = path.join(host.root, 'checkout')
  await mkdir(path.join(checkout, 'packages', 'host-broker'), {
    recursive: true,
  })
  await writeFile(
    path.join(checkout, 'packages', 'host-broker', 'package.json'),
    '{"name":"@idsh/host-broker"}\n',
  )
  const version = (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string
    }
  ).version
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    now: () => FIXED_NOW,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.status', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const fields = new Map(
      (answer.result ?? '').split('\n').map(line => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)] as const
      }),
    )
    assert.equal(fields.get('version'), version)
    assert.equal(fields.get('pid'), String(process.pid))
    assert.equal(fields.get('started'), new Date(FIXED_NOW).toISOString())
    assert.equal(fields.get('socket'), host.socketPath)
    assert.equal(fields.get('audit'), host.auditPath)
    assert.equal(fields.get('checkout'), checkout)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update runs the checkout steps and stops', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const pnpmLog = path.join(host.root, 'pnpm.log')
  const gitPath = path.join(host.root, 'git')
  const pnpmPath = path.join(host.root, 'pnpm')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
    { mode: 0o755 },
  )
  await writeFile(
    pnpmPath,
    `#!/bin/sh
echo "$PWD $*" >> '${pnpmLog}'
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(path.join(checkout, 'packages', 'host-broker'), {
    recursive: true,
  })
  await writeFile(
    path.join(checkout, 'packages', 'host-broker', 'package.json'),
    '{"name":"@idsh/host-broker"}\n',
  )
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath,
    checkout,
    entryPath: path.join(checkout, 'packages', 'host-broker', 'lib', 'cli.js'),
    stop: () => {
      stopped += 1
    },
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from checkout/u)
    assert.match(await readFile(gitLog, 'utf8'), /checkout pull --ff-only$/mu)
    const pnpm = await readFile(pnpmLog, 'utf8')
    assert.match(pnpm, /checkout install --frozen-lockfile/u)
    assert.match(pnpm, /checkout --filter @idsh\/host-broker build/u)
    assert.ok(
      pnpm.indexOf('install --frozen-lockfile') < pnpm.indexOf('--filter @idsh/host-broker build'),
      'install must come before the build',
    )
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    assert.equal(stopped, 1)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update follows a checkout reached through a symlink', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
    { mode: 0o755 },
  )
  const real = path.join(host.root, 'checkout')
  // The entry itself has to exist: a path that does not resolve falls back to `path.resolve`, and
  // then the test would prove only the checkout half of the comparison.
  const entryPath = path.join(real, 'packages', 'host-broker', 'lib', 'cli.js')
  await mkdir(path.dirname(entryPath), { recursive: true })
  await writeFile(entryPath, '\n')
  // The deployment's checkout is reached through a symlink; the process resolves to the real tree.
  const linked = path.join(host.root, 'linked')
  await symlink(real, linked, 'dir')
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath: gitPath,
    checkout: linked,
    entryPath,
    stop: () => {
      stopped += 1
    },
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from checkout/u)
    assert.match(await readFile(gitLog, 'utf8'), /pull --ff-only$/mu)
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    assert.equal(stopped, 1)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update follows a dangling entry link into the checkout', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
    { mode: 0o755 },
  )
  const real = path.join(host.root, 'checkout')
  const target = path.join(real, 'packages', 'host-broker', 'lib', 'cli.js')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, '\n')
  // A `link:` install outside the checkout points in; the target is then removed, so the link is
  // what names the tree rather than what it points at.
  const entryPath = path.join(host.root, 'installed', 'cli.js')
  await mkdir(path.dirname(entryPath), { recursive: true })
  await symlink(target, entryPath, 'file')
  await rm(target)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath: gitPath,
    checkout: real,
    entryPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from checkout/u)
    assert.match(await readFile(gitLog, 'utf8'), /pull --ff-only$/mu)
  } finally {
    connection.close()
    await broker.close()
  }
})

// Two shapes of "the thing the broker runs from is gone": the file alone, and the directory that
// held it. The first needs one ancestor lookup, the second two, so both are pinned through one body.
for (const [gone, remove] of [
  ['the entry is gone', (entryPath: string): Promise<void> => rm(entryPath)],
  [
    'the entry directory is gone',
    (entryPath: string): Promise<void> => rm(path.dirname(entryPath), { recursive: true }),
  ],
] as const) {
  void test(`broker.update resolves a symlinked checkout when ${gone}`, async () => {
    const host = await fakeHost()
    const gitLog = path.join(host.root, 'git.log')
    const gitPath = path.join(host.root, 'git')
    await writeFile(
      gitPath,
      `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
      { mode: 0o755 },
    )
    const real = path.join(host.root, 'checkout')
    await mkdir(real, { recursive: true })
    const linked = path.join(host.root, 'linked')
    await symlink(real, linked, 'dir')
    // Named through the symlink on purpose: once the target is gone, a lexical `path.resolve` of
    // this name cannot be placed in the real tree, which is what makes the ancestor walk the way
    // back.
    const entryPath = path.join(linked, 'packages', 'host-broker', 'lib', 'cli.js')
    await mkdir(path.dirname(entryPath), { recursive: true })
    await writeFile(entryPath, '\n')
    // Removed after the broker started from it, the way a rebuild that cleaned `lib/` leaves it.
    await remove(entryPath)
    const broker = await startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
      gitPath,
      pnpmPath: gitPath,
      checkout: real,
      entryPath,
    })
    const connection = client(host.socketPath)
    try {
      const answer = await connection.request({ op: 'broker.update', args: {} })
      assert.equal(answer.ok, true, JSON.stringify(answer.error))
      assert.match(answer.result ?? '', /^updated from checkout/u)
      assert.match(await readFile(gitLog, 'utf8'), /pull --ff-only$/mu)
    } finally {
      connection.close()
      await broker.close()
    }
  })
}

void test('broker.update reads a relative link target through the real directory', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
    { mode: 0o755 },
  )
  const real = path.join(host.root, 'checkout')
  const target = path.join(real, 'packages', 'host-broker', 'lib', 'cli.js')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, '\n')
  // The link lives under a directory reached through a symlink of its own, and points at its target
  // relatively. The alias sits at a *different depth* than its target on purpose: at equal depth
  // both spellings walk up to the same place, and the test would pass with a lexical parent.
  const aliasTarget = path.join(host.root, 'installed', 'deep', 'dir')
  await mkdir(aliasTarget, { recursive: true })
  const aliasParent = path.join(host.root, 'alias')
  await symlink(aliasTarget, aliasParent, 'dir')
  const entryPath = path.join(aliasParent, 'cli.js')
  // From the real directory (`installed/deep/dir`) the checkout is four levels up; from the lexical
  // one (`alias`) the same spelling points outside the tree.
  await symlink('../../../checkout/packages/host-broker/lib/cli.js', entryPath, 'file')
  await rm(target)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath: gitPath,
    checkout: real,
    entryPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from checkout/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update treats a directory whose name starts with dots as inside', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  // `..build` is a child of the checkout; only `..` itself is outside, not a name that starts
  // with the same two characters.
  const entryPath = path.join(checkout, '..build', 'lib', 'cli.js')
  await mkdir(path.dirname(entryPath), { recursive: true })
  await writeFile(entryPath, '\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath: gitPath,
    checkout,
    entryPath,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from checkout/u)
    assert.match(await readFile(gitLog, 'utf8'), /pull --ff-only$/mu)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update follows an entry reached through a symlink', async () => {
  const host = await fakeHost()
  const gitLog = path.join(host.root, 'git.log')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
echo "$PWD $*" >> '${gitLog}'
`,
    { mode: 0o755 },
  )
  const real = path.join(host.root, 'checkout')
  const entryPath = path.join(real, 'packages', 'host-broker', 'lib', 'cli.js')
  await mkdir(path.dirname(entryPath), { recursive: true })
  await writeFile(entryPath, '\n')
  // The other direction: the checkout is the real path and the process was started through a
  // `link:`-style install, so the entry is what needs resolving.
  const linked = path.join(host.root, 'node_modules', '@idsh', 'host-broker')
  await mkdir(path.dirname(linked), { recursive: true })
  await symlink(path.join(real, 'packages', 'host-broker'), linked, 'dir')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath: gitPath,
    checkout: real,
    entryPath: path.join(linked, 'lib', 'cli.js'),
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from checkout/u)
    assert.match(await readFile(gitLog, 'utf8'), /pull --ff-only$/mu)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a failed broker.update answers the failure and keeps running', async () => {
  const host = await fakeHost()
  const gitPath = path.join(host.root, 'git')
  const pnpmPath = path.join(host.root, 'pnpm')
  await writeFile(gitPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(
    pnpmPath,
    `#!/bin/sh
case "$*" in
  *install*) echo 'registry down' >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(path.join(checkout, 'packages', 'host-broker'), {
    recursive: true,
  })
  await writeFile(
    path.join(checkout, 'packages', 'host-broker', 'package.json'),
    '{"name":"@idsh/host-broker"}\n',
  )
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    gitPath,
    pnpmPath,
    checkout,
    entryPath: path.join(checkout, 'packages', 'host-broker', 'lib', 'cli.js'),
    stop: () => {
      stopped += 1
    },
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /registry down/u)
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    assert.equal(stopped, 0)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update without a checkout uses the published package', async () => {
  const host = await fakeHost()
  const npmLog = path.join(host.root, 'npm.log')
  const npmPath = path.join(host.root, 'npm')
  await writeFile(
    npmPath,
    `#!/bin/sh
echo "$*" >> '${npmLog}'
`,
    { mode: 0o755 },
  )
  const prefix = path.join(host.root, 'prefix')
  await mkdir(path.join(prefix, 'bin'), { recursive: true })
  // A checkout is present, but the broker runs from <prefix>/bin: the comparison decides.
  const checkout = path.join(host.root, 'checkout')
  await mkdir(path.join(checkout, 'packages', 'host-broker'), {
    recursive: true,
  })
  await writeFile(
    path.join(checkout, 'packages', 'host-broker', 'package.json'),
    '{"name":"@idsh/host-broker"}',
  )
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    npmPath,
    checkout,
    entryPath: path.join(prefix, 'bin', 'idsh-host'),
    stop: () => {
      stopped += 1
    },
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /^updated from npm/u)
    const npmText = await readFile(npmLog, 'utf8')
    const npm = npmText.trim()
    assert.equal(npm, `install --global --prefix ${prefix} @idsh/host-broker@latest`)
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    assert.equal(stopped, 1)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a deployment in flight refuses a broker update', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const pnpmPath = path.join(host.root, 'pnpm')
  const pnpmLog = path.join(host.root, 'pnpm.log')
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$*" in
  *"--format status="*) echo 'status=running health=healthy' ;;
  inspect*) echo 'sha256:pre vious' ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    pnpmPath,
    `#!/bin/sh
echo "$*" >> '${pnpmLog}'
`,
    { mode: 0o755 },
  )
  const gitPath = path.join(host.root, 'git')
  await writeFile(gitPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const checkout = path.join(host.root, 'checkout')
  await mkdir(path.join(checkout, 'packages', 'host-broker'), {
    recursive: true,
  })
  await writeFile(
    path.join(checkout, 'packages', 'host-broker', 'package.json'),
    '{"name":"@idsh/host-broker"}\n',
  )
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    pnpmPath,
    checkout,
    entryPath: path.join(checkout, 'packages', 'host-broker', 'lib', 'cli.js'),
    stop: () => {
      stopped += 1
    },
  })
  const deployment = client(host.socketPath)
  const admin = client(host.socketPath)
  try {
    const recreate = await deployment.request({
      op: 'deploy.recreate',
      args: {},
    })
    assert.equal(recreate.ok, true, JSON.stringify(recreate.error))
    // The recreate's compose is still running: the update must be refused, not queued.
    const refused = await admin.request({ op: 'broker.update', args: {} })
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused.error), /deployment is in progress/u)
    await waitFor(async () => {
      const allowed = await admin.request({ op: 'broker.update', args: {} })
      return allowed.ok
    })
    await waitFor(async () => stopped >= 1)
    assert.equal(stopped, 1)
  } finally {
    deployment.close()
    admin.close()
    await broker.close()
  }
})

void test('an update drains the request in flight before it stops', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  const pnpmPath = path.join(host.root, 'pnpm')
  await writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  logs) sleep 1 ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(gitPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(pnpmPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const checkout = path.join(host.root, 'checkout')
  await mkdir(path.join(checkout, 'packages', 'host-broker'), {
    recursive: true,
  })
  await writeFile(
    path.join(checkout, 'packages', 'host-broker', 'package.json'),
    '{"name":"@idsh/host-broker"}\n',
  )
  await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    pnpmPath,
    checkout,
    entryPath: path.join(checkout, 'packages', 'host-broker', 'lib', 'cli.js'),
  })
  const slow = client(host.socketPath)
  const admin = client(host.socketPath)
  try {
    // One connection is inside a slow answer when the update is answered on another.
    const pending = slow.request({ op: 'deploy.log', args: { lines: 5 } })
    await new Promise(resolve => setTimeout(resolve, 100))
    const updated = await admin.request({ op: 'broker.update', args: {} })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    const slowAnswer = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('the slow answer was lost'))
        }, 3600)
      }),
    ])
    assert.equal(slowAnswer.ok, true, JSON.stringify(slowAnswer.error))

    // The shutdown destroys the sockets and unlinks the path once the slow answer is done.
    let gone = false
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const present = await stat(host.socketPath).then(
        () => true,
        () => false,
      )
      if (!present) {
        gone = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(gone, 'the socket stays after the shutdown')

    const auditText = await readFile(host.auditPath, 'utf8')
    const lines = auditText.trim().split('\n')
    assert.equal(lines.length, 2, auditText)
    // The update answers first; the slow request's line follows once it is drained.
    assert.ok(
      lines.some(line => /"op":"deploy\.log".*"ok":true/u.test(line)),
      auditText,
    )
    assert.ok(
      lines.some(line => /"op":"broker\.update".*"ok":true/u.test(line)),
      auditText,
    )
  } finally {
    slow.close()
    admin.close()
  }
})

void test('broker.update derives the prefix from a package path', async () => {
  const host = await fakeHost()
  const npmLog = path.join(host.root, 'npm.log')
  const npmPath = path.join(host.root, 'npm')
  await writeFile(
    npmPath,
    `#!/bin/sh
echo "$*" >> '${npmLog}'
`,
    { mode: 0o755 },
  )
  const prefix = path.join(host.root, 'prefix')
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    npmPath,
    entryPath: path.join(prefix, 'lib', 'node_modules', '@idsh', 'host-broker', 'lib', 'cli.js'),
    stop: () => {
      stopped += 1
    },
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const npmText = await readFile(npmLog, 'utf8')
    assert.equal(npmText.trim(), `install --global --prefix ${prefix} @idsh/host-broker@latest`)
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    assert.equal(stopped, 1)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('broker.update refuses an entry it cannot place in a prefix', async () => {
  const host = await fakeHost()
  const npmLog = path.join(host.root, 'npm.log')
  const npmPath = path.join(host.root, 'npm')
  await writeFile(
    npmPath,
    `#!/bin/sh
echo "$*" >> '${npmLog}'
`,
    { mode: 0o755 },
  )
  let stopped = 0
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    npmPath,
    // Neither <prefix>/bin/ nor <prefix>/lib/node_modules/: no prefix to install into.
    entryPath: path.join(host.root, 'opt', 'odd', 'cli.js'),
    stop: () => {
      stopped += 1
    },
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'broker.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /cannot tell which npm prefix/u)
    await assert.rejects(readFile(npmLog, 'utf8'))
    await new Promise(resolve => setTimeout(resolve, FLUSH_MS))
    assert.equal(stopped, 0)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('proc.list reads the process table, biggest resident set first', async () => {
  const host = await fakeHost()
  const procDir = path.join(host.root, 'proc')
  for (const pid of [
    '10',
    '20',
    '30',
    '40',
    '50',
    '60',
    '61',
    '41',
    '42',
    '44',
    '45',
    '46',
    '47',
  ]) {
    await mkdir(path.join(procDir, pid), { recursive: true })
  }
  const stat = (pid: string, comm: string, state: string, ppid: number) =>
    `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
`
  // A process that exited between its stat and its status: skipped, not an error.
  await writeFile(path.join(procDir, '30', 'stat'), stat('30', 'gone', 'S', 1))
  await writeFile(path.join(procDir, '10', 'stat'), stat('10', 'small', 'S', 1))
  await writeFile(path.join(procDir, '10', 'status'), 'VmRSS:\t  1200 kB\n')
  await writeFile(path.join(procDir, '20', 'stat'), stat('20', 'big one', 'R', 1))
  await writeFile(path.join(procDir, '20', 'status'), 'VmRSS:\t  4096 kB\n')
  // A comm with an inner ')' proves the parse uses the last one: 'sd) pam' survives.
  await writeFile(
    path.join(procDir, '40', 'stat'),
    '40 (sd) pam) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
  )
  await writeFile(path.join(procDir, '40', 'status'), 'VmRSS:\t  10 kB\n')
  // A comm cannot forge a row: control characters become spaces.
  await writeFile(
    path.join(procDir, '50', 'stat'),
    stat('50', 'evil\n   1       1 S      9999 spoofed', 'S', 1),
  )
  await writeFile(path.join(procDir, '50', 'status'), 'VmRSS:\t  5 kB\n')
  // Equal resident sets are ordered by pid.
  for (const pid of ['60', '61']) {
    await writeFile(path.join(procDir, pid, 'stat'), stat(pid, 'same', 'S', 1))
    await writeFile(path.join(procDir, pid, 'status'), 'VmRSS:\t  500 kB\n')
  }
  // A stat with nothing after the comm, and a non-numeric parent: both rows are dropped.
  await writeFile(path.join(procDir, '41', 'stat'), '41 (empty)')
  await writeFile(path.join(procDir, '41', 'status'), 'VmRSS:\t  3 kB\n')
  await writeFile(path.join(procDir, '42', 'stat'), '42 (badppid) S xx 1 0')
  await writeFile(path.join(procDir, '42', 'status'), 'VmRSS:\t  4 kB\n')
  // A line separator (U+2028) folds to a space too: a renderer would draw it as a line break.
  await writeFile(path.join(procDir, '45', 'stat'), stat('45', 'line\u2028sep', 'S', 1))
  await writeFile(path.join(procDir, '45', 'status'), 'VmRSS:\t  9 kB\n')
  // A paragraph separator (U+2029) folds as well.
  await writeFile(path.join(procDir, '46', 'stat'), stat('46', 'para\u2029sep', 'S', 1))
  await writeFile(path.join(procDir, '46', 'status'), 'VmRSS:\t  7 kB\n')
  // Format controls (Cf) are kept on purpose: ZWJ is one, and emoji names depend on it.
  await writeFile(path.join(procDir, '47', 'stat'), stat('47', 'a\u200Db', 'S', 1))
  await writeFile(path.join(procDir, '47', 'status'), 'VmRSS:\t  6 kB\n')
  // A printable Unicode name keeps its characters; only control characters are replaced.
  await writeFile(path.join(procDir, '44', 'stat'), stat('44', '中文', 'S', 1))
  await writeFile(path.join(procDir, '44', 'status'), 'VmRSS:\t  8 kB\n')
  // A directory whose name is not a pid has a valid stat: only the filter can exclude it.
  await mkdir(path.join(procDir, 'not-a-pid'), { recursive: true })
  await writeFile(path.join(procDir, 'not-a-pid', 'stat'), stat('1', 'nope', 'S', 1))
  await writeFile(path.join(procDir, 'not-a-pid', 'status'), 'VmRSS:\t  7 kB\n')
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'proc.list', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const lines = (answer.result ?? '').split('\n')
    // Byte-for-byte, because a whitespace-tolerant match hides a column that is off by one.
    assert.equal(lines[0], '    pid    ppid s    rssKiB comm')
    // Exact rows: a whitespace-tolerant match would let the whole table drift.
    assert.equal(lines[1], '     20       1 R      4096 big one')
    assert.equal(lines[2], '     10       1 S      1200 small')
    assert.equal(lines[3], '     60       1 S       500 same')
    assert.equal(lines[4], '     61       1 S       500 same')
    // The closing paren survives, and the newline in comm became a space.
    assert.equal(lines[5], '     40       1 S        10 sd) pam')
    assert.equal(lines[6], '     45       1 S         9 line sep')
    assert.equal(lines[7], '     44       1 S         8 中文')
    assert.equal(lines[8], '     46       1 S         7 para sep')
    // U+200D (ZWJ) survives: format controls are a deliberate pass-through.
    assert.equal(lines[9], '     47       1 S         6 a\u200Db')
    assert.equal(lines[10], '     50       1 S         5 evil    1       1 S      9999 spoofed')
    assert.equal(
      lines.length,
      // oxlint-disable-next-line no-magic-numbers -- the fixture below has this many rows
      11,
    )
    assert.ok(lines.every(line => !line.includes('nope')))

    // Two calls answer the same bytes, ties included.
    const again = await connection.request({ op: 'proc.list', args: {} })
    assert.equal(again.result, answer.result)

    const one = await connection.request({
      op: 'proc.list',
      args: { lines: 1 },
    })
    assert.equal((one.result ?? '').split('\n').length, 2)

    for (const lines of [0, MAX_PROC_LINES + 1]) {
      const refused = await connection.request({
        op: 'proc.list',
        args: { lines },
      })
      assert.equal(refused.ok, false)
      assert.equal(refused.error?.code, 'bad-argument')
    }
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('proc.list defaults to twenty rows', async () => {
  const host = await fakeHost()
  const procDir = path.join(host.root, 'proc')
  for (let pid = 1; pid <= 30; pid += 1) {
    const dir = path.join(procDir, String(pid))
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'stat'),
      `${String(pid)} (p) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`,
    )
    await writeFile(path.join(dir, 'status'), 'VmRSS:\t  1 kB\n')
  }
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'proc.list', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    // A header and twenty rows: the documented default, not "as many as fit".
    assert.equal((answer.result ?? '').split('\n').length, DEFAULT_PROC_LINES + 1)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('proc.list answers unavailable when /proc is not readable', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: path.join(host.root, 'missing-proc'),
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'proc.list', args: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.error?.code, 'unavailable')
  } finally {
    connection.close()
    await broker.close()
  }
})

/**
 * Runs `work` with a sentinel UID/GID in the environment, so an inherited value cannot pass for
 * one.
 */
async function withAmbientUid<T>(work: () => Promise<T>): Promise<T> {
  const previous = { uid: process.env['UID'], gid: process.env['GID'] }
  process.env['UID'] = 'ambient-uid'
  process.env['GID'] = 'ambient-gid'
  try {
    return await work()
  } finally {
    for (const [name, value] of [
      ['UID', previous.uid],
      ['GID', previous.gid],
    ] as const) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

interface GcbRig {
  host: FakeHost
  connection: ReturnType<typeof client>
  /** Every docker invocation the fake recorded, one per line. */
  calls(): Promise<string>
  /** The pin file, when the rig also configured the host half. */
  pinFile?: string
  /** The pid file and staged export, when the rig also configured the host half. */
  pidFile?: string
  stagedFile?: string
  close(): Promise<void>
}

/** A broker configured for `gcb.update`, with a fake docker whose arms a test can replace. */
async function gcbRig(
  stub: {
    services?: string
    images?: string
    config?: string
    build?: string
    up?: string
    ps?: string
    inspect?: string
    probe?: string
    /** How many compose files to configure; more than one exercises the base-plus-overlay form. */
    files?: number
    /** Configure the host half too, so a failure can be checked against its pin. */
    host?: boolean
    /** The client image to configure; its build can fail through `clientBuild`. */
    clientImage?: string
    clientBuild?: string
    /** What the running service's image id is read as, for the restore path. */
    previousImage?: string
    /** How the restore's `docker tag` ends, e.g. `exit 1` to make the restore fail. */
    tag?: string
  } = {},
): Promise<GcbRig> {
  const host = await fakeHost()
  const recorded = path.join(host.root, 'calls.log')
  const replaced = path.join(host.root, 'replaced')
  const dockerPath = path.join(host.root, 'docker')
  const arm = (name: string, body: string | undefined, fallback: string): string =>
    `  *"${name}"*) ${body ?? fallback} ;;`
  await writeFile(
    dockerPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(recorded)}`,
      // Compose interpolates \${UID}/\${GID}; a compose call without them fails here, the way it
      // fails for real when the broker's environment lacks them.
      'case "$*" in compose*) if [ -z "$UID" ] || [ -z "$GID" ] || [ "$UID" = ambient-uid ] || [ "$GID" = ambient-gid ]; then echo "required variable UID is missing a value" >&2; exit 1; fi; printf \'identity uid=%s gid=%s\\n\' "$UID" "$GID" >> ' +
        JSON.stringify(recorded) +
        ' ;; esac',
      'case "$*" in',
      arm('config --services', stub.services, 'echo gcb'),
      arm('config --images', stub.images, 'echo "code-vaults/gcb-host:dev"'),
      arm('config --format json', stub.config, `echo '{"services":{"gcb":{}}}'`),
      arm('up -d --no-deps', stub.up, `touch ${JSON.stringify(replaced)}; exit 0`),
      arm('build --target client', stub.clientBuild, 'exit 0'),
      arm('build --target', stub.build, 'exit 0'),
      arm(
        'ps -q',
        stub.ps,
        `if [ -e ${JSON.stringify(replaced)} ]; then echo def456; else echo abc123; fi`,
      ),
      arm('gcb probe', stub.probe, 'exit 0'),
      arm('inspect --format {{.Image}}', stub.previousImage, 'echo oldimage'),
      arm('tag ', stub.tag, 'exit 0'),
      arm('inspect', stub.inspect, 'echo "running healthy"'),
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    [
      '#!/bin/sh',
      `printf 'git %s\n' "$*" >> ${JSON.stringify(recorded)}`,
      // `gcb.update` reads the commit it pins the host broker to, and whether an ssh command is
      // configured before it pulls.
      'case "$*" in',
      // git exits 1 for a key that is not set — the branch the operation must read as "unset".
      '  *"status --porcelain"*) if [ -n "$FAIL_STATUS" ]; then echo "status is unreadable" >&2; exit 2; fi; printf "%s" "${STATUS:-}" ;;',
      '  *"config --get core.sshCommand"*) if [ -n "$FAIL_CONFIG" ]; then echo "config is unreadable" >&2; exit 2; fi; if [ "${CORE_SSH+x}" != x ]; then exit 1; fi; printf "%s" "$CORE_SSH" ;;',
      '  *"fetch --prune origin"*) if [ -n "$FAIL_PULL" ]; then echo "no route to the remote" >&2; exit 1; fi; printf "ssh=%s gitdir=%s wrapper=%s\\n" "${GIT_SSH_COMMAND:-none}" "${GIT_DIR-unset}" "${GIT_SSH:-none}" >> ' +
        JSON.stringify(recorded) +
        ' ;;',
      '  *"checkout --detach --quiet origin/main"*) : ;;',
      '  *"rev-parse HEAD"*) printf "%s" "${SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const gcbCheckout = path.join(host.root, 'gcb')
  const deployDir = stub.host === true ? path.join(host.root, '.broker-host') : undefined
  // `c` is not the fake git's commit (`a`), so a pin write is a visible change.
  const oldSha = 'c'.repeat(COMMIT_CHARS)
  if (deployDir !== undefined) {
    await mkdir(path.join(deployDir, 'app'), { recursive: true })
    await writeFile(path.join(deployDir, 'app.ref'), `${oldSha}\n`)
    await writeFile(path.join(deployDir, 'app', 'STAGED.json'), JSON.stringify({ sha: oldSha }))
  }
  const gcbComposeFiles = Array.from({ length: stub.files ?? 1 }, (_, index) =>
    path.join(host.root, `gcb-compose-${String(index)}.yml`),
  )
  await mkdir(gcbCheckout)
  for (const file of gcbComposeFiles) {
    await writeFile(file, 'services: {}\n')
  }
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    gcbCheckout,
    gcbCompose: gcbComposeFiles.join(','),
    gcbProbeRepo: 'devockr/idsh',
    ...(stub.clientImage === undefined ? {} : { gcbClientImage: stub.clientImage }),
    ...(deployDir === undefined ? {} : { gcbDeployDir: deployDir, gcbHostUpdate: true }),
  })
  const connection = client(host.socketPath)
  return {
    host,
    connection,
    ...(deployDir === undefined
      ? {}
      : {
          pinFile: path.join(deployDir, 'app.ref'),
          pidFile: path.join(deployDir, 'gcb-host.pid'),
          stagedFile: path.join(deployDir, 'app', 'STAGED.json'),
        }),
    calls: () => readFile(recorded, 'utf8'),
    async close() {
      connection.close()
      await broker.close()
    },
  }
}

/** A live process whose command line names the deployment's staged CLI, for the ownership check. */
function startFakeDaemon(deployDir: string): { pid: number; stop(): void } {
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', cli], {
    stdio: 'ignore',
  })
  return { pid: child.pid ?? 0, stop: () => child.kill() }
}

void test('gcb.allow edits the file the daemon reports', async () => {
  const rig = await gcbRig({ host: true })
  const deployDir = path.dirname(rig.pinFile ?? '')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  const recorded = path.join(rig.host.root, 'allow.log')
  const reported = path.join(rig.host.root, 'reported-broker.yml')
  await mkdir(path.dirname(cli), { recursive: true })
  await writeFile(reported, 'hosts: {}\n')
  const daemon = startFakeDaemon(deployDir)
  await writeFile(path.join(deployDir, 'gcb-host.pid'), `${String(daemon.pid)}\n`)
  await writeFile(
    cli,
    `const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'host' && args[1] === 'status') {
  process.stdout.write(JSON.stringify([{ pid: ${String(daemon.pid)}, config: ${JSON.stringify(reported)} }]))
} else {
  fs.writeFileSync(${JSON.stringify(recorded)}, args.join(' '))
}
`,
  )
  try {
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const argv = await readFile(recorded, 'utf8')
    assert.ok(argv.endsWith(` --config ${reported}`), argv)
  } finally {
    daemon.stop()
    await rig.close()
  }
})

void test('gcb.allow changes one entry through the staged host CLI', async () => {
  const rig = await gcbRig({ host: true })
  const deployDir = path.dirname(rig.pinFile ?? '')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  const recorded = path.join(rig.host.root, 'allow.log')
  await mkdir(path.dirname(cli), { recursive: true })
  await mkdir(path.join(deployDir, 'config'), { recursive: true })
  await writeFile(path.join(deployDir, 'config', 'broker.config.yml'), 'hosts: {}\n')
  const daemon = startFakeDaemon(deployDir)
  await writeFile(path.join(deployDir, 'gcb-host.pid'), `${String(daemon.pid)}\n`)
  await writeFile(
    cli,
    `const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'host' && args[1] === 'status') {
  process.stdout.write(JSON.stringify([{ pid: ${String(daemon.pid)}, config: ${JSON.stringify(path.join(deployDir, 'config', 'broker.config.yml'))} }]))
} else {
  fs.writeFileSync(${JSON.stringify(recorded)}, args.join(' '))
}
`,
  )
  try {
    const described = await rig.connection.request({ op: 'ops.describe', args: { protocol: 1 } })
    const describedOp = describedTable(described.result).ops.find(op => op.name === 'gcb.allow')
    assert.equal(describedOp?.confirm, true)
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /allowed github\.com\/un-ts\/sh-syntax/u)
    const argv = await readFile(recorded, 'utf8')
    assert.match(argv, /config allow add github\.com un-ts\/sh-syntax --config /u)
    assert.match(argv, /config\/broker\.config\.yml$/u)
  } finally {
    daemon.stop()
    await rig.close()
  }
})

void test('gcb.allow is not offered without the host half', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const described = await connection.request({ op: 'ops.describe', args: { protocol: 1 } })
    const ops = describedTable(described.result).ops
    assert.equal(
      ops.find(op => op.name === 'gcb.allow'),
      undefined,
    )
    const answer = await connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.error?.code, 'unknown-op')
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('gcb.allow names a status that reports a null configuration', async () => {
  const rig = await gcbRig({ host: true })
  const deployDir = path.dirname(rig.pinFile ?? '')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  await mkdir(path.dirname(cli), { recursive: true })
  const daemon = startFakeDaemon(deployDir)
  await writeFile(path.join(deployDir, 'gcb-host.pid'), `${String(daemon.pid)}\n`)
  await writeFile(
    cli,
    `process.stdout.write(JSON.stringify([{ pid: ${String(daemon.pid)}, config: null }]))\n`,
  )
  try {
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /reports no configuration for pid/u)
  } finally {
    daemon.stop()
    await rig.close()
  }
})

void test('gcb.allow names a failed host status', async () => {
  const rig = await gcbRig({ host: true })
  const deployDir = path.dirname(rig.pinFile ?? '')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  await mkdir(path.dirname(cli), { recursive: true })
  const daemon = startFakeDaemon(deployDir)
  await writeFile(path.join(deployDir, 'gcb-host.pid'), `${String(daemon.pid)}\n`)
  await writeFile(cli, 'process.stderr.write("no socket"); process.exit(1)\n')
  try {
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /gcb host status failed: .*no socket/u)
  } finally {
    daemon.stop()
    await rig.close()
  }
})

void test('gcb.allow names a pid that is not this deployment', async () => {
  const rig = await gcbRig({ host: true })
  const deployDir = path.dirname(rig.pinFile ?? '')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  await mkdir(path.dirname(cli), { recursive: true })
  await writeFile(cli, 'process.exit(0)\n')
  const foreign = spawn('sh', ['-c', 'sleep 60'], { stdio: 'ignore' })
  await writeFile(path.join(deployDir, 'gcb-host.pid'), `${String(foreign.pid)}\n`)
  try {
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /does not run from this deployment/u)
  } finally {
    foreign.kill()
    await rig.close()
  }
})

void test('gcb.allow names a status that has no entry for the pid', async () => {
  const rig = await gcbRig({ host: true })
  const deployDir = path.dirname(rig.pinFile ?? '')
  const cli = path.join(deployDir, 'app', 'packages', 'host', 'bin', 'gcb.js')
  await mkdir(path.dirname(cli), { recursive: true })
  const daemon = startFakeDaemon(deployDir)
  await writeFile(path.join(deployDir, 'gcb-host.pid'), `${String(daemon.pid)}\n`)
  await writeFile(
    cli,
    `process.stdout.write(JSON.stringify([{ pid: 1, config: '/x' }, { pid: 2, config: '/y' }]))\n`,
  )
  try {
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'add', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, false)
    const message = JSON.stringify(answer.error)
    assert.match(message, /has no entry for pid \d+/u)
    assert.match(message, /it reports 1, 2/u)
    assert.match(message, /gcb-host\.pid stale/u)
  } finally {
    daemon.stop()
    await rig.close()
  }
})

void test('gcb.allow names a staged CLI that is missing', async () => {
  const rig = await gcbRig({ host: true })
  try {
    const answer = await rig.connection.request({
      op: 'gcb.allow',
      args: { action: 'remove', repo: 'un-ts/sh-syntax' },
    })
    assert.equal(answer.ok, false)
    assert.match(
      JSON.stringify(answer.error),
      /is not staged; start the broker with --gcb-host and --gcb-checkout/u,
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update is offered only when its three values are configured', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
  })
  const connection = client(host.socketPath)
  try {
    const described = await connection.request({
      op: 'ops.describe',
      args: { protocol: 1 },
    })
    const ops = describedTable(described.result).ops
    assert.equal(
      ops.find(op => op.name === 'gcb.update'),
      undefined,
    )
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('gcb.update says when there was no image to restore', async () => {
  // No running container before the update: the tag moves, but there is nothing to restore.
  const rig = await gcbRig({ up: 'exit 1', ps: 'exit 0' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    const message = JSON.stringify(answer.error)
    assert.match(message, /recreate failed/u)
    assert.match(message, /no running image was recorded, so the tag was not restored/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update reports a failed tag restore', async () => {
  const rig = await gcbRig({ up: 'exit 1', tag: 'exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    const message = JSON.stringify(answer.error)
    assert.match(message, /recreate failed/u)
    // The recovery failure and the image it should have gone back to are both named.
    assert.match(message, /restoring oldimage to code-vaults\/gcb-host:dev failed/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update restores the broker tag when the recreate fails', async () => {
  const rig = await gcbRig({ up: 'exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    const message = JSON.stringify(answer.error)
    assert.match(message, /recreate failed/u)
    // The tag the service runs is the one it had, and the answer says so.
    assert.match(await rig.calls(), /tag oldimage code-vaults\/gcb-host:dev/u)
    assert.match(message, /the tag is back on oldimage/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update pulls, builds the one image and probes the deployment', async () => {
  const rig = await gcbRig()
  try {
    const described = await rig.connection.request({
      op: 'ops.describe',
      args: { protocol: 1 },
    })
    const ops = describedTable(described.result).ops
    const update = ops.find(op => op.name === 'gcb.update')
    assert.ok(update !== undefined)
    assert.equal(update.confirm, true)
    // The operation outlasts every step it runs: the image, the optional client build and the
    // recreate at the build budget, the probe, the local queries, the bounded pull and the host wait.
    assert.equal(
      update.timeoutMs,
      3 * BUILD_TIMEOUT_MS +
        GCB_PROBE_MS +
        GCB_QUERY_COUNT * GCB_QUERY_MS +
        GCB_PRELUDE_STEPS * GCB_QUERY_MS +
        GCB_PULL_MS +
        GCB_HOST_WAIT_MS,
    )

    // The runner may export UID/GID of its own; the sentinel proves the compose calls got `composeEnv`
    // rather than whatever the process happened to inherit.
    const answer = await withAmbientUid(() =>
      rig.connection.request({ op: 'gcb.update', args: {} }),
    )
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const recorded = await rig.calls()
    assert.match(recorded, /git -C .*gcb fetch --prune origin/u)
    assert.match(recorded, /compose -f .*gcb-compose-0\.yml config --services/u)
    assert.match(recorded, /compose -f .*gcb-compose-0\.yml config --images gcb/u)
    assert.match(recorded, /build --target host -t code-vaults\/gcb-host:dev \./u)
    assert.match(
      recorded,
      /compose -f .*gcb-compose-0\.yml up -d --no-deps --no-build --pull never --wait gcb/u,
    )
    assert.doesNotMatch(
      recorded,
      /compose -f .*gcb-compose-0\.yml up(?! -d --no-deps --no-build --pull never --wait gcb$)/mu,
    )
    assert.match(recorded, /compose -f .*gcb-compose-0\.yml ps -q gcb/u)
    // The image read happens before the recreate (so a failure can restore the tag), and the state
    // read is the new container's, not the one that was running before it.
    assert.match(recorded, /inspect --format \{\{\.Image\}\} abc123/u)
    assert.match(recorded, /inspect --format \{\{.State\.Status\}\}.* def456/u)
    assert.match(recorded, /exec dsh gcb probe --repo devockr\/idsh/u)
    // The identity is the process's, not a hard-coded value a compose call happens to carry.
    const identities = recorded.split('\n').filter(line => line.startsWith('identity '))
    assert.ok(identities.length > 0)
    const expected = `identity uid=${String(process.getuid?.())} gid=${String(process.getgid?.())}`
    for (const line of identities) {
      assert.equal(line, expected)
    }
    // The same pattern the replica test forbids does match a real build and recreate, so its
    // absence there means something.
    assert.match(recorded, /(?:^build |compose -f .*gcb-compose-0\.yml up )/mu)
    assert.match(answer.result ?? '', /image: code-vaults\/gcb-host:dev/u)
    assert.match(answer.result ?? '', /state: running healthy; probe: devockr\/idsh allowed/u)
    assert.doesNotMatch(answer.result ?? '', /state: [^;]*; state: /u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a compose file that names two images', async () => {
  const rig = await gcbRig({ images: 'printf "one\\ntwo\\n"' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.equal(answer.error?.code, 'unavailable')
    assert.match(answer.error?.message ?? '', /names 2 images/u)
  } finally {
    await rig.close()
  }
})

void test('a combined failure after the pin carries the convergence hint', async () => {
  // The build succeeds, the host pin moves, and the recreate fails: the answer has to say that the
  // host half is ahead, because re-running is what converges it.
  const rig = await gcbRig({ host: true, up: 'exit 1' })
  let host: StandInHost | undefined
  try {
    host = await standInForHost(
      {
        root: rig.host.root,
        pinFile: rig.pinFile ?? '',
        pidFile: rig.pidFile ?? '',
        stagedFile: rig.stagedFile ?? '',
      },
      { oldSha: 'c'.repeat(COMMIT_CHARS), newSha: 'a'.repeat(COMMIT_CHARS) },
    )
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /host: pinned a{12}/u)
    assert.match(JSON.stringify(answer.error), /re-run gcb.update to converge both/u)
  } finally {
    host?.stop()
    await rig.close()
  }
})

void test('a container-only failure does not claim the host moved', async () => {
  const rig = await gcbRig({ host: true, build: 'exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: { target: 'container' } })
    assert.equal(answer.ok, false)
    const message = JSON.stringify(answer.error)
    assert.match(message, /host: skipped \(target container\)/u)
    assert.doesNotMatch(message, /host half is already on the new commit/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update leaves the host pin alone when the build fails', async () => {
  const rig = await gcbRig({ host: true, build: 'exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /build failed/u)
    assert.equal(
      rig.pinFile === undefined ? '' : (await readFile(rig.pinFile, 'utf8')).trim(),
      'c'.repeat(COMMIT_CHARS),
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a compose that has no such service', async () => {
  const rig = await gcbRig({ services: 'printf "other\\nthird\\n"' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /has no service "gcb"; it has other, third/u)
    assert.match(answer.error?.message ?? '', /completed: fetch: origin\/main/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update names every compose file it was given', async () => {
  // A deployment renders a base file plus an overlay: both must reach every compose call.
  const rig = await gcbRig({ files: 2 })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true)
    const recorded = await rig.calls()
    assert.match(
      recorded,
      /compose -f .*gcb-compose-0\.yml -f .*gcb-compose-1\.yml config --services/u,
    )
    assert.match(recorded, /compose -f .*gcb-compose-0\.yml -f .*gcb-compose-1\.yml up -d/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update fails when the broker refuses the probe', async () => {
  const rig = await gcbRig({ probe: 'echo "denied: not in allowlist" >&2; exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /gcb\.update: probe failed/u)
    assert.match(answer.error?.message ?? '', /not in allowlist/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update parses stdout, so compose warnings are not names', async () => {
  const rig = await gcbRig({
    services: 'echo "WARN[0000] the UID variable is not set" >&2; echo gcb',
    images: 'echo "WARN[0000] another warning" >&2; echo "code-vaults/gcb-host:dev"',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /image: code-vaults\/gcb-host:dev/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update keeps the reason a parsed query failed', async () => {
  const rig = await gcbRig({
    services: 'echo "services.gcb.image must be a string" >&2; exit 1',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /must be a string/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update does not read a ps warning as a second container', async () => {
  const rig = await gcbRig({ ps: 'echo "WARN[0000] PR82_UNSET is not set" >&2; echo abc123' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /state: running healthy; probe:/u)
    assert.doesNotMatch(answer.result ?? '', /state: [^;]*; state: /u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update ignores a warning an inspect emits', async () => {
  // A warning on stderr must not become part of the state string and fail the check.
  const rig = await gcbRig({
    inspect: 'echo "WARN[0000] something to say" >&2; echo "running healthy"',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /state: running healthy; probe:/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update accepts a broker container without a healthcheck', async () => {
  const rig = await gcbRig({ inspect: 'echo running' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /state: running; probe:/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update names the state read when inspect fails', async () => {
  const rig = await gcbRig({ inspect: 'echo "no such object: abc123" >&2; exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /inspect the container state failed/u)
    assert.match(
      answer.error?.message ?? '',
      /completed: .*recreate: up -d --no-deps --no-build --pull never --wait gcb/u,
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update reports an exited broker with the steps that worked', async () => {
  const rig = await gcbRig({ inspect: 'echo exited' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /the broker container is exited; state: exited/u)
    assert.match(
      answer.error?.message ?? '',
      /completed: .*recreate: up -d --no-deps --no-build --pull never --wait gcb/u,
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update reports a broker container that ps does not list', async () => {
  // Compose lists only running containers, so a broker that stopped before this query is absent.
  const rig = await gcbRig({ ps: ':' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /not running after the recreate/u)
    assert.match(
      answer.error?.message ?? '',
      /completed: .*recreate: up -d --no-deps --no-build --pull never --wait gcb/u,
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a service that declares a scale', async () => {
  // The short form: `scale` at the service's top level, without `deploy.replicas`.
  const rig = await gcbRig({ config: `echo '{"services":{"gcb":{"scale":2}}}'` })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /declares 2 replicas; gcb.update expects one/u)
    assert.match(answer.error?.message ?? '', /completed: fetch: origin\/main.*; image: /u)
    // Refused before either side effect, like the `deploy.replicas` form.
    const recorded = await rig.calls()
    assert.doesNotMatch(recorded, /^(?:build |compose -f .* up )/mu)
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a service that declares replicas', async () => {
  const rig = await gcbRig({
    config: `echo '{"services":{"gcb":{"deploy":{"replicas":2}}}}'`,
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /declares 2 replicas; gcb.update expects one/u)
    // Refused before the build: the completed list ends at the image the compose names.
    assert.match(answer.error?.message ?? '', /completed: fetch: origin\/main.*; image: /u)
    assert.doesNotMatch(answer.error?.message ?? '', /build: ok/u)
    // Refused before either side effect: no build, no recreate.
    const recorded = await rig.calls()
    assert.doesNotMatch(recorded, /(?:^build |compose -f .*gcb-compose-0\.yml up )/mu)
  } finally {
    await rig.close()
  }
})

void test('gcb.update stops at the step whose build failed', async () => {
  const rig = await gcbRig({ build: 'echo "no space left on device" >&2; exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /gcb\.update: build failed/u)
    assert.match(answer.error?.message ?? '', /no space left on device/u)
    assert.match(answer.error?.message ?? '', /completed: fetch: origin\/main.*; image: /u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update stops at the step whose recreate failed', async () => {
  const rig = await gcbRig({ up: 'echo "port is already allocated" >&2; exit 1' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /gcb\.update: recreate failed/u)
    assert.match(answer.error?.message ?? '', /port is already allocated/u)
    assert.match(answer.error?.message ?? '', /completed: .*build: ok/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a service that runs two containers', async () => {
  // `--scale` on the command line never reaches deploy.replicas, so the listed containers decide.
  const rig = await gcbRig({ ps: 'printf "abc123\\ndef456\\n"' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(answer.error?.message ?? '', /runs 2 containers; gcb.update expects one/u)
    assert.match(answer.error?.message ?? '', /completed: .*recreate: /u)
  } finally {
    await rig.close()
  }
})

void test('an empty compose list is refused at boot', async () => {
  const host = await fakeHost()
  await assert.rejects(
    startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
      gcbCompose: ' , ',
    }),
    /--gcb-compose needs at least one file/u,
  )
})

void test('deploy.main removes nothing when it cannot resolve the image it built', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$1" in
  image)
    case "$2" in
      ls) printf 'sha256:old1\\nsha256:old2\\n' ;;
      # The image this build produced cannot be resolved: nothing may be removed on a guess.
      inspect) exit 1 ;;
      rm) echo "removed $3" ;;
    esac ;;
  inspect) echo '${ROLLBACK_TARGET}' ;;
  compose) echo "$*" ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.main', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    // The build stays successful and says the sweep did not finish.
    assert.match(
      answer.result ?? '',
      /the image sweep did not finish: the image this build produced/u,
    )
    const docker = await readFile(dockerLog, 'utf8')
    assert.doesNotMatch(docker, /image rm/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.main removes nothing when the image listing was cut', async () => {
  // More ids than one retained window: the ones behind the cut were never seen, so the sweep must
  // not report that it finished.
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/heads/*"*) echo 'aaaaaaaa11111111111111111111111111111111 refs/heads/main' ;;
  *" clone "*) for last; do :; done; mkdir -p "$last" ;;
esac
`,
    { mode: 0o755 },
  )
  await writeFile(
    dockerPath,
    `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$1" in
  image)
    case "$2" in
      ls) awk 'BEGIN { for (i = 0; i < 30000; i += 1) printf "sha256:%060d\\n", i }' ;;
      inspect) echo "sha256:new" ;;
      rm) echo "removed $3" ;;
    esac ;;
  inspect) echo '${ROLLBACK_TARGET}' ;;
  compose) echo "$*" ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answer = await connection.request({ op: 'deploy.main', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(
      answer.result ?? '',
      /the image sweep did not finish: more images carried the label/u,
    )
    const docker = await readFile(dockerLog, 'utf8')
    assert.doesNotMatch(docker, /image rm/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('deploy.source resolves the request without building', async () => {
  const host = await fakeHost()
  const dockerLog = path.join(host.root, 'docker.log')
  const dockerPath = path.join(host.root, 'docker')
  const gitPath = path.join(host.root, 'git')
  await writeFile(dockerPath, `#!/bin/sh\necho "$*" >> '${dockerLog}'\nexit 0\n`, {
    mode: 0o755,
  })
  await writeFile(
    gitPath,
    `#!/bin/sh
case "$*" in
  *"refs/pull/82/head"*) echo 'bbbbbbb2222222222222222222222222222222222 refs/pull/82/head' ;;
  *"refs/heads/*"*) printf 'aaaaaaaa11111111111111111111111111111111 refs/heads/main\\nbbbbbbb2222222222222222222222222222222222 refs/heads/feat\\n' ;;
esac
`,
    { mode: 0o755 },
  )
  const checkout = path.join(host.root, 'checkout')
  await mkdir(checkout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
    gitPath,
    checkout,
  })
  const connection = client(host.socketPath)
  try {
    const answered = await connection.request({ op: 'deploy.source', args: { pr: 82 } })
    assert.equal(answered.ok, true, JSON.stringify(answered.error))
    assert.match(answered.result ?? '', /PR #82 at bbbbbbb22/u)
    assert.match(answered.result ?? '', /main at aaaaaaaa1/u)
    // `deploy.main` builds main, and its preview answers with main alone.
    const main = await connection.request({
      op: 'deploy.source',
      args: { for: 'deploy.main' },
    })
    assert.equal(main.ok, true, JSON.stringify(main.error))
    assert.equal(main.result, 'main at aaaaaaaa11111111111111111111111111111111')
    // A preview resolves refs and nothing else: docker was never called.
    assert.equal(await readFile(dockerLog, 'utf8').catch(() => ''), '')
    // A request that names a source is not a request for main, however it is labelled.
    const mixed = await connection.request({
      op: 'deploy.source',
      args: { for: 'deploy.main', pr: 82 },
    })
    assert.equal(mixed.ok, false)
    assert.match(mixed.error?.message ?? '', /give pr or sha to deploy\.build instead/u)
    // The whole request is checked, not only the part the preview uses: a `log` the build would
    // refuse must not reach the person as a question.
    const badLog = await connection.request({
      op: 'deploy.source',
      args: { pr: 82, log: 'bad/log' },
    })
    assert.equal(badLog.ok, false)
    assert.match(badLog.error?.message ?? '', /log must be 1-64 letters/u)
    // `deploy.build` with neither is refused here, before anyone is asked about it.
    const empty = await connection.request({ op: 'deploy.source', args: {} })
    assert.equal(empty.ok, false)
    assert.match(empty.error?.message ?? '', /give exactly one of pr or sha/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('ops.describe answers the bare table to a client that declares nothing', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  await writeFile(dockerPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath,
  })
  const connection = client(host.socketPath)
  try {
    // An older plugin throws unless this is an array: the envelope is for clients that ask for it.
    const legacy = await connection.request({ op: 'ops.describe', args: {} })
    const parsed: unknown = JSON.parse(legacy.result ?? 'null')
    assert.equal(Array.isArray(parsed), true)

    const declared = await connection.request({
      op: 'ops.describe',
      args: { protocol: 1 },
    })
    const envelope: unknown = JSON.parse(declared.result ?? 'null')
    assert.equal(typeof envelope, 'object')
    assert.equal((envelope as { protocol?: unknown }).protocol, 1)
    assert.equal(Array.isArray((envelope as { ops?: unknown }).ops), true)

    // A field this broker does not know is ignored rather than refused: the request is versioned
    // too, and a newer client still gets the table and the protocol this broker speaks.
    const extra = await connection.request({
      op: 'ops.describe',
      args: { protocol: 1, something: true },
    })
    assert.equal(extra.ok, true)
    assert.equal((JSON.parse(extra.result ?? 'null') as { protocol?: unknown }).protocol, 1)

    // A wrong type is the caller's mistake, not a shape to guess at.
    const wrong = await connection.request({
      op: 'ops.describe',
      args: { protocol: 'one' },
    })
    assert.equal(wrong.ok, false)
    assert.match(wrong.error?.message ?? '', /protocol must be an integer/u)
  } finally {
    connection.close()
    await broker.close()
  }
})

/** A broker configured for the host half of `gcb.update`: a fake git, no container. */
async function hostUpdateRig(): Promise<{
  host: FakeHost
  calls: string
  deployDir: string
  pinFile: string
  pidFile: string
  stagedFile: string
  connection: Client
  close(): Promise<void>
}> {
  const host = await fakeHost()
  const deployDir = path.join(host.root, '.broker-host')
  const appDir = path.join(deployDir, 'app')
  await mkdir(appDir, { recursive: true })
  const pinFile = path.join(deployDir, 'app.ref')
  const pidFile = path.join(deployDir, 'gcb-host.pid')
  const stagedFile = path.join(appDir, 'STAGED.json')
  const oldSha = 'a'.repeat(COMMIT_CHARS)
  await writeFile(pinFile, `${oldSha}\n`)
  await writeFile(stagedFile, JSON.stringify({ sha: oldSha }))
  const calls = path.join(host.root, 'git-calls.log')
  const gitPath = path.join(host.root, 'git')
  await writeFile(
    gitPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "\${CALLS}"`,
      'case "$*" in',
      '  *"fetch --prune origin"*) : ;;',
      '  *"checkout --detach --quiet origin/main"*) : ;;',
      '  *"status --porcelain"*) printf "%s" "$STATUS" ;;',
      `  *"rev-parse HEAD"*) echo "${'b'.repeat(COMMIT_CHARS)}" ;;`,
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const previousCalls = process.env['CALLS']
  process.env['CALLS'] = calls
  const gcbCheckout = path.join(host.root, 'gcb')
  await mkdir(gcbCheckout)
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath: path.join(host.root, 'docker'),
    gitPath,
    gcbCheckout,
    gcbDeployDir: deployDir,
    gcbHostUpdate: true,
  })
  const connection = client(host.socketPath)
  return {
    host,
    calls,
    deployDir,
    pinFile,
    pidFile,
    stagedFile,
    connection,
    async close() {
      connection.close()
      await broker.close()
      // The git stub reads this; leaving it behind would point later tests at a removed directory.
      if (previousCalls === undefined) {
        delete process.env['CALLS']
      } else {
        process.env['CALLS'] = previousCalls
      }
    },
  }
}

void test('gcb.update refuses a target it does not know', async () => {
  const rig = await gcbRig()
  try {
    const answer = await rig.connection.request({
      op: 'gcb.update',
      args: { target: 'neither' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /target must be both, container or host/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update stops at the fetch when the remote cannot be reached', async () => {
  const rig = await gcbRig()
  try {
    await withEnv({ FAIL_PULL: '1' }, async () => {
      const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
      assert.equal(answer.ok, false)
      const message = JSON.stringify(answer.error)
      assert.match(message, /fetch failed/u)
      assert.match(message, /no route to the remote/u)
      assert.doesNotMatch(await rig.calls(), /build --target host/u)
    })
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a commit that is not one', async () => {
  const rig = await gcbRig()
  try {
    await withEnv({ SHA: 'not-a-commit' }, async () => {
      const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
      assert.equal(answer.ok, false)
      assert.match(JSON.stringify(answer.error), /is not a commit id/u)
      assert.doesNotMatch(await rig.calls(), /build --target host/u)
    })
  } finally {
    await rig.close()
  }
})

void test('gcb.update can retry only the host half', async () => {
  const rig = await gcbRig({ host: true })
  let host: StandInHost | undefined
  try {
    const pinFile = rig.pinFile ?? ''
    const pidFile = rig.pidFile ?? ''
    const stagedFile = rig.stagedFile ?? ''
    assert.ok(pinFile !== '' && pidFile !== '' && stagedFile !== '')
    host = await standInForHost(
      { root: rig.host.root, pinFile, pidFile, stagedFile },
      { oldSha: 'c'.repeat(COMMIT_CHARS), newSha: 'a'.repeat(COMMIT_CHARS) },
    )
    const answer = await rig.connection.request({ op: 'gcb.update', args: { target: 'host' } })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /container: skipped \(target host\)/u)
    // A host refresh does not rebuild the container.
    assert.doesNotMatch(await rig.calls(), /build --target host/u)
    assert.equal((await readFile(pinFile, 'utf8')).trim(), 'a'.repeat(COMMIT_CHARS))
  } finally {
    host?.stop()
    await rig.close()
  }
})

void test('gcb.update names the status check when it fails', async () => {
  const rig = await gcbRig()
  try {
    await withEnv({ FAIL_STATUS: '1' }, async () => {
      const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
      assert.equal(answer.ok, false)
      assert.match(JSON.stringify(answer.error), /reading the checkout status failed/u)
      assert.match(JSON.stringify(answer.error), /status is unreadable/u)
      assert.doesNotMatch(await rig.calls(), /pull --ff-only/u)
    })
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a dirty checkout for a container-only run too', async () => {
  const rig = await gcbRig()
  try {
    await withEnv({ STATUS: ' M src/x.ts\n' }, async () => {
      const answer = await rig.connection.request({
        op: 'gcb.update',
        args: { target: 'container' },
      })
      assert.equal(answer.ok, false)
      assert.match(JSON.stringify(answer.error), /local changes/u)
      assert.doesNotMatch(await rig.calls(), /pull --ff-only/u)
    })
  } finally {
    await rig.close()
  }
})

void test('gcb.update accepts a broker launched relatively inside the deployment', async () => {
  const rig = await gcbRig({ host: true })
  let host: StandInHost | undefined
  try {
    host = await standInForHost(
      {
        root: rig.host.root,
        pinFile: rig.pinFile ?? '',
        pidFile: rig.pidFile ?? '',
        stagedFile: rig.stagedFile ?? '',
      },
      { oldSha: 'c'.repeat(COMMIT_CHARS), newSha: 'a'.repeat(COMMIT_CHARS), relative: true },
    )
    const answer = await rig.connection.request({ op: 'gcb.update', args: { target: 'host' } })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
  } finally {
    host?.stop()
    await rig.close()
  }
})

void test('gcb.update refuses a client image that names the broker image', async () => {
  const rig = await gcbRig({ clientImage: 'code-vaults/gcb-host:dev' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /name the same image/u)
    // Refused before either build: a shared tag would replace the image the service runs.
    assert.doesNotMatch(await rig.calls(), /build --target/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update keeps library/ to Docker Hub', async () => {
  // ghcr.io/x and ghcr.io/library/x are different images; only Docker Hub has a library namespace.
  const rig = await gcbRig({
    images: 'echo ghcr.io/library/gcb-host:latest',
    clientImage: 'ghcr.io/gcb-host:latest',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const calls = await rig.calls()
    assert.match(calls, /build --target client -t ghcr\.io\/gcb-host:latest/u)
    assert.match(calls, /build --target host -t ghcr\.io\/library\/gcb-host:latest/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update treats the registry prefix as part of the name', async () => {
  const rig = await gcbRig({
    images: 'echo docker.io/code-vaults/gcb-host:latest',
    clientImage: 'code-vaults/gcb-host:latest',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /name the same image/u)
    assert.doesNotMatch(await rig.calls(), /build --target/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update treats an omitted client tag as latest', async () => {
  // `code-vaults/gcb-host` and `code-vaults/gcb-host:latest` are the same image.
  const rig = await gcbRig({
    images: 'echo code-vaults/gcb-host:latest',
    clientImage: 'code-vaults/gcb-host',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /name the same image/u)
    assert.doesNotMatch(await rig.calls(), /build --target/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update rebuilds the client image from the same checkout', async () => {
  const rig = await gcbRig({ clientImage: 'code-vaults/gcb-client:dev' })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /client: code-vaults\/gcb-client:dev/u)
    const calls = await rig.calls()
    assert.match(calls, /build --target host -t /u)
    assert.match(calls, /build --target client -t code-vaults\/gcb-client:dev/u)
  } finally {
    await rig.close()
  }
})

void test('gcb.update leaves the host pin alone when the client build fails', async () => {
  const rig = await gcbRig({
    host: true,
    clientImage: 'code-vaults/gcb-client:dev',
    clientBuild: 'exit 1',
  })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /build the client failed/u)
    assert.doesNotMatch(await rig.calls(), /build --target host/u)
    assert.doesNotMatch(await rig.calls(), /up -d --no-deps/u)
    assert.equal(
      rig.pinFile === undefined ? '' : (await readFile(rig.pinFile, 'utf8')).trim(),
      'c'.repeat(COMMIT_CHARS),
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update can retry only the container half', async () => {
  const rig = await gcbRig({ host: true })
  try {
    const answer = await rig.connection.request({ op: 'gcb.update', args: { target: 'container' } })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /host: skipped \(target container\)/u)
    // The build ran; the host pin did not move.
    assert.match(await rig.calls(), /build --target host/u)
    assert.equal(
      rig.pinFile === undefined ? '' : (await readFile(rig.pinFile, 'utf8')).trim(),
      'c'.repeat(COMMIT_CHARS),
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update refuses a half that is not configured', async () => {
  const hostOnly = await hostUpdateRig()
  try {
    const answer = await hostOnly.connection.request({
      op: 'gcb.update',
      args: { target: 'container' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /container half is not configured/u)
  } finally {
    await hostOnly.close()
  }
  const containerOnly = await gcbRig()
  try {
    const answer = await containerOnly.connection.request({
      op: 'gcb.update',
      args: { target: 'host' },
    })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /host half is not configured/u)
  } finally {
    await containerOnly.close()
  }
})

void test('gcb.update keeps real git on the checkout despite an inherited GIT_DIR', async () => {
  // A real git, not a stub: the point is that git itself accepts the environment it is given. The
  // fixture setup must not inherit the runner's repository location either.
  const host = await fakeHost()
  const fixtureEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    delete fixtureEnv[key]
  }
  const fixture = (...args: string[]): void => {
    execFileSync('git', args, { stdio: 'ignore', env: fixtureEnv })
  }
  const work = path.join(host.root, 'work')
  const origin = path.join(host.root, 'origin.git')
  fixture('init', '--bare', origin)
  fixture('init', '-b', 'main', work)
  fixture('-C', work, 'config', 'user.email', 'test@example.invalid')
  fixture('-C', work, 'config', 'user.name', 'test')
  await writeFile(path.join(work, 'a.txt'), 'one\n')
  fixture('-C', work, 'add', 'a.txt')
  fixture('-C', work, 'commit', '-m', 'one')
  fixture('-C', work, 'remote', 'add', 'origin', origin)
  fixture('-C', work, 'push', '-u', 'origin', 'main')

  const deployDir = path.join(host.root, '.broker-host')
  await mkdir(path.join(deployDir, 'app'), { recursive: true })
  const pinFile = path.join(deployDir, 'app.ref')
  const pidFile = path.join(deployDir, 'gcb-host.pid')
  const stagedFile = path.join(deployDir, 'app', 'STAGED.json')
  const oldSha = 'c'.repeat(COMMIT_CHARS)
  await writeFile(pinFile, `${oldSha}\n`)
  await writeFile(stagedFile, JSON.stringify({ sha: oldSha }))

  const inherited = process.env['GIT_DIR']
  let broker: RunningBroker | undefined
  let connection: Client | undefined
  let oldBroker: ReturnType<typeof spawn> | undefined
  let supervisor: ReturnType<typeof spawn> | undefined
  try {
    // Inside the deploy directory: the operation refuses a pid whose command line does not name it.
    const fakeBroker = path.join(deployDir, 'gcb-host.sh')
    await writeFile(fakeBroker, 'sleep 300\n')
    oldBroker = spawn('sh', [fakeBroker], { stdio: 'ignore' })
    await writeFile(pidFile, `${String(oldBroker.pid)}\n`)
    supervisor = spawn(
      'sh',
      [
        '-c',
        'while [ "$(cat "$1")" = "$2" ]; do sleep 0.1; done; sleep 300 & echo $! > "$3"; printf \'{"sha":"%s"}\\n\' "$(cat "$1")" > "$4"',
        'sh',
        pinFile,
        oldSha,
        pidFile,
        stagedFile,
      ],
      { stdio: 'ignore', detached: true },
    )
    process.env['GIT_DIR'] = path.join(host.root, 'elsewhere', '.git')
    broker = await startBroker({
      socketPath: host.socketPath,
      auditPath: host.auditPath,
      logDir: host.logDir,
      procDir: host.procDir,
      gitPath: 'git',
      gcbCheckout: work,
      gcbDeployDir: deployDir,
      gcbHostUpdate: true,
    })
    connection = client(host.socketPath)
    const answer = await connection.request({ op: 'gcb.update', args: { target: 'host' } })
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    const pinned = (await readFile(pinFile, 'utf8')).trim()
    assert.match(pinned, /^[0-9a-f]{40}$/u)
    assert.notEqual(pinned, oldSha)
    const staged = JSON.parse(await readFile(stagedFile, 'utf8')) as { sha?: string }
    assert.equal(staged.sha, pinned)
  } finally {
    // Each step on its own: a failing close must not keep the processes alive.
    try {
      if (inherited === undefined) {
        delete process.env['GIT_DIR']
      } else {
        process.env['GIT_DIR'] = inherited
      }
    } finally {
      try {
        connection?.close()
      } finally {
        try {
          await broker?.close()
        } finally {
          try {
            if (supervisor?.pid !== undefined) {
              process.kill(-supervisor.pid, 'SIGKILL')
            }
          } catch {
            supervisor?.kill()
          }
          oldBroker?.kill()
        }
      }
    }
  }
})

void test('gcb.update refuses a pid under a sibling of the deploy directory', async () => {
  const rig = await hostUpdateRig()
  // The deploy directory as a string prefix, but a different path component.
  const sibling = path.join(rig.host.root, '.broker-host-elsewhere')
  await mkdir(sibling)
  const script = path.join(sibling, 'gcb-broker.sh')
  await writeFile(script, 'sleep 300\n')
  const foreign = spawn('sh', [script], { stdio: 'ignore' })
  const foreignPid = foreign.pid
  assert.ok(foreignPid !== undefined)
  try {
    await writeFile(rig.pidFile, `${String(foreignPid)}\n`)
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /does not run from/u)
    assert.equal((await readFile(rig.pinFile, 'utf8')).trim(), 'a'.repeat(COMMIT_CHARS))
    process.kill(foreignPid, 0)
  } finally {
    foreign.kill()
    await rig.close()
  }
})

void test('gcb.update refuses a deployment path nested under another directory', async () => {
  const rig = await hostUpdateRig()
  // The whole deployment path sits inside a different tree: containing it is not being it.
  const nested = path.join(rig.host.root, 'backup', path.relative('/', rig.deployDir))
  await mkdir(nested, { recursive: true })
  const script = path.join(nested, 'gcb-broker.sh')
  await writeFile(script, 'sleep 300\n')
  const foreign = spawn('sh', [script], { stdio: 'ignore' })
  const foreignPid = foreign.pid
  assert.ok(foreignPid !== undefined)
  try {
    await writeFile(rig.pidFile, `${String(foreignPid)}\n`)
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /does not run from/u)
    assert.equal((await readFile(rig.pinFile, 'utf8')).trim(), 'a'.repeat(COMMIT_CHARS))
    process.kill(foreignPid, 0)
  } finally {
    foreign.kill()
    await rig.close()
  }
})

void test('gcb.update refuses a stale pid that runs elsewhere', async () => {
  const rig = await hostUpdateRig()
  // A live process whose command line mentions gcb but not this deployment's directory.
  const foreignScript = path.join(rig.host.root, 'gcb-foreign.sh')
  await writeFile(foreignScript, 'sleep 300\n')
  const foreign = spawn('sh', [foreignScript], { stdio: 'ignore' })
  const foreignPid = foreign.pid
  assert.ok(foreignPid !== undefined)
  try {
    await writeFile(rig.pidFile, `${String(foreignPid)}\n`)
    const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /does not run from/u)
    // Refused before the pin moved, and without signalling it.
    assert.equal((await readFile(rig.pinFile, 'utf8')).trim(), 'a'.repeat(COMMIT_CHARS))
    process.kill(foreignPid, 0)
  } finally {
    foreign.kill()
    await rig.close()
  }
})

void test('gcb.update clears an inherited git repository location', async () => {
  const rig = await gcbRig()
  try {
    await withEnv({ GIT_DIR: '/elsewhere/.git' }, async () => {
      const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
      assert.equal(answer.ok, true, JSON.stringify(answer.error))
      // Removed, not blanked: git treats an empty GIT_DIR as a path and fails on it.
      assert.match(await rig.calls(), /gitdir=unset/u)
    })
  } finally {
    await rig.close()
  }
})

/**
 * Runs `work` with `vars` set (an `undefined` value removes the key) and restores every previous
 * value afterwards — including when the work throws. Inherited variables are the test's input, so
 * each one is either pinned or removed, never left to the runner.
 */
async function withEnv<T>(
  vars: Readonly<Record<string, string | undefined>>,
  work: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await work()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

interface StandInHost {
  /** The process the pid file named before the pin moved; a replacement is anything else. */
  oldPid: number | undefined
  stop(): void
}

/**
 * A stand-in for the supervisor that restarts the host broker: it waits for `app.ref` to change,
 * publishes a live replacement pid, optionally waits for `barrier`, then records the pinned commit
 * as staged. `stop` kills the supervisor's process group, so a replacement published late dies with
 * it, and the pid file is never read back.
 */
async function standInForHost(
  where: { root: string; pinFile: string; pidFile: string; stagedFile: string },
  options: { oldSha: string; newSha?: string; barrier?: string; relative?: boolean },
): Promise<StandInHost> {
  // Inside the deploy directory: the operation refuses a pid whose command line does not name it.
  const fakeBroker = path.join(path.dirname(where.pinFile), 'gcb-host.sh')
  await writeFile(fakeBroker, 'sleep 300\n')
  const oldBroker =
    options.relative === true
      ? spawn('sh', ['-c', 'exec sh gcb-host.sh'], {
          cwd: path.dirname(where.pinFile),
          stdio: 'ignore',
        })
      : spawn('sh', [fakeBroker], { stdio: 'ignore' })
  await writeFile(where.pidFile, `${String(oldBroker.pid)}\n`)
  const supervisor = spawn(
    'sh',
    [
      '-c',
      'while [ "$(cat "$1")" = "$2" ]; do sleep 0.1; done; sleep 300 & echo $! > "$3"; if [ -n "$6" ]; then while [ ! -e "$6" ]; do sleep 0.1; done; fi; if [ -n "$5" ]; then printf \'{"sha":"%s"}\\n\' "$5" > "$4"; else printf \'{"sha":"%s"}\\n\' "$(cat "$1")" > "$4"; fi',
      'sh',
      where.pinFile,
      options.oldSha,
      where.pidFile,
      where.stagedFile,
      options.newSha ?? '',
      options.barrier ?? '',
    ],
    // Its own group: everything it starts dies with `stop`.
    { stdio: 'ignore', detached: true },
  )
  return {
    oldPid: oldBroker.pid,
    stop(): void {
      if (supervisor.pid !== undefined) {
        try {
          process.kill(-supervisor.pid, 'SIGKILL')
        } catch {
          supervisor.kill()
        }
      }
      oldBroker.kill()
    },
  }
}

void test('gcb.update makes ssh non-interactive when nothing else decides it', async () => {
  const rig = await gcbRig()
  try {
    await withEnv(
      { GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, CORE_SSH: undefined },
      async () => {
        const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
        assert.equal(answer.ok, true, JSON.stringify(answer.error))
        assert.match(await rig.calls(), /ssh=ssh -o BatchMode=yes -o ConnectTimeout=10/u)
      },
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update does not read a failed config query as "unset"', async () => {
  const rig = await gcbRig()
  try {
    await withEnv({ FAIL_CONFIG: '1' }, async () => {
      const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
      assert.equal(answer.ok, false)
      assert.match(JSON.stringify(answer.error), /config is unreadable/u)
    })
  } finally {
    await rig.close()
  }
})

void test('gcb.update respects an inherited GIT_SSH wrapper', async () => {
  const rig = await gcbRig()
  try {
    await withEnv(
      { GIT_SSH: '/usr/bin/ssh-wrapper', GIT_SSH_COMMAND: undefined, CORE_SSH: undefined },
      async () => {
        const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
        assert.equal(answer.ok, true, JSON.stringify(answer.error))
        // The wrapper decides the ssh command; BatchMode must not replace it — and the pull ran
        // with that wrapper in its environment.
        const calls = await rig.calls()
        assert.match(calls, /ssh=none/u)
        assert.match(calls, /wrapper=\/usr\/bin\/ssh-wrapper$/mu)
      },
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update leaves a configured ssh command alone', async () => {
  const rig = await gcbRig()
  try {
    await withEnv(
      {
        GIT_SSH: undefined,
        GIT_SSH_COMMAND: undefined,
        CORE_SSH: 'ssh -o ProxyCommand=corp-proxy',
      },
      async () => {
        const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
        assert.equal(answer.ok, true, JSON.stringify(answer.error))
        assert.match(await rig.calls(), /ssh=none/u)
      },
    )
  } finally {
    await rig.close()
  }
})

void test('gcb.update is not offered without a gcb checkout', async () => {
  const host = await fakeHost()
  const broker = await startBroker({
    socketPath: host.socketPath,
    auditPath: host.auditPath,
    logDir: host.logDir,
    procDir: host.procDir,
    dockerPath: path.join(host.root, 'docker'),
    gcbHostUpdate: true,
  })
  const connection = client(host.socketPath)
  try {
    const described = await connection.request({ op: 'ops.describe', args: { protocol: 1 } })
    const ops = describedTable(described.result).ops
    assert.equal(
      ops.find(op => op.name === 'gcb.update'),
      undefined,
    )
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('gcb.update pins the host broker and waits for the restarted process', async () => {
  const rig = await hostUpdateRig()
  const barrier = path.join(rig.host.root, 'staged.barrier')
  const newSha = 'b'.repeat(COMMIT_CHARS)
  let host: StandInHost | undefined
  try {
    host = await standInForHost(
      {
        root: rig.host.root,
        pinFile: rig.pinFile,
        pidFile: rig.pidFile,
        stagedFile: rig.stagedFile,
      },
      { oldSha: 'a'.repeat(COMMIT_CHARS), newSha, barrier },
    )
    const oldPid = host.oldPid
    let settled = false
    const pending = rig.connection.request({ op: 'gcb.update', args: {} }).then(answer => {
      settled = true
      return answer
    })
    // The replacement has to be *running* before the pending assertion means anything: with no
    // new pid yet, the request would still be pending for the wrong reason.
    await waitFor(async () => {
      const restarted = Number((await readFile(rig.pidFile, 'utf8').catch(() => '')).trim())
      // The old pid sits in that file before the pin moves: only a different one is a replacement.
      if (!Number.isInteger(restarted) || restarted <= 0 || restarted === oldPid) {
        return false
      }
      try {
        process.kill(restarted, 0)
        return true
      } catch {
        return false
      }
    }, REPLACEMENT_WAIT_MS)
    // Longer than two poll intervals: a new pid is not the answer, the staged commit is.
    await new Promise(resolve => setTimeout(resolve, 3 * GCB_POLL_MS))
    assert.equal(settled, false)
    await writeFile(barrier, '')
    const answer = await pending
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    assert.match(answer.result ?? '', /container: not configured/u)
    assert.match(answer.result ?? '', /host: pinned b{12}/u)
    assert.equal((await readFile(rig.pinFile, 'utf8')).trim(), newSha)
  } finally {
    host?.stop()
    await rig.close()
  }
})

void test('gcb.update names a host broker directory that is not there', async () => {
  const rig = await hostUpdateRig()
  const missing = path.join(rig.host.root, 'missing-broker-home')
  let broker: RunningBroker | undefined
  let connection: Client | undefined
  try {
    // Owner-only, like every other socket here: a group-writable parent rejects the socket mode.
    const secondRoot = path.join(rig.host.root, 'second')
    await mkdir(secondRoot, { mode: DIRECTORY_MODE })
    // Some filesystems (this Synology one) ignore the mode on mkdir; the socket's own check does not.
    await chmod(secondRoot, DIRECTORY_MODE)
    broker = await startBroker({
      socketPath: path.join(secondRoot, 'host.sock'),
      auditPath: path.join(rig.host.root, 'second.jsonl'),
      logDir: rig.host.logDir,
      procDir: rig.host.procDir,
      dockerPath: path.join(rig.host.root, 'docker'),
      gitPath: path.join(rig.host.root, 'git'),
      gcbCheckout: path.join(rig.host.root, 'gcb'),
      gcbDeployDir: missing,
      gcbHostUpdate: true,
    })
    connection = client(path.join(secondRoot, 'host.sock'))
    const answer = await connection.request({ op: 'gcb.update', args: {} })
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer.error), /missing-broker-home is not a directory/u)
    // The refusal is before the network step.
    assert.doesNotMatch(await readFile(rig.calls, 'utf8'), /pull --ff-only/u)
  } finally {
    connection?.close()
    await broker?.close()
    await rig.close()
  }
})

void test('gcb.update refuses a dirty checkout before it touches either broker', async () => {
  const rig = await hostUpdateRig()
  try {
    await withEnv({ STATUS: ' M packages/x.ts' }, async () => {
      const answer = await rig.connection.request({ op: 'gcb.update', args: {} })
      assert.equal(answer.ok, false)
      assert.match(JSON.stringify(answer.error), /local changes/u)
      // The refusal comes before the network step: nothing was pulled into the checkout.
      assert.doesNotMatch(await readFile(rig.calls, 'utf8'), /pull --ff-only/u)
    })
  } finally {
    await rig.close()
  }
})
