---
"@idsh/host-broker": patch
---

`gcb.update` no longer depends on the checkout's current branch: it fetches `origin` and detaches at
`origin/main` before building, so a checkout left on a deleted branch updates instead of failing with
`no such ref was fetched`.
