---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`gcb.authorize` runs the credential broker's device flow on the host, with the device-flow code
streamed into a followable job log and confirmation required. The operation only writes the token
through `gcb authorize`; the sidecar stop/restart is left to the operator until gcb makes
`user.refresh` replacement safe on its own (gcb#143).
