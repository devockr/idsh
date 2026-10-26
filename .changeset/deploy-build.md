---
"@idsh/host-broker": minor
"@idsh/host-ops": patch
---

Add `deploy.build`: resolve a PR head or an origin branch tip with `git ls-remote` (fetching first, so
a stale checkout still works), pin `main` to the sha resolved at the same moment, clone into a fresh
temporary directory and replace the six root-surface files with main's, then build `:dev` in the base
image with `--entrypoint`/`--user`. Images it produces carry `--label idsh.keep=1`, so a prune keeps
them; separately, the image the container was running before the build is recorded in
`<stateDir>/rollback` — its manifest digest when it was pulled, its id otherwise — as the rollback
target. The plugin waits for the operation's own `timeoutMs`; the build log lands in
`<stateDir>/build.log`.
