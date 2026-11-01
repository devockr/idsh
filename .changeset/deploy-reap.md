---
"@idsh/host-broker": minor
---

A `deploy.build`/`deploy.main` now retires the images earlier builds left behind: after the build it
removes every image labelled `idsh.keep=1` that is neither the one it just produced nor the recorded
rollback target. The label still keeps a locally built target through the host's `docker image
prune -a --filter 'label!=idsh.keep=1'`; what changes is that the exemption is bounded by the broker
instead of relying on an operator, so at most two such images stay on disk.
