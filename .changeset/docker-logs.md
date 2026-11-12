---
"@idsh/host-broker": minor
---

Add `docker.logs`: the bounded tail of a host container's stdout and stderr, read with the fixed
`docker logs --tail` invocation and the same container-name validation as `docker.inspect`.
