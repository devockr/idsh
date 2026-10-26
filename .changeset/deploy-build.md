---
"@idsh/host-broker": minor
"@idsh/host-ops": patch
---

Add `deploy.build`: resolve a PR head or an origin branch tip with `git ls-remote` (fetching first, so
a stale checkout still works), pin `main` to the sha resolved at the same moment, clone into a fresh
temporary directory and replace the six root-surface files with main's, build `:dev` in the base image
with `--entrypoint`/`--user`, and record the previous image (manifest digest when pulled, id
otherwise) with the `idsh.keep=1` label. The plugin waits for the operation's own `timeoutMs`; the
build log lands in `<stateDir>/build.log`.
