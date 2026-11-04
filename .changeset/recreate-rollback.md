---
"@idsh/host-broker": minor
---

A recreate verifies what it created. After `compose up -d`, `deploy.recreate` and `deploy.main`
watch the container they just started — pinned by id, so a container replaced under them is not
mistaken for the one that came up — and roll back to the image recorded before the last build when
it is not healthy. A container that exits, dies, restarts in a loop, reports `unhealthy`, or declares
no healthcheck at all rolls back at once — a boot line proves nothing on its own — while one that is
merely starting is watched. The answer cannot report any of this (the session's container is what was
replaced), so the outcome is written to `compose.log`; `deploy.rollback` verifies its own result
there too, without rolling back again.
`docker-compose.example.yml` now carries the health check this requires.
