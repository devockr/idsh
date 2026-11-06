---
"@idsh/host-broker": minor
---

`gcb.update` now updates **both halves** of the credential broker from one commit, instead of leaving
the host-supervised one silently behind.

A host broker runs a staged export of the commit in `app.ref`; the containerised one is rebuilt from
the checkout. With `--gcb-host`, `gcb.update` refuses a dirty checkout (the two would otherwise run
different code while both calling themselves updated), pins the host broker to the commit it built,
restarts it, and only answers once the new pid reports that commit — or fails with the log to read.
The container half is unchanged and still optional: a host-only deployment passes `--gcb-host` and no
compose files. The pull is the one network step and is bounded (60 s, non-interactive): without an
agent or a proxy git waits on a prompt rather than failing, which was a hang, not an error.
