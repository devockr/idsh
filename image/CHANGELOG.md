# @idsh/image

## 0.1.0

### Minor Changes

- [#79](https://github.com/devockr/idsh/pull/79) [`96b81ec`](https://github.com/devockr/idsh/commit/96b81ecaa0ad07f9ecddb3671dce8129698fa97e) Thanks [@JounQin](https://github.com/JounQin)! - Bake `gcb-client` into the image and point git at the host's credential broker when its socket is
  mounted: `entrypoint.sh` runs `gcb setup` as the deployment user before dsh, so a push asks the
  host for a short-lived credential instead of the container holding one. Without the mount the setup
  is skipped and nothing changes. `docker exec … gcb probe` answers the broker's decision.

### Patch Changes

- [#56](https://github.com/devockr/idsh/pull/56) [`4678335`](https://github.com/devockr/idsh/commit/4678335a2d6e7c1c61c888aff1ec649ea798600a) Thanks [@JounQin](https://github.com/JounQin)! - Publish type declarations for the two plugins' host halves. `declaration` is on, `exports` carries a
  `types` condition (and the manifest a top-level `types`, for tooling that still reads it), and the
  `.d.ts` is in `files` — the same shape the `@deepseek-ai/dsh-*` packages ship. The image rides along
  because it pins these packages by version.

- [#59](https://github.com/devockr/idsh/pull/59) [`4e46aaa`](https://github.com/devockr/idsh/commit/4e46aaa75600c32e80d5f494f8aff69ff0982202) Thanks [@renovate](https://github.com/apps/renovate)! - chore(deps): update dependency @deepseek-ai/dsh to v0.2.1-rc.3

## 0.0.5

### Patch Changes

- [#50](https://github.com/devockr/idsh/pull/50) [`9393792`](https://github.com/devockr/idsh/commit/939379230422480492d925ce33de58a8ffb440a3) Thanks [@renovate](https://github.com/apps/renovate)! - chore(deps): update dependency @deepseek-ai/dsh to v0.2.1-rc.2

## 0.0.4

### Patch Changes

- [#48](https://github.com/devockr/idsh/pull/48) [`2aaf97b`](https://github.com/devockr/idsh/commit/2aaf97b8b4343ca2bb541d091949a756beb23dbc) Thanks [@JounQin](https://github.com/JounQin)! - The compose template publishes `15080` on loopback instead of every interface, and `DSH_TRUSTED_HOSTS`
  no longer defaults to a placeholder name. Deployments built from the template stop handing out a port
  that bypasses whatever reverse proxy sits in front of them.

  The entrypoint no longer runs `usermod -u`, which chowned the account's home directory recursively on
  every start: it walked the state directory and whatever a deployment mounted beside it before the
  server was reachable, so the delay grew with the deployment. The uid is written into `/etc/passwd`
  instead.

## 0.0.3

### Patch Changes

- [#43](https://github.com/devockr/idsh/pull/43) [`c4189cf`](https://github.com/devockr/idsh/commit/c4189cf6fe51bc46ab221128a2639df4277c3484) Thanks [@JounQin](https://github.com/JounQin)! - The package READMEs lose the YAML frontmatter they opened with. npm renders it as the first
  paragraph rather than as metadata, and nothing read those fields — the description already lives in
  each manifest — so the pages now start at the heading.

  `@idsh/image` rides along because it pins these packages by version: a release that moves them has to
  move the image's own version, which is what `release.yml` reads to decide whether to publish it.

## 0.0.2

### Patch Changes

- [#33](https://github.com/devockr/idsh/pull/33) [`54aebec`](https://github.com/devockr/idsh/commit/54aebec126394ffe7b427baddc76d1bcad51bf96) Thanks [@renovate](https://github.com/apps/renovate)! - Bake dsh `0.2.1-rc.1` instead of `0.2.1-alpha.4`, and pnpm `12.14.0` instead of `12.11.2`. Both are
  what the published image installs, so the image's own version moves with them; the three plugin
  packages move too, because `pnpm run version` writes their `dsh plugin …` lines from their manifests.

## 0.0.1

### Patch Changes

- [#31](https://github.com/devockr/idsh/pull/31) [`a78bd43`](https://github.com/devockr/idsh/commit/a78bd43625b57be7cf3c575b257c029f4595518a) Thanks [@JounQin](https://github.com/JounQin)! - Publish the image: once a release lands, `release.yml` builds `Dockerfile`'s final stage and pushes
  it to `ghcr.io/devockr/idsh` and to Docker Hub's `devockr/idsh` — tagged `latest`, the commit, and
  this version.
