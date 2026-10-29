---
'@idsh/host-broker': minor
---

Add `deploy.rollback`: retag `:dev` to the image recorded in `<stateDir>/rollback` before the last
build — the manifest digest when it was pulled, the id otherwise — and recreate from it. A missing,
empty, non-image or multi-line target is refused before anything is queued (the read-only
`docker image inspect` is that check); an image removed after it fails the deferred tag, which is
written to `compose.log` and stops the compose.

Builds, recreates and rollbacks now share one deployment lock: a build cannot retag `:dev` while a
recreate's compose is starting, and a rollback's tag cannot land under a running build. An operation that
finds another deployment running answers `unavailable` (stop it or wait, then run again) instead of
queueing; one whose answer times out is stopped, so it cannot finish its work behind the answer.
