---
"@idsh/host-broker": minor
---

Add `gcb.update`: rebuild the credential broker from its own checkout — `git pull`, then
`docker build --target host` with the image its compose names — recreate only that service with
`--no-build --pull never --wait`, and probe it through the deployment's own client. `--gcb-compose`
takes one or more files, comma-separated (a base file plus an overlay), and `--gcb-service` (default
`gcb`) names the broker inside them; both are validated at boot and against `config --services`.
It asks the person first, runs under the deployment lock, and refuses a service that declares more
than one container.
