---
"@idsh/image": minor
---

Bake `gcb-client` into the image and point git at the host's credential broker when its socket is
mounted: `entrypoint.sh` runs `gcb setup` as the deployment user before dsh, so a push asks the
host for a short-lived credential instead of the container holding one. Without the mount the setup
is skipped and nothing changes. `docker exec … gcb probe` answers the broker's decision.
