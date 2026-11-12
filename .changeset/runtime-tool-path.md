---
"@idsh/image": minor
---

Put `/home/app/.dsh/bin` first on `PATH`, so a tool staged under the state directory's
`cache/<tool>/<version>` (with a `current` symlink) can be updated without rebuilding the image.
`AGENTS.md` records the convention: link `.dsh/bin/<tool>` to `../cache/<tool>/current/bin/<tool>`.
