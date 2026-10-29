---
"@idsh/host-broker": minor
---

Add `deploy.status` and `deploy.log`: the broker inspects the deployment container through one
fixed `docker` invocation — no shell and no caller-supplied argv — with `--container` and
`--docker` for hosts where either differs.
