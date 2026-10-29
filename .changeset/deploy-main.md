---
'@idsh/host-broker': minor
---

Add `deploy.main`: resolve the tip of `origin/main`, build it as `:dev` with the same root-surface
pin as `deploy.build`, record the previous image for `deploy.rollback`, and recreate the container
from the new image in the same call — acknowledged first, with the compose detached 500 ms later,
under the deployment lock.
