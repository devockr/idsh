---
"@idsh/host-broker": patch
---

The audit log is opened nonblocking and bounded, and refuses anything that is not a regular file,
so a FIFO cannot hang the request that writes it. A record is appended, never rewritten: a failed
append fails the request and leaves earlier records (including ones another broker appended)
untouched.
