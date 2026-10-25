#!/usr/bin/env node
/**
 * The `@deepseek-ai/*` peer ranges are a hard install gate: dsh refuses a plugin whose peers do not
 * match, so a range that misses the dsh the `Dockerfile` pins turns every build into a failure — and
 * a range that misses a line dsh has not published yet only shows up on the day it does, as a build
 * that suddenly cannot install its own plugins.
 *
 * This reads the pin the Dockerfile installs and the ranges the packages declare, and asks npm's own
 * semver whether they agree. It is the check the ritual in AGENTS cannot be: a person can forget, and
 * a dependency bump that moves the pin cannot read the ranges at all.
 *
 * The cordis peer is deliberately not judged here — it is pinned by cordis, not by dsh, so the dsh
 * pin says nothing about whether it fits.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import { dshPinIn } from './image-pins.mts'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const fail = (message: string): never => {
  console.error(`check-peer-ranges: ${message}`)
  process.exit(1)
}

const dockerfile = await fs.readFile(path.join(repo, 'Dockerfile'), 'utf8')
const pinned =
  dockerfile
    .split('\n')
    .map(line => dshPinIn(line)?.version)
    .find((version): version is string => version !== undefined) ??
  fail('no @deepseek-ai/dsh pin found in Dockerfile')

const packages = ['mobile', 'privileged-ui', 'remote-access', 'host-ops']
let checked = 0

for (const directory of packages) {
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(repo, 'packages', directory, 'package.json'),
      'utf8',
    ),
  ) as { name?: string; peerDependencies?: Record<string, string> }
  for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!peer.startsWith('@deepseek-ai/dsh-')) {
      continue
    }
    if (!semver.satisfies(pinned, range)) {
      fail(
        `${manifest.name ?? directory} declares ${peer} "${range}", which does not accept the pinned dsh ${pinned} — dsh would refuse to install it`,
      )
    }
    checked += 1
  }
}

console.log(
  `check-peer-ranges: ${String(checked)} peer range(s) accept the pinned dsh ${pinned}`,
)
