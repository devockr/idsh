---
"@idsh/image": patch
---

The published image installs `gcb-client@0.2.0`, matching the `gcb-host` 0.2.0 the broker's daemon
runs. `:dev` already takes its client from `code-vaults/gcb-client:dev`, so this is the released
image catching up rather than a new capability.
