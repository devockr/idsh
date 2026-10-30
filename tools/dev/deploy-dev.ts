#!/usr/bin/env node
// Recreate the deployment from the `:dev` image, the way this repo intends: the dev overlay is
// always merged in, compose never builds (`pnpm dev` does that, in that order), and the binds are
// pre-flighted so a mistake cannot take the deployment down. `--dry` stops after the pre-flight.
//
// `docker compose up -d` removes the old container before creating the new one, so anything that
// would make the create fail is worth catching first.
//
// This one runs from a checkout on the host, where the root package.json makes `.ts` ESM. Tools
// the image ships and runs itself keep the `.mts` extension: /opt/dsh/tools has no package.json,
// so a `.ts` there would be CommonJS.
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const dry = process.argv.includes('--dry')

const die = (message: string): never => {
  console.error(`deploy:dev: ${message}`)
  process.exit(1)
}

const run = async (
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> => {
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

// docker is not on every PATH this runs under — a login shell here has node and pnpm but not
// /usr/local/bin — so resolve it: $DOCKER, then PATH, then the usual places.
/** The first candidate that runs: on PATH, or the places a login shell may leave out. */
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

let dockerBin: string | undefined
const docker = async (args: string[], extraEnv?: Record<string, string>): Promise<string> => {
  const bin = dockerBin ?? (await resolveDocker())
  dockerBin = bin
  return run(bin, args, extraEnv)
}

const files = ['docker-compose.yml', 'docker-compose.dev.yml']
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
const compose = (args: string[]): Promise<string> =>
  docker(['compose', ...files.flatMap(file => ['-f', file]), ...args], env)

// 1) What will be deployed, and to which image — read from the resolved config, so this is the
//    deployment about to be created rather than the one that is running now.
interface Mount {
  type?: string
  source?: string
  target?: string
  read_only?: boolean
  bind?: { create_host_path?: boolean }
}
/** A bind mount compose will not create: both paths are known and the source is absolute. */
interface BindMount extends Mount {
  source: string
  target: string
}
const bindsOf = (list: Mount[]): BindMount[] =>
  list.filter(
    (mount): mount is BindMount =>
      mount.type === 'bind' &&
      typeof mount.source === 'string' &&
      typeof mount.target === 'string' &&
      mount.source.startsWith('/'),
  )
interface Service {
  image?: string
  container_name?: string
  volumes?: Mount[]
}
interface Resolved {
  name?: string
  services?: Record<string, Service>
}
const resolved = JSON.parse(await compose(['config', '--format', 'json'])) as Resolved
const service = resolved.services?.dsh ?? {}
const image = service.image ?? 'devockr/idsh:dev'
console.log(`deploy:dev: image ${image}`)

// 2) Pre-flight: create a throwaway container with exactly the mounts the config declares. A bind
//    source that does not resolve fails here, where nothing is at stake — `compose up` would fail
//    the same way *after* removing the old container, which is what makes this worth doing.
// Bind mounts only, and only those compose will not create itself: a named volume cannot fail to
// resolve, and checking one would create a stray volume; a bind compose creates cannot fail either.
const mounts = bindsOf(service.volumes ?? [])
// Only an explicit `create_host_path: false` means compose will refuse a missing source. The
// default is true, and compose either writes it out or leaves it to the default depending on its
// version — the 2.20.1 here writes `true`, Compose 5.5.0 omits it — so neither a missing field
// nor `true` may be read as "compose will create it".
const created = mounts.filter(mount => mount.bind?.create_host_path !== false)
const strict = mounts.filter(mount => mount.bind?.create_host_path === false)

// Compose creates a missing bind source as a *directory*, so a file that is supposed to be there
// (a config, a key, a CA bundle) would become an empty directory and its reader would exit at
// boot — long after `up` returned and, for the broker, after `dsh` was removed. Those sources are
// checked here by name, because the resolved config cannot say which mounts are files: the
// `create_host_path` field is written by some compose versions and omitted by others.
const FILE_SOURCE = /\.(?:json|key|pem|ya?ml|conf|env|crt|log)$/iu
const fileSources = (list: BindMount[]): BindMount[] =>
  list.filter(mount => FILE_SOURCE.test(mount.source))
for (const mount of fileSources(
  bindsOf(Object.values(resolved.services ?? {}).flatMap(s => s.volumes ?? [])),
)) {
  try {
    // A directory is what a short-syntax mount of a missing file leaves behind, so "it exists"
    // is not the question: it has to be a file.
    if (!statSync(mount.source).isFile()) {
      throw new Error('not a file')
    }
  } catch {
    die(`bind source ${mount.source} is not a file; nothing was touched`)
  }
}
// --mount, not -v: -v creates a missing host path on a standard engine, so the check would pass
// for the very mount it exists to catch, and would leave a root-owned directory behind even on
// --dry. Docker parses the value as CSV, so a field needing quoting goes to the warning pass
// instead: this daemon refuses a quoted field outright (measured), a standard engine accepts it.
/** `statSync`, or a stop that names the service and the source it could not read. */
const codeOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return ''
  }
  return typeof error.code === 'string' ? error.code : ''
}
const statsOf = (source: string, serviceName: string): Stats => {
  try {
    return statSync(source)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return die(
        `service ${serviceName}: bind source ${source} does not exist; nothing was touched`,
      )
    }
    return die(
      `service ${serviceName}: cannot read bind source ${source} (${codeOf(error) || 'unknown error'}); nothing was touched`,
    )
  }
}
const needsQuoting = (mount: BindMount): boolean => /[",]/.test(mount.source + mount.target)
const toArgs = (list: BindMount[]): string[] =>
  list.flatMap(mount => [
    '--mount',
    `type=bind,source=${mount.source},target=${mount.target}${mount.read_only ? ',readonly' : ''}`,
  ])
const gated = strict.filter(mount => !needsQuoting(mount))
const warned = [...created, ...strict.filter(needsQuoting)]

if (gated.length === 0) {
  console.log('deploy:dev: no bind needs pre-flighting')
} else {
  try {
    await docker(['run', '--rm', ...toArgs(gated), '--entrypoint', 'true', image])
  } catch (error) {
    die(`bind pre-flight failed, nothing was touched:\n${stderrOf(error)}`)
  }
  console.log('deploy:dev: bind pre-flight passed')
}
// Not a gate, but worth seeing: the outage this pre-flight was written for was a bind whose source
// was missing and which the daemon then refused.
if (warned.length > 0) {
  try {
    await docker(['run', '--rm', ...toArgs(warned), '--entrypoint', 'true', image])
  } catch (error) {
    console.log(
      `deploy:dev: warning — ${warned.length} bind(s) compose may create do not mount here:\n${stderrOf(error)}`,
    )
  }
}

// Every other service the same `up` creates can take the deployment down just as well, so the
// two failures that need nothing but the config and the daemon are checked here too: an image the
// daemon does not have, and a container name another project already owns (the broker's sidecar
// is called `gcb` by default, which is now this overlay's name for it as well).
const project = resolved.name ?? ''
for (const [name, other] of Object.entries(resolved.services ?? {})) {
  if (name === 'dsh') {
    continue
  }
  const otherImage = other.image
  if (otherImage) {
    try {
      await docker(['image', 'inspect', otherImage])
    } catch {
      die(`service ${name}: image ${otherImage} is not in this daemon; nothing was touched`)
    }
  }
  const containerName = other.container_name
  if (containerName) {
    // `docker inspect` exits non-zero for a container that does not exist, which is the first
    // deploy and the one after `docker compose down`: the name is free, not a conflict.
    let owner: string | undefined
    let heldBy: string | undefined
    try {
      const labels = (
        await docker([
          'inspect',
          '--type',
          'container',
          containerName,
          '--format',
          '{{ index .Config.Labels "com.docker.compose.project" }} {{ index .Config.Labels "com.docker.compose.service" }}',
        ])
      ).trim()
      const [projectLabel = '', serviceLabel = ''] = labels.split(' ')
      owner = projectLabel
      heldBy = serviceLabel
    } catch (error) {
      const message = stderrOf(error)
      if (!/no such (?:object|container)/iu.test(message)) {
        die(`service ${name}: could not inspect container ${containerName}:\n${message.trim()}`)
      }
      owner = undefined
    }
    // The same project is fine only for the same service: another service of this stack holding
    // the name fails `up` just the same, and by then `dsh` is gone.
    if (owner !== undefined && (owner !== project || heldBy !== name)) {
      die(
        `service ${name}: a container named ${containerName} already exists` +
          (owner === '' ? '' : ` (project ${owner})`) +
          '; stop it or drop the service; nothing was touched',
      )
    }
  }
  const otherBinds = bindsOf(other.volumes ?? [])
  const otherStrict = otherBinds.filter(mount => mount.bind?.create_host_path === false)
  // Checked against the filesystem, not by starting the image: a strict bind source must exist,
  // and running a companion image just to prove that would fail on one without `true` (distroless).
  for (const mount of otherStrict) {
    const stats = statsOf(mount.source, name)
    // A file source that a directory took over is the case the file check exists for; a directory
    // that a stray file took over fails the other way — the daemon cannot bind it, the healthcheck
    // never passes, and `dsh` is already gone by then.
    if (FILE_SOURCE.test(mount.source)) {
      if (!stats.isFile()) {
        die(`service ${name}: bind source ${mount.source} is not a file; nothing was touched`)
      }
      try {
        accessSync(mount.source, constants.R_OK)
      } catch {
        die(`service ${name}: bind source ${mount.source} is not readable; nothing was touched`)
      }
      continue
    }
    if (!stats.isDirectory()) {
      die(`service ${name}: bind source ${mount.source} is not a directory; nothing was touched`)
    }
    // Written as the same uid the container runs as, so a directory it cannot write is a failure
    // the pre-flight is allowed to predict — but only when the mount is actually meant to be
    // written: a read-only bind is not supposed to be, and refusing it would reject a working
    // deployment.
    if (mount.read_only !== true) {
      try {
        accessSync(mount.source, constants.W_OK)
      } catch {
        die(`service ${name}: bind source ${mount.source} is not writable; nothing was touched`)
      }
    }
  }
  const otherWarned = otherBinds.filter(mount => needsQuoting(mount))
  if (otherWarned.length > 0) {
    console.log(
      `deploy:dev: warning — service ${name}: ${otherWarned.length} bind(s) cannot be pre-flighted (a comma or a quote in a path)`,
    )
  }
}

if (dry) {
  console.log('deploy:dev: --dry, stopping before the recreate')
  process.exit(0)
}

// 3) Recreate. `--no-build` plus the overlay's `pull_policy: never` means this either uses the
//    image `pnpm dev` built or fails saying so.
//
//    The service's container is removed first, deliberately. Left in place, `up` creates the
//    replacement under a generated name (<project>_<service>), swaps it into position and drops
//    the old one — and a container manager watching docker events records that transient name as
//    a container, then keeps a dead entry it can never act on (a NAS UI showing a container that
//    does not exist). Removing the old container first leaves the name free, so `up` creates it
//    directly and the only name anything ever sees is the real one.
//    Removing the old container means anything that makes `up` fail takes the deployment down
//    with it, so what can be known first is checked first: with `pull_policy: never` a missing
//    image is the predictable failure, and it used to fail before anything was touched. The
//    pre-flight run above happens to prove the image exists too, but only when the deployment
//    mounts something — a config with no mounts never reaches docker before the removal.
const devImage =
  service.image ?? die('the overlay names no image, so there is nothing to recreate from')
try {
  await docker(['image', 'inspect', devImage])
} catch {
  die(`image ${devImage} is not in this daemon — run \`pnpm dev\` first; nothing was touched`)
}
console.log('deploy:dev: recreating (remove the container, then up --no-build)')
try {
  await compose(['rm', '-sf', 'dsh'])
  await compose(['up', '-d', '--no-build'])
} catch (error) {
  die(
    `compose recreate failed after the old container was removed — the deployment is down; fix the cause and run this again:\n${stderrOf(error)}`,
  )
}

// A container is not instant on a small NAS: every boot re-resolves the profile and its plugins,
// which has taken over two minutes here. The wait is therefore generous by default and overridable
// for a host that needs longer.
const configuredWaitMs = Number(process.env.DEPLOY_WAIT_MS)
// An empty value is 0 and a typo is NaN; both would make the loop below never run at all, which is
// the very false failure this is here to avoid. Only a positive, finite number overrides the default.
const READINESS_WAIT_MS =
  Number.isFinite(configuredWaitMs) && configuredWaitMs > 0 ? configuredWaitMs : 5 * 60 * 1000
const READINESS_POLL_MS = 4000

const isReady = async (): Promise<boolean> => {
  try {
    const running = await docker(['inspect', 'dsh', '--format', '{{.State.Running}}'])
    if (running.trim() !== 'true') {
      return false
    }
    const logs = await docker(['logs', '--tail', '100', 'dsh'])
    return logs.includes('dsh web:')
  } catch {
    return false
  }
}

const attempts = Math.ceil(READINESS_WAIT_MS / READINESS_POLL_MS)
for (let attempt = 1; attempt <= attempts; attempt++) {
  if (await isReady()) {
    const runningImage = await docker(['inspect', 'dsh', '--format', '{{.Config.Image}}'])
    console.log(`deploy:dev: up — ${runningImage.trim()}`)
    process.exit(0)
  }
  await sleep(READINESS_POLL_MS)
}

// A false failure is worse than a slow one: when the wait runs out, show what the container
// actually said, so "not up yet" and "up but silent" can be told apart at a glance.
// `docker logs` writes the container's stderr to its own, and a boot that fails usually says why
// there — so take both streams, and fall back to the error text when the call itself fails.
const lastLines = await execFileAsync(dockerBin ?? 'docker', ['logs', '--tail', '20', 'dsh'], {
  cwd: repo,
  encoding: 'utf8',
})
  .then(({ stdout, stderr }) => `${stdout}${stderr}`)
  .catch((error: unknown) => stderrOf(error))
die(
  `the new container did not report "dsh web:" within ${Math.round(READINESS_WAIT_MS / 1000)}s ` +
    `(DEPLOY_WAIT_MS overrides it). Its last lines:\n${lastLines.trim()}`,
)
