---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`gcb.authorize` authorizes the credential broker as a person without an operator shell: it
stops the sidecar, runs `gcb authorize --broker-container` on the host, streams the device-flow code
and restart into a followable job log, and restarts the sidecar whether the flow succeeds or not.
