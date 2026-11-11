---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`gcb.authorize` authorizes the credential broker as a person without an operator shell: it runs the
device flow on the host while the sidecar keeps serving git, writes the token to a staging file,
and swaps it into the sidecar's `user.refresh` under a stop measured in seconds. The device-flow code
and the swap are in a followable job log; failures and cancellation leave the old token and the
sidecar exactly as they were.
