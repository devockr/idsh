---
"@idsh/host-broker": minor
---

`gcb.update` can rebuild the credential broker's client image from the same checkout. The daemon and
the client were built from different places, so a deployment whose container bakes `gcb-client` (the
dev image does) kept the old client after the daemon moved; with `--gcb-client-image <tag>` the
operation builds both targets from the pulled commit, the client **before** the daemon image, so a
client failure cannot leave the tag the service runs replaced. After a later failure the operation
attempts to restore the tag when it recorded a running image — reported when it succeeds, and when
the restore itself fails, with the image it was meant to go back to; with no recorded image, or a
failed restore, the new tag stays. A client tag equal to the broker image is refused by canonical reference
(`docker.io`/`library/` and an implied `latest` included), because the two builds would share a
tag. Rebuilding idsh's dev image from the new client is `deploy.build` + `deploy.recreate`.
