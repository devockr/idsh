---
"@idsh/host-broker": minor
---

Add `deploy.rollback`: retag `:dev` to the image recorded in `<stateDir>/rollback` before the last
build — the manifest digest when it was pulled, the id otherwise — and recreate from it. A missing or
multi-line target is refused before anything is acknowledged; a target docker no longer has fails on
the tag, which is also recorded in `compose.log`.
