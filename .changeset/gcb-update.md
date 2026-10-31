---
"@idsh/host-broker": minor
---

Add `gcb.update`: rebuild the credential broker from its own checkout — `git pull`, then
`docker build --target host` with the image its compose file names — and recreate only that
container, then read back its state. It is offered only when `--gcb-checkout` and `--gcb-compose`
are both configured, asks the person first, and runs under the deployment lock.
