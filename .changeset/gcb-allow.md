---
"@idsh/host-broker": minor
---

`gcb.allow` edits one credential-broker allowlist entry from the session, through the staged gcb host
CLI's typed `config allow add|remove`: the file is written by gcb's atomic replace, so the daemon
reloads without a restart, and the entry must be an exact `owner/name` (no glob or URL). The host
defaults to `github.com`; the operation is offered when the broker was started with `--gcb-host`,
because it runs `<deploy-dir>/app/packages/host/bin/gcb.js` and edits
`<deploy-dir>/config/broker.config.yml`.
