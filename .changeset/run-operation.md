---
"@idsh/host-broker": minor
---

`run` joins the table: one declared, read-only binary per call — `ping`, `dig`, `traceroute`,
`ip addr/route/neigh`, `ss`, `df`, `free`, `uptime` — with an argv parsed against the declaration
instead of a shell, so an undeclared binary, an undeclared flag, a missing flag value or an extra
positional is `bad-argument` rather than something the host runs. `dryRun: true` answers the verdict
without executing, and the operation is `confirm: true`: a person is asked before a program starts on
the host. No declaration takes a filesystem path yet, so the race-safe path guard arrives with the
first one that does.
