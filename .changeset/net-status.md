---
'@idsh/host-broker': minor
---

Add `net.status`: the host's addresses, routes and neighbours, read with `ip -br` — `what` picks
`addr`, `route`, `neigh` or `all` (the default), and each table is its own section. `route` reads
both address families (`ip -4 -br route` and `ip -6 -br route`), labelled, because `ip route`
alone is IPv4 and a dual-stack LAN needs both; a host that cannot answer one family fails the
request rather than returning a partial table. The client is resolved the way the deployment's
`ip` is installed (the first of `/usr/bin/ip`, `/usr/sbin/ip`, `/sbin/ip`, `/bin/ip`), and
`--ip` overrides it.
