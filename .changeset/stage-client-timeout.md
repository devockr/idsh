---
"@idsh/host-broker": patch
---

Give the client-staging probes their own 60 s bound instead of the 10 s local-query bound; a cold
`docker run --entrypoint gcb <client> --version` on a NAS image store exceeds 10 s and made
`client-bin` fail after a successful client build.
