---
"@idsh/host-broker": minor
---

`gcb.update` can rebuild the credential broker's client image from the same checkout. The daemon and
the client were built from different places, so a deployment whose container bakes `gcb-client` (the
dev image does) kept the old client after the daemon moved; with `--gcb-client-image <tag>` the
operation builds both targets from the commit it pulled, and the client build fails before the host
pin moves, like the daemon build.
