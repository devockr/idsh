import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { callBroker } from '../src/socket.ts'
import { fakeBroker } from './server.ts'

const answer = (value: unknown): string => `${JSON.stringify(value)}\n`

void test('a call goes out as one line and comes back as its result', async () => {
  const broker = await fakeBroker(() => answer({ ok: true, result: 'boot ok' }))
  try {
    const result = await callBroker({ socketPath: broker.socketPath }, 'log.tail', {
      file: 'messages',
    })
    assert.deepEqual(result, { text: 'boot ok', truncated: false })
    assert.deepEqual(broker.requests, [{ op: 'log.tail', args: { file: 'messages' } }])
  } finally {
    await broker.close()
  }
})

void test('a refusal keeps the broker message', async () => {
  const broker = await fakeBroker(() =>
    answer({
      ok: false,
      error: { code: 'unknown-op', message: 'no operation named "nope"' },
    }),
  )
  try {
    await assert.rejects(
      callBroker({ socketPath: broker.socketPath }, 'nope', {}),
      /no operation named "nope"/u,
    )
  } finally {
    await broker.close()
  }
})

void test('a broker that does not answer times out', async () => {
  const broker = await fakeBroker(() => null)
  try {
    await assert.rejects(
      callBroker({ socketPath: broker.socketPath, timeoutMs: 50 }, 'proc.read', {}),
      /did not answer within 50 ms/u,
    )
  } finally {
    await broker.close()
  }
})

void test('an answer that is not JSON is refused', async () => {
  const broker = await fakeBroker(() => 'not json\n')
  try {
    await assert.rejects(
      callBroker({ socketPath: broker.socketPath }, 'proc.read', {}),
      /not JSON/u,
    )
  } finally {
    await broker.close()
  }
})

void test('an aborted call settles without waiting for the broker', async () => {
  const broker = await fakeBroker(() => null)
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      callBroker({ socketPath: broker.socketPath }, 'proc.read', {}, controller.signal),
      /cancelled/u,
    )
  } finally {
    await broker.close()
  }
})

void test('a capped answer keeps the flag', async () => {
  const broker = await fakeBroker(() => answer({ ok: true, result: 'x', truncated: true }))
  try {
    const result = await callBroker({ socketPath: broker.socketPath }, 'log.tail', {})
    assert.deepEqual(result, { text: 'x', truncated: true })
  } finally {
    await broker.close()
  }
})

void test('a line past the ceiling is refused', async () => {
  const broker = await fakeBroker(() => 'x'.repeat(1024 * 1024 + 1))
  try {
    await assert.rejects(
      callBroker({ socketPath: broker.socketPath, timeoutMs: 5000 }, 'log.tail', {}),
      /past the line ceiling/u,
    )
  } finally {
    await broker.close()
  }
})
