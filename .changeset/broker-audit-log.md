---
"@idsh/host-broker": patch
---

The audit log is opened nonblocking and bounded, refuses anything that is not a regular file, rolls
a partially written record back to the length it had before the append, and serializes appends
across connections so a failed write cannot truncate another request's line.
