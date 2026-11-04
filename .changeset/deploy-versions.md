---
"@idsh/host-broker": minor
---

`deploy.versions` answers what the deployment is actually running — the container's state, its image
and creation time, and the `dsh` and `gcb` versions inside it — in one read-only call. The probes are
fixed: the broker exposes no arbitrary exec, so "inspect the deployment" is a declared operation
rather than a shell, and an image without `gcb` says so instead of failing the read.
