---
"@idsh/host-broker": minor
---

Add `deploy.rollback`: retag `:dev` to the image recorded in `<stateDir>/rollback` before the last
build — the manifest digest when it was pulled, the id otherwise — and recreate from it. A missing,
empty or multi-line target is refused before anything is queued; a target docker no longer has fails
on the tag, so nothing is acknowledged for a rollback that cannot happen.

Builds, recreates and rollbacks now share one deployment lock: a build cannot retag `:dev` while a
recreate's compose is starting, and a rollback's tag cannot land under a running build.
