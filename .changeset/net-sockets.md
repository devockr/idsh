---
'@idsh/host-broker': minor
---

Add `net.sockets`: the host's listening sockets (`ss -tulpn`) and its TCP/UDP connections
(`ss -tunp`), one `## <table>` section each; `what` picks `listen`, `connections` or `all` (the
default). The `ss` client is resolved from the usual locations with a `PATH` fallback, and `--ss`
overrides it.
