---
"@idsh/host-broker": minor
---

Add `docker.ps` and `docker.inspect`: read-only projections of the host's containers (`ps` output, and
one container's state, health, restarts, exit, OOM and image), with no exec and no arbitrary flags.
