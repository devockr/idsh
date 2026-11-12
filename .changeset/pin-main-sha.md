---
"@idsh/host-broker": minor
---

`deploy.main` accepts the main `sha` the preview showed and refuses a main that has moved since,
instead of silently building a different commit.
