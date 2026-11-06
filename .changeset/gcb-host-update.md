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
compose files. The pull is the one network step and does not rewrite the checkout's remote: git uses its
configuration, so ssh, HTTPS and the proxy behave exactly as they do for a manual pull. It is not
interactive (`GIT_TERMINAL_PROMPT=0`, and `BatchMode` when the operator has not configured an ssh
command) and bounded (60 s), because nobody is at a terminal and a network that answers nothing must
fail rather than hold the request open.

An update is two-phase because the two halves are separate processes: if the container recreate or
probe fails after the host half has been pinned, the halves run different commits until `gcb.update`
is run again. The failure answer says which half moved, and re-running converges both.
