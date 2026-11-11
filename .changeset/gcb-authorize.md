---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`gcb.authorize` runs the credential broker's device flow on the host, with the device-flow code
streamed into a followable job log and confirmation required. The operation only writes the token
through `gcb authorize`; gcb-host 0.9.0 serializes that write with the daemon's renewal through
`user.refresh.lock`, so a running sidecar needs no stop and a failed or cancelled flow leaves the
previous token untouched.
