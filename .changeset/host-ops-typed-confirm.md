---
'@idsh/host-ops': patch
---

A destructive operation is confirmed only by the "Run" option. A free-text answer is a reply, not an
approval: the host is left untouched and the text is passed back in the error, so the assistant can
answer the question and ask again instead of the reply disappearing.
