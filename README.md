# idsh

[![GitHub Actions](https://github.com/devockr/idsh/workflows/CI/badge.svg)](https://github.com/devockr/idsh/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/release/devockr/idsh)](https://github.com/devockr/idsh/releases)
[![Docker image version](https://img.shields.io/docker/v/devockr/idsh?sort=semver)](https://hub.docker.com/r/devockr/idsh/tags)
[![Docker image size](https://img.shields.io/docker/image-size/devockr/idsh)](https://hub.docker.com/r/devockr/idsh)
[![Docker pulls](https://img.shields.io/docker/pulls/devockr/idsh)](https://hub.docker.com/r/devockr/idsh)
[![GHCR](https://img.shields.io/badge/ghcr.io-devockr%2Fidsh-blue?logo=github)](https://github.com/devockr/idsh/pkgs/container/idsh)

[![Conventional Commits](https://img.shields.io/badge/conventional%20commits-1.0.0-yellow.svg)](https://conventionalcommits.org)
[![Renovate enabled](https://img.shields.io/badge/renovate-enabled-brightgreen.svg)](https://renovatebot.com)
[![Code Style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![changesets](https://img.shields.io/badge/maintained%20with-changesets-176de3.svg)](https://github.com/changesets/changesets)

> Dockerized [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) web UI.

## Packages

| Package                                          | Description                                                                  | Version                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`@idsh/mobile`](/packages/mobile)               | Touch CSS, Enter as a line break, and the home-screen icon                   | [![npm](https://img.shields.io/npm/v/@idsh/mobile.svg)](https://www.npmjs.com/package/@idsh/mobile)               |
| [`@idsh/privileged-ui`](/packages/privileged-ui) | The settings page over a non-loopback origin, delegating the decision to dsh | [![npm](https://img.shields.io/npm/v/@idsh/privileged-ui.svg)](https://www.npmjs.com/package/@idsh/privileged-ui) |
| [`@idsh/remote-access`](/packages/remote-access) | Keeps the UI's multiplexed WebSocket alive across a stalled connection       | [![npm](https://img.shields.io/npm/v/@idsh/remote-access.svg)](https://www.npmjs.com/package/@idsh/remote-access) |

## Documentation

`pnpm docs:dev` serves this README, `CHANGELOG.md`, each package's `README.md` and
`CHANGELOG.md`, and the image's changelog; `pnpm docs:build` writes a static copy to `dist/`. The
Markdown files are the source — there is nothing to keep in sync.

## Requirements

- Docker with BuildKit + Docker Compose v2

## Getting started

1. Provide the host uid/gid (export them, or drop them in a `.env`
   in this directory):

   ```sh
   export UID            # both shells define the real UID
   export GID="$(id -g)" # bash defines only UID; zsh defines GID too
   ```

   `.env` is gitignored, so it is safe to keep in the working directory.

   The DeepSeek API key is **not** an environment variable: add it once the container is up, in the
   web UI's settings. It is kept in the state directory, so it survives a rebuild and never reaches
   the image or the process environment.

2. Create your compose file from the template and build:

   ```sh
   cp docker-compose.example.yml docker-compose.yml
   docker compose up -d --build
   ```

   `docker-compose.yml` itself is gitignored: it is the copy that carries your
   own hostnames, LAN addresses and proxy settings, which do not belong in a
   published repository.

   The template mounts only dsh's own state; add what you want (see Ports and volumes).

3. Grab the one-time token from the logs:

   ```sh
   docker compose logs dsh
   # dsh web: http://<the address it bound>:3080/?token=...
   #   take the token from that line; the address in it is the one inside the container,
   #   so open it through the published port as in the next step (`--public-url` replaces
   #   the address when set, and then the logged URL is the one to open)
   ```

4. Open it on the Docker host (the port is published on `15080`, on loopback):

   ```
   http://127.0.0.1:15080/?token=<token>
   ```

   It answers on the host only: the template binds the published port to `127.0.0.1`, so reach it
   from a browser on that machine or through a reverse proxy there. Publishing it on every interface
   is the one-line change described under Ports and volumes.

The entrypoint decides what the server binds: it hands dsh this container's own address, which is
the address a published port forwards to — a listener on `127.0.0.1` _inside_ the container cannot
receive such a connection. An explicit `--host` wins and `DSH_BIND_HOST` overrides the choice; set
`DSH_BIND_HOST=127.0.0.1` to keep the server on loopback, where a published port cannot reach it and
you go through the container's own network namespace instead (`docker exec`, or
`docker run --network container:dsh`). Binding one address means every LAN address reaches the UI
once the port is published; read [`@idsh/remote-access`](packages/remote-access/)'s security notes
before exposing it.

The image also bakes that package into a fresh profile, where its live job is the UI's multiplexed
WebSocket: it raises the heartbeat interval so the connection survives a stall. Its `0.0.0.0`
fallback for the bind is unreachable, because the entrypoint already defines the address and
0.2.1-alpha.2 and later refuse the wildcard wherever it comes from. Disabling the package — the
UI's Plugins page, or dropping it from `dsh.profile.bundles` — therefore no longer returns the
server to loopback; `DSH_BIND_HOST` is what does that. Nothing is uninstalled either way, since a
package the image declares is put back on the next start.

The token rotates on every restart.

## Configuration

Environment variables (see `docker-compose.example.yml`):

| Variable                                                | Purpose                                                                                                                                                                                                    | Default                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `PUID` / `PGID`                                         | uid/gid dsh runs as (and owns bind-mounted files as); compose forwards the host's `$UID`/`$GID`                                                                                                            | `$UID` / `$GID`                   |
| `NPM_REGISTRY`                                          | npm/pnpm/yarn registry: the image build and the user-level configs use it (the release build on GitHub Actions passes the official one)                                                                    | `https://registry.npmmirror.com/` |
| `DSH_TRUSTED_HOSTS`                                     | Space-separated host authorities allowed by dsh's browser-trust fence                                                                                                                                      | —                                 |
| `DSH_PUBLIC_URL`                                        | Public HTTP(S) root to advertise behind a prefix-stripping proxy; pair it with `DSH_TRUSTED_HOSTS`                                                                                                         | —                                 |
| `DSH_BIND_HOST`                                         | Concrete address dsh binds, defaulting to the container's own (the wildcard is refused): set it to `127.0.0.1` to give up remote reach, or to one address when several networks make the default ambiguous | this container                    |
| `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` | Outbound proxy for dsh's HTTP requests                                                                                                                                                                     | —                                 |

At boot the registry is written into `~/.npmrc`, `~/.yarnrc` and `~/.yarnrc.yml` (corepack
and node-gyp mirrors follow), not into the environment — so a project that pins its own
registry still wins. `NPM_CONFIG_REGISTRY` and `YARN_NPM_REGISTRY_SERVER` are therefore
**not read**; drop them from old compose files. Variables with no default are passed through
by name, so an unset one stays unset rather than becoming empty.

Ports and volumes:

- `127.0.0.1:15080:3080` — host port `15080` → dsh's internal web server (`3080`), bound to
  loopback so only a reverse proxy on the host reaches it. Widen it to `15080:3080` to publish the
  port itself; then whatever authority that port is reached on has to be trusted by the fence.
- `./.dsh` → `/home/app/.dsh` — dsh state and credentials (persist). This is the
  template's only mount.
- Add the rest yourself, for example `./workspace:/home/app/Workspaces` for a
  workspace or `./ssh:/home/app/.ssh` for an ssh config. The template deliberately
  prescribes none.

## Releasing

The companion packages under `packages/` are released with
[changesets](.changeset/README.md). A pull request that changes one carries a changeset
(`pnpm changeset`); merging it to `main` lets the [`Release`](.github/workflows/release.yml)
workflow collect every pending changeset into one "Version Packages" pull request, and merging
**that** publishes the bumped packages to npm. The `version` field in a package's manifest is an
output of that flow, not something to edit by hand.

What the images bake moves with that release: `pnpm run version` runs
[`tools/sync-image-pins.mts`](tools/sync-image-pins.mts), so the version pull request bumps the
`dsh plugin …` lines in `Dockerfile` to the versions it is releasing. The image keeps a version of its
own in [`image/`](image/), a private package that only carries it, and a release that changes what
the image bakes bumps it in one of its changesets — CI refuses a release where none does. When that
version moves, the workflow builds the image and pushes it to `ghcr.io/devockr/idsh` and to
`devockr/idsh` on Docker Hub as `:latest`, `:sha-<commit>` and `:<version>`, so a deployment can pull
it instead of building. GHCR creates every new package **private**: it inherits the linked
repository's _permissions_, not its visibility. So flip `idsh` to public once (package settings, then
Danger Zone — it cannot be made private again), or pull with a token. Docker Hub needs neither: a
repository there is public by default.

The package page lists `unknown/unknown` rows beside `amd64` and `arm64`: those are the build's
provenance and SBOM attestations, written into the same manifest list with no platform of their own.
They are what lets a digest be traced back to the commit and workflow that produced it.

## Notes

- **Runs as your host user** — the container starts as root, re-points its `app`
  account to `PUID`/`PGID`, fixes ownership of the home skeleton (leaving bind
  mounts alone), then drops privileges with `setpriv`. Files in the mounts are
  owned by you, not a container uid.
- **One-off commands** — `docker exec` lands as root; use `docker exec -u app …`
  for a shell as the working user, or `docker exec dsh dsh …` for arbitrary dsh
  invocations. Extra `docker run <image> <args>` are appended after dsh's web
  flags, so they can't override `--profile web`.
- **Sandbox** — dsh's file sandbox needs user namespaces or Landlock. On hosts without them (e.g. Synology's 4.4 kernel), either set `DSH_PERMISSION_MODE=danger-full-access`, or approve the `danger-full-access` escalation when prompted in the UI.
- **Plugins** — the image bakes a profile when it is built: dsh's own `web` template plus its companion packages — [`@idsh/remote-access`](packages/remote-access/), [`@idsh/privileged-ui`](packages/privileged-ui/) (the settings page over the LAN, which the image used to `sed` into dsh) and [`@idsh/mobile`](packages/mobile/) (the touch CSS, Enter as a line break, and the home-screen icon) — installed from npm by name (the dev image, what we run locally, bakes this checkout's `packages/` as `link:`s instead). A deployment without a profile starts from that one; an existing profile keeps those packages at the version the image declares — compared by each package's own `package.json` — putting back anything missing, broken or below it, exactly as the image installed it (a link in the dev image, where a built checkout mounted at `/opt/dsh/packages` is what runs — edit, rebuild, restart; files otherwise). Anything at that version or above is left alone, which is where a pinned version or a fork lives, and a package is turned off by dropping it from the bundle list (the UI's Plugins page), not by uninstalling it. Plugins live in the `.dsh` mount and survive recreations.
- **UI probe** — `node tools/dev/ui-probe.mts` boots a throwaway instance in an isolated `$DSH_HOME` and drives it with a real browser, so a client plugin's runtime behaviour can be checked without touching the live profile. It installs the plugin set the image baked — what a deployment gets — and `--install <pnpm-spec>` adds to or replaces that, which is how a checkout or a candidate package is probed; `--bare` starts from the shipped template alone, for narrowing down which plugin is at fault. It needs the `:dev` image — `pnpm dev` builds it from a checkout, and `docker-compose.dev.yml` carries the browser settings it reads, which needs Compose 2.24.4+ for its `!reset` tag — which is the one carrying the browser libraries; `--no-browser` skips the browser and checks the served boot graph instead.
- **Remote exposure** — what reaches the UI is the address the entrypoint binds and the port you publish: a published port forwards to that address, and the bind also puts it into dsh's browser-trust fence. Put TLS and auth (or a VPN) in front unless that network is trusted; see [`@idsh/remote-access`](packages/remote-access/)'s README for what the package itself does.
- **HTTPS reverse proxy** — if you front this with nginx, keep the `Host` header intact (`proxy_set_header Host $http_host;`) so the browser-trust fence passes, and add WebSocket upgrade headers.

## Sponsors and Backers

[![Sponsors and Backers](https://raw.githubusercontent.com/1stG/static/master/sponsors.svg)](https://github.com/sponsors/JounQin)

### Sponsors

| 1stG                                                                                                                   | RxTS                                                                                                                   | UnTS                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [![1stG Open Collective sponsors](https://opencollective.com/1stG/organizations.svg)](https://opencollective.com/1stG) | [![RxTS Open Collective sponsors](https://opencollective.com/rxts/organizations.svg)](https://opencollective.com/rxts) | [![UnTS Open Collective sponsors](https://opencollective.com/unts/organizations.svg)](https://opencollective.com/unts) |

### Backers

| 1stG                                                                                                                | RxTS                                                                                                                | UnTS                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [![1stG Open Collective backers](https://opencollective.com/1stG/individuals.svg)](https://opencollective.com/1stG) | [![RxTS Open Collective backers](https://opencollective.com/rxts/individuals.svg)](https://opencollective.com/rxts) | [![UnTS Open Collective backers](https://opencollective.com/unts/individuals.svg)](https://opencollective.com/unts) |

## License

[MIT](LICENSE) © [JounQin](https://github.com/JounQin)
