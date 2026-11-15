---
"@idsh/host-ops": patch
"@idsh/image": patch
"@idsh/mobile": patch
"@idsh/privileged-ui": patch
---

Allow the `@deepseek-ai/dsh` 0.2.2 prerelease line in the peer ranges (`^0.2.2-rc.0`), so the
plugins can be installed into an image running `dsh 0.2.2-rc.3`.
