---
"@idsh/host-broker": minor
---

`gcb.update` stages the client it builds under the deployment state
(`cache/gcb-client/<version>`, a `current` symlink, and `bin/gcb`), so a client-only update reaches a
running dsh without rebuilding the image or recreating the container.
