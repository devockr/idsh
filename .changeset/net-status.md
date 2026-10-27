---
"@idsh/host-broker": minor
---

Add `net.status`: the host's addresses, routes and neighbours, read with `ip -br` — `what` picks
`addr`, `route`, `neigh` or `all` (the default), and each table is its own section. The client is
resolved the way the deployment's `ip` is installed (the first of `/usr/bin/ip`, `/usr/sbin/ip`,
`/sbin/ip`, `/bin/ip`), and `--ip` overrides it.
