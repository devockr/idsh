#!/usr/bin/env node
// The body of the image's GitHub Release, taken from `image/CHANGELOG.md`.
//
// changesets writes that file with `@changesets/changelog-github` and the action has no output for it,
// and it will not create a Release for `@idsh/image` because that package is private — so the body is
// read back from the file changesets already wrote rather than kept anywhere a second time.
//
// The section is found by heading, not by pattern-matching prose: `## <version>` to the next `## `.
// A missing section is an error — a Release with an empty body is worse than a failed step.
//
// Usage: node tools/image-release-notes.mts <version>

import fs from 'node:fs/promises'

const [, , version] = process.argv

if (!version) {
  console.error('image-release-notes: needs a version, e.g. 0.0.4')
  process.exit(1)
}

const changelog = await fs.readFile(new URL('../image/CHANGELOG.md', import.meta.url), 'utf8')

const lines = changelog.split('\n')
const start = lines.findIndex(line => line.trim() === `## ${version}`)

if (start === -1) {
  console.error(`image-release-notes: image/CHANGELOG.md has no "## ${version}" section`)
  process.exit(1)
}

// Up to the next level-2 heading. Trimmed because changesets leaves a blank line before each one.
const rest = lines.slice(start + 1)
const end = rest.findIndex(line => line.startsWith('## '))
const notes = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()

if (!notes) {
  console.error(`image-release-notes: the "## ${version}" section is empty`)
  process.exit(1)
}

process.stdout.write(`${notes}\n`)
