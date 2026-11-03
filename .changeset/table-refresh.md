---
"@idsh/host-ops": minor
---

The broker's table is asked for again every minute, and the tools are replaced when it changed. A
broker upgrade used to need a container recreate even when the plugin itself had not changed — the
table was read once at load — so a new operation stayed invisible until the whole container was
replaced. The re-read is one socket roundtrip and an unchanged table registers nothing; a table that
cannot be loaded leaves the mounted tools in place, and the plugin's own disposal clears the timer.
