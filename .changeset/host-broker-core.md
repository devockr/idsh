---
'@idsh/host-broker': minor
---

Add the first slice of the host broker: the unix-socket protocol, `log.tail`, `proc.read`,
`disk.usage`, `ops.describe`, rate limiting and an audit log. The dsh plugin that consumes it, and
`run(binary, argv)`, are not in this release.
