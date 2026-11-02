# @idsh/privileged-ui

## 0.0.3

### Patch Changes

- [#56](https://github.com/devockr/idsh/pull/56) [`4678335`](https://github.com/devockr/idsh/commit/4678335a2d6e7c1c61c888aff1ec649ea798600a) Thanks [@JounQin](https://github.com/JounQin)! - Publish type declarations for the two plugins' host halves. `declaration` is on, `exports` carries a
  `types` condition (and the manifest a top-level `types`, for tooling that still reads it), and the
  `.d.ts` is in `files` — the same shape the `@deepseek-ai/dsh-*` packages ship. The image rides along
  because it pins these packages by version.

## 0.0.2

### Patch Changes

- [#43](https://github.com/devockr/idsh/pull/43) [`c4189cf`](https://github.com/devockr/idsh/commit/c4189cf6fe51bc46ab221128a2639df4277c3484) Thanks [@JounQin](https://github.com/JounQin)! - The package READMEs lose the YAML frontmatter they opened with. npm renders it as the first
  paragraph rather than as metadata, and nothing read those fields — the description already lives in
  each manifest — so the pages now start at the heading.

  `@idsh/image` rides along because it pins these packages by version: a release that moves them has to
  move the image's own version, which is what `release.yml` reads to decide whether to publish it.

## 0.0.1

### Patch Changes

- [#27](https://github.com/devockr/idsh/pull/27) [`3b26eca`](https://github.com/devockr/idsh/commit/3b26eca1c3a79d93595241992f87a38ee7ee3705) Thanks [@JounQin](https://github.com/JounQin)! - Grant the privileged surface only to a page this deployment serves: the host half now asks dsh's
  own request gate (`connection.requestRejection`) and the browser half grants nothing until it
  answers yes, so loopback forms, IPv6 literals, default ports and the declared authorities are
  decided by the code that defines them instead of by a matcher here.
