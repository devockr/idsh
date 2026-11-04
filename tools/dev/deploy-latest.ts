#!/usr/bin/env node
// Deploy the long-lived `:latest` image: build it locally from this checkout, then recreate the
// deployment from it. This is the path the issue #89 notes as "compose build, then a manual compose
// up" — two steps with nothing in between, and one of them easy to get wrong.
//
// The dev overlay must NOT be merged here: it selects `:dev` and resets the build. This uses
// `docker-compose.latest.yml` instead, which names `devockr/idsh:latest` and drops the build stanza
// so `up` cannot rebuild a different thing than the image just built. `--dry` stops after the
// config has been resolved and says what would happen.
//
// The published Dockerfile installs every plugin by name and strictly, so this build fails while a
// plugin it ships is unpublished — that is the published image's contract, not a local mistake.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const dry = process.argv.includes('--dry')
const IMAGE = 'devockr/idsh:latest'

const die = (message: string): never => {
  console.error(`deploy:latest: ${message}`)
  process.exit(1)
}

const run = async (cmd: string, args: string[], extraEnv: Record<string, string> = {}) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  return stdout
}

const stderrOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    if ('stderr' in error && typeof error.stderr === 'string') {
      return error.stderr.trim()
    }
    if ('message' in error && typeof error.message === 'string') {
      return error.message.trim()
    }
  }
  return String(error).trim()
}

// docker is not on every PATH this runs under, so resolve it: $DOCKER, then PATH, then the usual
// places — the same order `deploy-dev.ts` uses, for the same reason.
const resolveDocker = async (): Promise<string> => {
  const candidates = [
    process.env.DOCKER,
    'docker',
    '/usr/local/bin/docker',
    '/usr/bin/docker',
    '/opt/bin/docker',
  ].filter((candidate): candidate is string => typeof candidate === 'string')
  for (const candidate of candidates) {
    try {
      await run(candidate, ['version'])
      return candidate
    } catch {
      // not this one
    }
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not this one either
    }
  }
  return die(
    'docker not found — run this on the host with docker on PATH, or set DOCKER=/path/to/docker',
  )
}

const dockerBin = await resolveDocker()
const docker = (args: string[], extraEnv?: Record<string, string>) => run(dockerBin, args, extraEnv)

const files = ['docker-compose.yml', 'docker-compose.latest.yml']
for (const file of files) {
  try {
    await fs.access(path.join(repo, file))
  } catch {
    die(`${file} is missing next to tools/`)
  }
}

const env = {
  UID: String(process.getuid?.() ?? ''),
  GID: String(process.getgid?.() ?? ''),
}
const compose = (args: string[]) =>
  docker(['compose', ...files.flatMap(file => ['-f', file]), ...args], env)

// Resolve first: this is the deployment about to be created, not the one running now.
interface Resolved {
  services?: Record<string, { image?: string; container_name?: string }>
}
const resolved = JSON.parse(await compose(['config', '--format', 'json'])) as Resolved
const service = resolved.services?.dsh ?? {}
if (service.image !== IMAGE) {
  die(
    `docker-compose.latest.yml must select ${IMAGE}; the resolved config says ${JSON.stringify(service.image)}`,
  )
}
const container = service.container_name ?? 'dsh'
console.log(`deploy:latest: image ${IMAGE}`)
console.log(`deploy:latest: container ${container}`)

if (dry) {
  console.log(
    'deploy:latest: --dry — would build the image and recreate the deployment; nothing ran',
  )
  process.exit(0)
}

// 1) The image itself. `--build-arg NPM_REGISTRY` only when the shell sets it, so the Dockerfile's
//    own default stands otherwise.
const buildArgs = ['build', '-f', 'Dockerfile', '-t', IMAGE]
if (process.env.NPM_REGISTRY) {
  buildArgs.push('--build-arg', `NPM_REGISTRY=${process.env.NPM_REGISTRY}`)
}
buildArgs.push('.')
console.log('deploy:latest: building the published image')
try {
  await docker(buildArgs)
} catch (error) {
  die(`the build failed; the running deployment was not touched:\n${stderrOf(error)}`)
}

// 2) Recreate from it. `compose up` removes the old container before creating the new one, so the
//    build above is what makes this the safe order: nothing is removed until the image exists.
console.log('deploy:latest: recreating the deployment')
try {
  await compose(['up', '-d'])
} catch (error) {
  die(`the deployment did not come up:\n${stderrOf(error)}`)
}

// 3) Say what is running, from inside the container rather than from the image: a recreate that
//    silently kept the old container would still pass the build above.
for (const line of [
  ['dsh', '--version'],
  ['gcb', '--version'],
]) {
  try {
    const answer = await docker(['exec', container, ...line], env)
    console.log(`deploy:latest: ${container}: ${line[0]} ${answer.trim()}`)
  } catch (error) {
    console.log(`deploy:latest: warning — could not read ${line[0]} — ${stderrOf(error)}`)
  }
}
try {
  const health = await docker(['inspect', container, '--format', '{{.State.Status}} {{.Image}}'])
  console.log(`deploy:latest: ${container}: ${health.trim()}`)
} catch (error) {
  die(`the container did not come up:\n${stderrOf(error)}`)
}
