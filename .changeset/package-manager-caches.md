---
"@idsh/image": patch
---

The entrypoint records the package-manager cache locations in user-level config — `cache` in
`.npmrc`, `cache-folder` for Yarn Classic and `globalFolder` for Yarn 2/4 — inside the mounted state
directory, so they survive a rebuild and a project's own setting still wins. pnpm's store stays an
environment variable because pnpm 12 no longer reads `store-dir` from `.npmrc`.
