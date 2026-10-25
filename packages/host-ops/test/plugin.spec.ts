import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  apply,
  registerTools,
  type HostContext,
  type HostTool,
} from '../src/index.ts'

import { fakeBroker } from './server.ts'

const TABLE = [
  {
    name: 'log.tail',
    summary: 'The last lines of a host log.',
    input: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'disk.usage',
    summary: 'df -h.',
    input: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function context(): {
  ctx: HostContext
  tools: HostTool[]
  warnings: string[]
} {
  const tools: HostTool[] = []
  const warnings: string[] = []
  return {
    tools,
    warnings,
    ctx: {
      tools: {
        register(tool) {
          tools.push(tool)
          return () => true
        },
      },
      logger: {
        warn(message) {
          warnings.push(message)
        },
      },
    },
  }
}

void test('the broker table becomes one tool per operation', async () => {
  const describe = `${JSON.stringify({ ok: true, result: JSON.stringify(TABLE) })}\n`
  const broker = await fakeBroker(request =>
    request.op === 'ops.describe'
      ? describe
      : `${JSON.stringify({ ok: true, result: 'answer' })}\n`,
  )
  try {
    const { ctx, tools } = context()
    await registerTools(ctx, { socketPath: broker.socketPath })
    assert.deepEqual(
      tools.map(tool => tool.name),
      ['log.tail', 'disk.usage'],
    )
    assert.deepEqual(tools[0]?.parameters, TABLE[0]?.input)
    const result = await tools[0]?.execute(
      { file: 'messages' },
      { signal: new AbortController().signal },
    )
    assert.equal(result, 'answer')
    assert.deepEqual(broker.requests.at(-1), {
      op: 'log.tail',
      args: { file: 'messages' },
    })
  } finally {
    await broker.close()
  }
})

void test('a broker that is down warns and registers no tools', async () => {
  const { ctx, tools, warnings } = context()
  apply(ctx, { socketPath: '/nonexistent/idsh-host/host.sock' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(tools, [])
  assert.equal(warnings.length, 1)
})
