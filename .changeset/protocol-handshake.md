---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`ops.describe` now answers with `{ protocol, version, ops }` instead of the bare table, and the plugin
compares that `protocol` with its own: a broker that sends no protocol (older than the plugin) or a
different one is named in a warning at load instead of surfacing later as an unknown argument. The
bare table is still accepted, so an older broker keeps working — the warning says to update both,
because the plugin ships in the image and the broker runs from the deployment's checkout, and neither
update carries the other.
