---
"@idsh/host-broker": minor
---

The deploy operations merge a tracked `docker-compose.broker.yml` when the checkout has one: base,
broker, then the channel overlay. A deployment that runs the credential broker in a container keeps
its definition in that file, shared by the dev and production channels; one that supervises the
broker elsewhere simply has no such file, and the pair of files it used before still applies.
