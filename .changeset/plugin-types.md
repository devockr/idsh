---
"@idsh/mobile": patch
"@idsh/privileged-ui": patch
"@idsh/image": patch
---

Publish type declarations for the two plugins' host halves. `declaration` is on, `exports` carries a
`types` condition (and the manifest a top-level `types`, for tooling that still reads it), and the
`.d.ts` is in `files` — the same shape the `@deepseek-ai/dsh-*` packages ship. The image rides along
because it pins these packages by version.
