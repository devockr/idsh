---
"@idsh/image": patch
---

The entrypoint records Yarn's cache locations in the user-level config (`cache-folder` for Classic,
`globalFolder` for 2/4), inside the mounted state directory, so they survive a rebuild without an
environment override that a project could not beat.
