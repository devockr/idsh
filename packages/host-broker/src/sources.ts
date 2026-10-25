/**
 * The operations this slice exposes.
 *
 * Each one names a **source** rather than a command: a fixed set of files or one fixed program,
 * with a small set of validated arguments. That is the whole shape — the questions asked of a host
 * are unbounded, the places an answer can come from are not. Nothing here takes a path or an
 * arbitrary argument, so there is no path guard to get wrong yet.
 */
import { execFile } from 'node:child_process'
import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { MAX_PATTERN_CHARS, TAIL_WINDOW_BYTES } from './constants.js'
import { BrokerFault } from './protocol.js'

const run = promisify(execFile)

/** Where an operation reads from, and how long a program it starts may run. */
export interface OpContext {
  readonly logDir: string
  readonly procDir: string
  readonly execTimeoutMs: number
}

/** One typed operation. `input` is the JSON Schema the plugin turns into a tool parameter. */
export interface OpDefinition {
  readonly name: string
  readonly summary: string
  readonly input: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: OpContext): Promise<string>
}

/* ------------------------------------------------------------------ argument checks */

function rejectUnknown(
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new BrokerFault(
        'bad-argument',
        `unknown argument ${JSON.stringify(key)}`,
      )
    }
  }
}

function choice<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = args[name]
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be one of ${allowed.map(item => JSON.stringify(item)).join(', ')}`,
    )
  }
  return value as T
}

function integer(
  args: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = args[name]
  if (value === undefined) {
    return fallback
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be an integer between ${min} and ${max}`,
    )
  }
  return value
}

function text(
  args: Record<string, unknown>,
  name: string,
  maxChars: number,
): string | undefined {
  const value = args[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length > maxChars) {
    throw new BrokerFault(
      'bad-argument',
      `${name} must be a string of at most ${maxChars} characters`,
    )
  }
  return value
}

/* ------------------------------------------------------------------ log.tail */

/** The one directory `log.tail` reads, and the only three names it knows inside it. */
const LOG_FILES = {
  messages: 'messages',
  syslog: 'syslog',
  kern: 'kern.log',
} as const

type LogFile = keyof typeof LOG_FILES

/**
 * The last `lines` rows of one log.
 *
 * A window is read from the end rather than the whole file: a log can be gigabytes, and the answer
 * is bounded anyway. When the window does not start at a line boundary the partial first row is
 * dropped, so a caller never sees half a line.
 */
async function tail(
  file: LogFile,
  lines: number,
  pattern: string | undefined,
  ctx: OpContext,
): Promise<string> {
  const filePath = path.join(ctx.logDir, LOG_FILES[file])
  let info
  try {
    info = await stat(filePath)
  } catch {
    throw new BrokerFault(
      'unavailable',
      `${file} is not being written on this host`,
    )
  }
  if (!info.isFile()) {
    throw new BrokerFault('unavailable', `${file} is not a regular file`)
  }

  const offset = Math.max(0, info.size - TAIL_WINDOW_BYTES)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, TAIL_WINDOW_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    let body = buffer.subarray(0, bytesRead).toString('utf8')
    if (offset > 0) {
      const firstBreak = body.indexOf('\n')
      body = firstBreak === -1 ? '' : body.slice(firstBreak + 1)
    }
    let rows = body.split('\n').filter(row => row !== '')
    // A literal substring, not a regular expression: nothing to escape, nothing that can backtrack.
    if (pattern !== undefined) {
      rows = rows.filter(row => row.includes(pattern))
    }
    return rows.slice(-lines).join('\n')
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ proc.read */

/** The fixed set `proc.read` can answer from. */
const PROC_FILES = {
  mdstat: 'mdstat',
  loadavg: 'loadavg',
  meminfo: 'meminfo',
  uptime: 'uptime',
  vmstat: 'vmstat',
} as const

type ProcFile = keyof typeof PROC_FILES

async function readProc(file: ProcFile, ctx: OpContext): Promise<string> {
  try {
    return await readFile(path.join(ctx.procDir, PROC_FILES[file]), 'utf8')
  } catch {
    throw new BrokerFault('unavailable', `${file} is not readable on this host`)
  }
}

/* ------------------------------------------------------------------ disk.usage */

/** One fixed program with one fixed argument: the shape every `run` operation will take. */
async function diskUsage(ctx: OpContext): Promise<string> {
  try {
    const { stdout } = await run('df', ['-h'], {
      timeout: ctx.execTimeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const reason =
      typeof stderr === 'string' && stderr.trim() !== ''
        ? stderr.trim()
        : 'df failed'
    throw new BrokerFault('unavailable', reason)
  }
}

/* ------------------------------------------------------------------ the table */

export const OPS: readonly OpDefinition[] = [
  {
    name: 'log.tail',
    summary:
      'The last lines of a host log, optionally only the lines containing a literal string.',
    input: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['messages', 'syslog', 'kern'],
          description: 'Which host log to read.',
        },
        lines: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'How many trailing lines to return. Default 100.',
        },
        pattern: {
          type: 'string',
          maxLength: MAX_PATTERN_CHARS,
          description:
            'Keep only rows containing this literal text (not a regular expression).',
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['file', 'lines', 'pattern'])
      const file = choice(args, 'file', ['messages', 'syslog', 'kern'])
      const lines = integer(args, 'lines', 1, 500, 100)
      return tail(file, lines, text(args, 'pattern', MAX_PATTERN_CHARS), ctx)
    },
  },
  {
    name: 'proc.read',
    summary:
      'One of a fixed set of kernel state files: mdstat, loadavg, meminfo, uptime, vmstat.',
    input: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['mdstat', 'loadavg', 'meminfo', 'uptime', 'vmstat'],
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      rejectUnknown(args, ['file'])
      const file = choice(args, 'file', [
        'mdstat',
        'loadavg',
        'meminfo',
        'uptime',
        'vmstat',
      ])
      return readProc(file, ctx)
    },
  },
  {
    name: 'disk.usage',
    summary: 'df -h: the mounted filesystems and how full they are.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    async run(args, ctx) {
      rejectUnknown(args, [])
      return diskUsage(ctx)
    },
  },
]

export function findOp(name: string): OpDefinition | undefined {
  return OPS.find(op => op.name === name)
}

/** The table as the plugin sees it: names, summaries and the parameter schema of each. */
export function describeOps(): string {
  return JSON.stringify(
    OPS.map(({ name, summary, input }) => ({ name, summary, input })),
    null,
    2,
  )
}
