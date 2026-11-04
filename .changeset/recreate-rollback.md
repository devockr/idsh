---
"@idsh/host-broker": minor
---

A recreate verifies what it created. After `compose up -d`, `deploy.recreate` and `deploy.main`
watch the container they just started — pinned by id, so a container replaced under them is not
mistaken for the one that came up — and roll back to the image recorded before the last build when
it is not healthy. A container that exits or dies rolls back at once; one with no health status at
all counts as failed, because a boot line proves nothing on its own. The answer cannot report any
of this (the session's container is what was replaced), so the outcome is written to `compose.log`.
`docker-compose.example.yml` now carries the health check this requires.
