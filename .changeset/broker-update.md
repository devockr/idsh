---
'@idsh/host-broker': minor
---

Add `broker.status` (version, pid, start time, socket, audit file, checkout) and `broker.update`:
the broker pulls and builds itself from `--checkout` (`git pull`, `pnpm install`,
`pnpm --filter @idsh/host-broker build`), or installs the published package when it has no checkout,
then exits so its supervisor starts the new build. A failed step is the answer, not a silent no-op,
and no deployment can overlap the update.
