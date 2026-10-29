---
'@idsh/host-broker': minor
---

Add `proc.list`: the process table, read from `/proc/<pid>` (never the environment or the argv),
sorted by resident set and capped at `lines` (default 20, at most 100) — pid, parent, state, RSS in
KiB and the command name, one row each.
