---
"@idsh/image": patch
---

The published image installs `gcb-client@0.3.0` instead of `0.2.0`. The dev image already took the
client from its own checkout, so it was dogfooding this version before the pin moved; the release
artifact should not lag it.
