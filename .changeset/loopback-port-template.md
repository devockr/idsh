---
"@idsh/image": patch
---

The compose template publishes `15080` on loopback instead of every interface, and `DSH_TRUSTED_HOSTS`
no longer defaults to a placeholder name. Deployments built from the template stop handing out a port
that bypasses whatever reverse proxy sits in front of them.

The entrypoint no longer runs `usermod -u`, which chowned the account's home directory recursively on
every start: it walked the state directory and whatever a deployment mounted beside it before the
server was reachable, so the delay grew with the deployment. The uid is written into `/etc/passwd`
instead.
