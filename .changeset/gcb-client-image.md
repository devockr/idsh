---
"@idsh/host-broker": minor
---

`gcb.update` can rebuild the credential broker's client image from the same checkout. The daemon and
the client were built from different places, so a deployment whose container bakes `gcb-client` (the
dev image does) kept the old client after the daemon moved; with `--gcb-client-image <tag>` the
operation builds both targets from the commit it pulled, and the client build fails before the host
pin moves, like the daemon build. The client is built **before** the daemon image, so a client failure
cannot leave the tag the service runs replaced, and a failure after the daemon build restores that
tag to the image the service was running. A client tag equal to the broker image is refused, compared
by canonical reference (`docker.io`/`library/` and an implied `latest` included): the two builds
would share a tag, and the recreate would start the client target. Rebuilding idsh's dev image from
the new client is `deploy.build` + `deploy.recreate`.
