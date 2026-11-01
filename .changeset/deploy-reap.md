---
"@idsh/host-broker": minor
---

A `deploy.build`/`deploy.main` now retires the images earlier builds left behind: after the build it
removes every image labelled `idsh.keep=1` that is neither the one it just produced nor the recorded
rollback target. The label still keeps a locally built target through the host's `docker image
prune -a --filter 'label!=idsh.keep=1'`; what changes is that the exemption is bounded by the broker
instead of relying on an operator. After a build at most two such images stay on disk; one whose
`docker image rm` fails stays until a later build retries it, and a listing longer than the broker's
output window removes nothing rather than sweeping the part it can see — as does an image this build
produced that does not resolve, since removing it would take the tag the recreate is about to use.
The build answer names whichever happened, so a sweep that finished short is visible instead of
looking complete.
