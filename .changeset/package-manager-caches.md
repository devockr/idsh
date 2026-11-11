---
"@idsh/image": patch
---

The entrypoint records the package-manager cache locations in user-level config — `cache` in
`.npmrc`, `cache-folder` for Yarn Classic, `globalFolder` for Yarn 2/4 and `storeDir` in
pnpm's `config.yaml` — inside the mounted state directory, so they survive a rebuild and a
project's own setting still wins. A deployment that copied the compose file should add
`COREPACK_NPM_REGISTRY` from the example, because `docker exec` does not inherit the entrypoint's
export.
