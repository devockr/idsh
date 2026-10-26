---
"@idsh/host-broker": minor
---

Add `deploy.build`: resolve a PR head or an origin branch tip with `git ls-remote`, clone it clean,
replace the six root-surface files with `origin/main`'s, build `:dev` in the base image, and record
the image the container ran before so a rollback target exists. Only code that exists on origin is
buildable; the working tree is never used.
