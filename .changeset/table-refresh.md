---
"@idsh/host-ops": minor
"@idsh/image": patch
---

The broker's table is asked for again every minute, and the tools are replaced when it changed. A
broker upgrade used to need a container recreate even when the plugin itself had not changed — the
table was read once at load — so a new operation stayed invisible until the whole container was
replaced. The re-read is one socket roundtrip and an unchanged table registers nothing; the new tools
are mounted after the old ones are disposed (the registry is keyed by name, so both cannot be visible
at once) and the old ones are put back if the new mount fails, so a bad table leaves what worked in
place. The plugin's own disposal clears the timer, and `refreshMs` (a minute by default) sets the interval.
