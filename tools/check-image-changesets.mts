#!/usr/bin/env node
/**
 * A release that changes what the image bakes has to move the image's version, because
 * `release.yml` publishes the image from that version and from nothing else. Without this check
 * such a release would publish packages and quietly ship no image at all: the version would not
 * move, so the job that waits for it would not run.
 *
 * One bump is enough. `changeset version` applies every pending changeset at once, so the image
 * only has to be named somewhere in the release, not in each changeset. What CI can see is one pull
 * request's changesets — a release consumes them, so `main` has none — which makes the rule
 * stricter than the release itself: a pull request that changes a baked package carries the bump
 * itself.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPluginLine, pinsIn } from './image-pins.mts'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const fail = (message: string): never => {
  console.error(`check-image-changesets: ${message}`)
  process.exit(1)
}

/** The image's own name, which is the only thing this check reads from its manifest. */
const image =
  (
    JSON.parse(await fs.readFile(path.join(repo, 'image/package.json'), 'utf8')) as {
      name?: string
    }
  ).name ?? fail('image/package.json has no name')

/** The packages the image bakes: the pins its Dockerfile installs, and nothing else. */
const baked = new Set<string>()
const dockerfile = await fs.readFile(path.join(repo, 'Dockerfile'), 'utf8')
for (const line of dockerfile.split('\n')) {
  if (!isPluginLine(line)) {
    continue
  }
  for (const { name } of pinsIn(line)) {
    baked.add(name)
  }
}

/** The package names a changeset names, from the front matter between its `---` lines. */
const namedIn = (source: string): string[] => {
  const [, front = ''] = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source) ?? []
  const names: string[] = []
  for (const line of front.split('\n')) {
    // `changeset add` writes double quotes; a changeset written by hand often arrives with single
    // ones, and YAML does not care which — so a check that only understood one of them would quietly
    // ignore exactly the changesets a person wrote.
    const match = /^["'](?<name>[^"']+)["']: (?:major|minor|patch)$/u.exec(line.trim())
    const name = match?.groups?.name
    if (name) {
      names.push(name)
    }
  }
  return names
}

const entries = await fs.readdir(path.join(repo, '.changeset'))
const files = entries.filter(file => file.endsWith('.md') && file !== 'README.md')

const changesets: Array<{ file: string; names: string[] }> = []
for (const file of files) {
  changesets.push({
    file,
    names: namedIn(await fs.readFile(path.join(repo, '.changeset', file), 'utf8')),
  })
}

/** The changesets that change a package the image bakes, whichever ones bump the image. */
const changes = changesets.filter(entry => entry.names.some(name => baked.has(name)))
const bumpsImage = changesets.some(entry => entry.names.includes(image))

if (changes.length > 0 && !bumpsImage) {
  fail(
    [
      `this release changes what the image bakes, but no pending changeset bumps ${image}:`,
      ...changes.map(
        entry =>
          `  .changeset/${entry.file} (${entry.names.filter(name => baked.has(name)).join(', ')})`,
      ),
      '',
      `Add \`"${image}"\` to one of them, with the bump the change deserves — \`patch\`,`,
      '`minor` or `major`. `release.yml` publishes the image from that version alone, so without a',
      'bump the image is never rebuilt.',
    ].join('\n'),
  )
}

console.log(
  bumpsImage
    ? `check-image-changesets: ${changesets.length} pending changeset(s), the image version moves with this release`
    : `check-image-changesets: ${changesets.length} pending changeset(s), nothing the image bakes changes`,
)
