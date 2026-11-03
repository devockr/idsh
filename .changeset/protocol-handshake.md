---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`ops.describe` is negotiated: a client that declares `{protocol}` gets `{ protocol, version, ops }` and
a client that declares nothing gets the bare table it has always read. A newer plugin therefore
warns — "older broker", or a different protocol number — instead of an older plugin losing every host
tool against a newer broker, which is what a one-way change to the answer would have caused.
