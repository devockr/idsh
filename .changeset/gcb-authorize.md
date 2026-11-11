---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`gcb.authorize` runs the credential broker's device flow on the host, with the device-flow code
streamed into a followable job log and confirmation required. With gcb-host 0.9.0 the replacement is
serialized with the daemon through `user.refresh.lock`, so a running sidecar needs no stop. A flow
that fails before the replacement leaves the previous token in place; a timeout can fire after the
replacement has already happened, in which case the new token is already installed.
