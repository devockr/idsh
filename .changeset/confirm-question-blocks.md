---
"@idsh/host-ops": patch
---

The confirmation question is built from blocks instead of one formatted string, so an operation with
no arguments no longer shows `{}` where its arguments would be — a question reads "Run
deploy.recreate on the host?" followed by the resolved source, when there is one, and the instruction
to choose Run. A typed reply is still not an approval.
