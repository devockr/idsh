---
"@idsh/host-broker": minor
---

Add `service.status`: one systemd unit projected to `Id`, load/active/sub state, unit-file state,
main PID and exit status, through a fixed `systemctl show --property=…` invocation.
