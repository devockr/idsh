---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

Add `deploy.recreate`: one fixed `docker compose up -d --no-build` in the configured checkout, marked
`confirm` in the table. The plugin now asks the person inside the tool call before any such operation
and treats anything but an explicit "Run" as no.
