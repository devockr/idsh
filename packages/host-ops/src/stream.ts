/**
 * Long deploy operations as dsh background jobs: the tool call returns an id at once, the broker
 * keeps building, and its `build.log` is followed into the job's output ring, which the UI streams
 * and the model reads with `job_output`. A tool call that is cut off (a container recreate, say)
 * therefore leaves a record that outlives it.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { BrokerAnswer, BrokerEndpoint } from './socket.ts'

/** How often the tailer looks for more of the broker's build log. */
const TAIL_INTERVAL_MS = 500

export interface JobHandle {
  append(
    text: string,
    options?: { readonly channel?: 'log' | 'stderr' | 'stdout' },
  ): void
  updateProgress(line: string): void
}

export interface JobOutcome {
  readonly status: 'completed' | 'failed' | 'killed'
  readonly detail?: string
  readonly result?: string
}

export interface JobHooks {
  done: Promise<JobOutcome>
  cancel(reason?: string): void
}

export interface JobSpec {
  readonly kind: string
  readonly label: string
  readonly owner?: string
  run(job: JobHandle): JobHooks
}

export interface Jobs {
  start(spec: JobSpec): string
}

export interface StreamTarget {
  readonly name: string
  readonly args: unknown
  readonly call: (
    endpoint: BrokerEndpoint,
    op: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<BrokerAnswer>
  readonly endpoint: BrokerEndpoint
  readonly statePath: string
  readonly owner?: string
}

/** Follow one file into a job's ring until the returned stop is called. */
function followBuildLog(
  job: JobHandle,
  file: string,
): { stop(): void; flush(): Promise<void> } {
  let offset = 0
  let stopped = false
  const read = async (): Promise<void> => {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (stopped || text === null || text.length <= offset) {
      return
    }
    job.append(text.slice(offset), { channel: 'stdout' })
    offset = text.length
  }
  const timer = setInterval(() => {
    void read()
  }, TAIL_INTERVAL_MS)
  return {
    async flush() {
      await read()
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** Start the operation as a job; the returned id is what the tool answers with. */
export function startDeployJob(jobs: Jobs, target: StreamTarget): string {
  const controller = new AbortController()
  let follow: { stop(): void; flush(): Promise<void> } | undefined
  return jobs.start({
    kind: 'deploy',
    label: `${target.name} ${JSON.stringify(target.args)}`,
    ...(target.owner === undefined ? {} : { owner: target.owner }),
    run(job) {
      job.append(`$ ${target.name}\n`, { channel: 'log' })
      follow = followBuildLog(job, path.join(target.statePath, 'build.log'))
      const work: Promise<JobOutcome> = (async (): Promise<JobOutcome> => {
        try {
          const answer = await target.call(
            target.endpoint,
            target.name,
            target.args as Record<string, unknown>,
            controller.signal,
          )
          job.append(answer.text, { channel: 'stdout' })
          return { status: 'completed', result: answer.text }
        } catch (error) {
          return {
            status: 'failed',
            result: error instanceof Error ? error.message : String(error),
          }
        } finally {
          // One last read: a build that finished within one tick leaves its tail only here.
          await follow.flush()
          follow.stop()
        }
      })()
      return {
        done: work,
        cancel() {
          follow?.stop()
          controller.abort()
        },
      }
    },
  })
}
