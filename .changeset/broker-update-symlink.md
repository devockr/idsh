---
"@idsh/host-broker": patch
---

`broker.update` decides how it was installed by comparing the running entry with `--checkout`, and
that comparison is now made on resolved paths: both sides go through `realpath`, a path that no
longer exists is named through its nearest existing ancestor, and `..` is matched as a path segment
rather than a string prefix, and a symlink whose target is gone is followed by its target instead of being treated as a missing name. A checkout reached through a symlink (the deployment's `/var/services/…`
against a process that resolved to `/volume1/…`), or a rebuild that cleaned `lib/`, is therefore
recognised as the checkout it is instead of refusing with "cannot tell which npm prefix … belongs
to" — and a child directory named `..build` stays inside it.
