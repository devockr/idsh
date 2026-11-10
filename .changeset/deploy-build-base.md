---
"@idsh/host-broker": minor
---

`deploy.build` takes `target: 'base' | 'dev'` (default `dev`). `base` rebuilds `devockr/idsh:base`
from `main` only — it refuses `pr`/`sha`, because the root surface those builds use is main's and the
base stage reads nothing else — carries the `idsh.keep=1` label so a host prune keeps it, and leaves
the `:dev` tag, the rollback record and the sweep alone. A following `dev` build uses that base.
