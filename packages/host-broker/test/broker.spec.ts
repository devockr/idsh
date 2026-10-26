/* eslint-disable @typescript-eslint/no-magic-numbers -- the inputs of these tests are numbers */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  capOutput,
  createLineReader,
  MAX_LINE_BYTES,
  parseRequest,
  RateLimiter,
  startBroker,
  TAIL_WINDOW_BYTES,
  type BrokerResponse,
} from '../src/index.ts'

const SMALL_LINE_LIMIT = 10
const LONG_ROW_CHARS = 40_000
const BYTES_PER_KIB = 1024
const OUTPUT_CAP_BYTES = 64 * BYTES_PER_KIB
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
 * @returns the paths the broker is started with.
 */
async function fakeHost(): Promise<FakeHost> {
  const root = await mkdtemp(path.join(tmpdir(), 'idsh-host-'))
  const logDir = path.join(root, 'log')
  const procDir = path.join(root, 'proc')
  await mkdir(logDir)
  await mkdir(procDir)
  await writeFile(
    path.join(logDir, 'messages'),
    [
      'boot ok',
      'error: disk 1 failed',
      'warn: smart pending',
      'error: retry failed',
    ].join('\n'),
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
 * @param socketPath the broker's socket.
 * @returns the client.
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
  assert.deepEqual(
    parseRequest('{"op":"proc.read","args":{"file":"mdstat"}}'),
    {
      op: 'proc.read',
      args: { file: 'mdstat' },
    },
  )
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
  input: { required?: string[] }
  confirm?: boolean
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
      args: {},
    })
    const ops = JSON.parse(described.result ?? '[]') as DescribedOp[]
    assert.deepEqual(
      ops.map(op => op.name),
      [
        'log.tail',
        'proc.read',
        'deploy.status',
        'deploy.log',
        'deploy.recreate',
        'disk.usage',
      ],
    )
    assert.equal(ops[0].input.required?.[0], 'file')

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
function bigLog(
  rowCount: number,
  head: string,
  rowLength = 32,
): { content: string; last: string } {
  const row = (index: number) =>
    `R${String(index).padStart(7, '0')}-${'x'.repeat(rowLength - 10)}\n`
  const content =
    head + Array.from({ length: rowCount }, (_, i) => row(i)).join('')
  return { content, last: row(rowCount - 1).trimEnd() }
}

void test('log.tail keeps the first whole row when the window starts on a boundary', async () => {
  const host = await fakeHost()
  const { content } = bigLog(9000, '')
  // The window starts at row 808. Only that row matches the pattern, so it is exactly the row the
  // off-by-one used to drop — a test that read the last rows would pass either way.
  assert.equal(content.length % 32, 0)
  assert.equal((content.length - TAIL_WINDOW_BYTES) % 32, 0)
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
  const { content, last } = bigLog(8000, '', 33)
  assert.notEqual((content.length - TAIL_WINDOW_BYTES) % 33, 0)
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
  const closed = new Promise<void>(resolve =>
    socket.once('close', () => resolve()),
  )
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
  await chmod(host.auditPath, 0o644)
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
  assert.equal(stats.mode & MODE_MASK, 0o600)
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
    assert.match(
      status.result ?? '',
      /^inspect --type container --format .*web$/mu,
    )
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
  const row = `${'x'.repeat(199)}😀\n`
  const text = row.repeat(400)
  const capped = capOutput(text, 'tail')
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.includes('\uFFFD'))
  assert.ok(capped.text.endsWith(`${'x'.repeat(199)}😀\n`))
})

void test('capOutput backs off a cut that lands inside a character', () => {
  // 65 536 bytes back from the end falls on the emoji's third byte.
  const text = `${'x'.repeat(100)}😀${'x'.repeat(65_534)}`
  const capped = capOutput(text, 'tail')
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.includes('\uFFFD'))
  assert.equal(capped.text, 'x'.repeat(Buffer.byteLength(capped.text)))
})

void test('a window that starts on a surrogate half drops it, not the character', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const line = `${'x'.repeat(60)}😀${'y'.repeat(499)}`
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
    assert.equal(answer.error?.message, 'y'.repeat(499))
  } finally {
    connection.close()
    await broker.close()
  }
})

void test('a tail window that is one long line is not emptied', () => {
  const text = `${'x'.repeat(70_000)}\n`
  const capped = capOutput(text, 'tail')
  assert.equal(capped.truncated, true)
  assert.ok(capped.text.length > 0)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
})

void test('a timed-out program does not leave its child behind', async () => {
  const host = await fakeHost()
  const dockerPath = path.join(host.root, 'docker')
  const pidFile = path.join(host.root, 'child.pid')
  await writeFile(
    dockerPath,
    `#!/bin/sh\nsleep 5 &\necho $! > '${pidFile}'\nwait\n`,
    { mode: 0o755 },
  )
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
    '#!/bin/sh\nprintf "cwd=%s\\nargs=%s\\n" "$PWD" "$*"\n',
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
    const described = await connection.request({ op: 'ops.describe', args: {} })
    const ops = JSON.parse(described.result ?? '[]') as DescribedOp[]
    const recreate = ops.find(op => op.name === 'deploy.recreate')
    assert.equal(recreate?.confirm, true)

    const answer = await connection.request({ op: 'deploy.recreate', args: {} })
    assert.equal(answer.ok, true)
    assert.match(answer.result ?? '', /^started \(pid \d+\)/u)
    // It runs detached, so the evidence is its own log, not the answer.
    await new Promise(resolve => setTimeout(resolve, 300))
    const log = await readFile(path.join(host.root, 'compose.log'), 'utf8')
    assert.match(log, new RegExp(`cwd=${checkout}`, 'u'))
    assert.match(
      log,
      /args=compose -f docker-compose\.yml -f docker-compose\.dev\.yml up -d --no-build/u,
    )
  } finally {
    connection.close()
    await broker.close()
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
