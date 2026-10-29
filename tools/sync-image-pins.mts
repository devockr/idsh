#!/usr/bin/env node
/**
 * Keep the `dsh plugin --profile web add <pkg>@<version>` pins in `Dockerfile` at the versions the
 * workspace declares, so the image a release builds names what that release published.
 *
 * The order is the point: `dsh plugin add` installs a pin strictly and fails while the version is
 * unpublished, so the Dockerfile cannot be bumped after `pnpm release`. It runs inside the
 * `version` script instead, right after `changeset version` — the version pull request therefore
 * carries the bumped package manifests and the Dockerfile together, and by the time the release
 * workflow publishes, `main` already names the versions being published.
 *
 * Only versions move, through `image-pins.mts`, so each line keeps the shape `renovate.json`'s
 * second custom manager parses: `dsh plugin … add` on one line, every package still written as
 * `@scope/name@version`. A workspace package the Dockerfile does not bake is reported rather than
 * added — whether the published image ships a plugin is not this script's decision.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPluginLine, rewritePins } from './image-pins.mts'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dockerfile = path.join(repo, 'Dockerfile')

/** The workspace packages, by the name each is published under. */
const workspacePackages = async (): Promise<Map<string, string>> => {
  const packages = new Map<string, string>()
  const entries = await fs.readdir(path.join(repo, 'packages'), {
    withFileTypes: true,
  })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(repo, 'packages', entry.name, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string }
    if (manifest.name && manifest.version) {
      packages.set(manifest.name, manifest.version)
    }
  }

  return packages
}

const versions = await workspacePackages()
const source = await fs.readFile(dockerfile, 'utf8')
const baked = new Set<string>()
const changed: string[] = []

const updated = source
  .split('\n')
  .map(line => {
    // Only the install lines are read, so a version elsewhere in the file is left alone.
    if (!isPluginLine(line)) {
      return line
    }
    return rewritePins(line, ({ name, version }) => {
      const wanted = versions.get(name)
      if (!wanted) {
        return
      }
      baked.add(name)
      if (wanted === version) {
        return
      }
      changed.push(`${name} ${version} -> ${wanted}`)
      return `${name}@${wanted}`
    })
  })
  .join('\n')

for (const name of versions.keys()) {
  if (!baked.has(name)) {
    console.warn(`sync-image-pins: ${name} is not baked into ${dockerfile}`)
  }
}

if (changed.length === 0) {
  console.log('sync-image-pins: Dockerfile already names the workspace versions')
} else {
  await fs.writeFile(dockerfile, updated)
  for (const line of changed) {
    console.log(`sync-image-pins: ${line}`)
  }
}
