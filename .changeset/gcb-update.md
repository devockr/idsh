---
"@idsh/host-broker": minor
---

Add `gcb.update`: rebuild the credential broker from its own checkout — `git pull`, then
`docker build --target host` with the image its compose file names — and recreate only that
container, then read back its state. The compose file it is pointed at must run the broker alone, which `gcb compose` renders; a
file with several services is refused with their names rather than guessed at. It is offered only when `--gcb-checkout`, `--gcb-compose` and `--gcb-probe-repo`
are all configured, asks the person first, and runs under the deployment lock.
