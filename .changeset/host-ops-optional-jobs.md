---
"@idsh/host-ops": patch
---

Read the job registry defensively: cordis throws when a plugin reads a service it did not inject, and
`jobs` is optional here — a deployment without it runs deploys synchronously. Before this, every tool
call failed with `cannot get property "jobs" without inject`.
