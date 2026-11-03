---
"@idsh/host-broker": patch
---

`broker.update` decides how it was installed by comparing the running entry with `--checkout`; both
sides are now resolved through `realpath`, so a checkout reached through a symlink (the deployment's
`/var/services/…` against a process that resolved to `/volume1/…`) is recognised as the checkout it
is, instead of refusing with "cannot tell which npm prefix … belongs to".
