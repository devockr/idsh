/* eslint-disable no-magic-numbers -- the inputs of these tests are numbers */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startBroker } from '../src/broker.ts'
import { capOutput, RateLimiter } from '../src/limits.ts'
import { createLineReader, parseRequest } from '../src/protocol.ts'

const SMALL_LINE_LIMIT = 10
const LONG_ROW_CHARS = 40_000
const BYTES_PER_KIB = 1024
const OUTPUT_CAP_BYTES = 64 * BYTES_PER_KIB
const MODE_MASK = 0o777
const SOCKET_MODE = 0o600
const DIRECTORY_MODE = 0o700

/**
 * A throwaway host: a log directory, a proc directory, a socket and an audit log.
 *
 * @returns {Promise<{
 *   root: string
 *   logDir: string
 *   procDir: string
 *   socketPath: string
 *   auditPath: string
 * }>}
 *   the paths the broker is started with.
 */
async function fakeHost() {
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

/**
 * A line-oriented client: send one request, await the next response.
 *
 * @param {string} socketPath the broker's socket.
 * @returns {{ request: (message: object) => Promise<object>; close: () => void }} the client.
 */
function client(socketPath) {
  const socket = net.connect(socketPath)
  let buffer = ''
  let waiting
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') {
        continue
      }
      const resolve = waiting
      waiting = undefined
      resolve?.(JSON.parse(line))
    }
  })
  return {
    async request(message) {
      await ready
      return new Promise(resolve => {
        waiting = resolve
        socket.write(`${JSON.stringify(message)}\n`)
      })
    },
    close() {
      socket.destroy()
    },
  }
}

test('parseRequest accepts the shape it documents', () => {
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

test('parseRequest refuses what it cannot interpret', () => {
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
    assert.throws(() => parseRequest(line), undefined, line)
  }
})

test('the line reader splits, skips blank lines and reports an overrun', () => {
  const lines = []
  const overflow = []
  const read = createLineReader({
    onLine: line => lines.push(line),
    onOverflow: () => overflow.push(true),
    maxBytes: SMALL_LINE_LIMIT,
  })
  read('{"a":1}\n{"b"')
  read(':2}\n\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  assert.deepEqual(overflow, [])
  read('x'.repeat(SMALL_LINE_LIMIT + 1))
  assert.deepEqual(overflow, [true])
  // The oversized line is dropped whole; the reader is usable afterwards.
  read('{"c":3}\n')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
})

test('capOutput trims to the ceiling on a line boundary', () => {
  const short = 'one\ntwo\n'
  assert.deepEqual(capOutput(short), { text: short, truncated: false })

  const long = `${'x'.repeat(LONG_ROW_CHARS)}\n${'y'.repeat(LONG_ROW_CHARS)}\n`
  const capped = capOutput(long)
  assert.equal(capped.truncated, true)
  assert.ok(Buffer.byteLength(capped.text) <= OUTPUT_CAP_BYTES)
  assert.ok(!capped.text.endsWith('\n'))
})

test('the rate limiter opens a window per key and refills', () => {
  const limiter = new RateLimiter(2, 1000)
  assert.equal(limiter.take('a', 0), true)
  assert.equal(limiter.take('a', 1), true)
  assert.equal(limiter.take('a', 2), false)
  assert.equal(limiter.take('b', 2), true)
  assert.equal(limiter.take('a', 1000), true)
})

test('the broker answers, audits, and keeps its socket private', async () => {
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
    assert.match(proc.result, /raid1/)

    const described = await connection.request({ op: 'ops.describe', args: {} })
    const ops = JSON.parse(described.result)
    assert.deepEqual(
      ops.map(op => op.name),
      ['log.tail', 'proc.read', 'disk.usage'],
    )
    assert.equal(ops[0].input.required[0], 'file')

    const unknown = await connection.request({ op: 'nope', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown-op')

    const badArg = await connection.request({
      op: 'log.tail',
      args: { file: '../etc/passwd' },
    })
    assert.equal(badArg.ok, false)
    assert.equal(badArg.error.code, 'bad-argument')
  } finally {
    connection.close()
    await broker.close()
  }

  const auditText = await readFile(host.auditPath, 'utf8')
  const audit = auditText
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
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

test('a live socket is not taken over, and a non-socket path is refused', async () => {
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
    /already listening/,
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
    /is not a socket/,
  )
})

test('a stale socket, left by a killed broker, is replaced', async () => {
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
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve)
      child.once('error', reject)
      child.once('exit', code =>
        reject(new Error(`the socket holder exited early (${code})`)),
      )
    })
  } finally {
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
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
