---
"@idsh/host-broker": minor
---

`deploy.build` takes `target: 'base' | 'dev'`: `base` rebuilds `devockr/idsh:base` from the same
resolved source and root surface (no compiled tree, no rollback bookkeeping), so a `Dockerfile` or
`entrypoint.sh` change can be built from the session and the following `dev` build uses that base.
