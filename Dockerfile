# glibc base (not Alpine): dsh 0.2.x depends on node-addon-require-builtin, whose
# prebuilt binaries are published for linux-*-gnu only — there is no musl build,
# so Alpine fails at boot with "No usable native binding found".
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

# Create the account dsh runs as. Its uid/gid here are placeholders only: the
# real ones arrive at runtime as PUID/PGID and entrypoint.sh re-points this
# account at them before dropping privileges (the linuxserver.io convention).
# This line also supplies the account's home and skeleton files up front.
# On Alpine: busybox adduser has a different CLI — `apk add shadow` for the real
# useradd/usermod/groupadd/groupmod, and `util-linux` for setpriv/mountpoint.
RUN groupadd app && useradd -m -g app -s /bin/bash app

# bash is required by dsh's bash executor (the slim image ships dash, not bash).
# openssh-client provides the actual ssh/scp/sftp/ssh-keygen binaries — and those
# need the runtime uid to exist in /etc/passwd (see entrypoint.sh).
# git is what dsh's tools use for repo work; the slim image omits it.
# ca-certificates supplies /etc/ssl/certs/ca-certificates.crt, the trust store
# git/curl/node read for TLS. Without it `git clone https://…` dies with
# "server certificate verification failed … CAfile: none" — and node's own
# outbound HTTPS works only because it falls back to its bundled roots, so the
# gap shows up in git first. Not inherited from the base: bookworm-slim ships
# no CA bundle.
# util-linux is what entrypoint.sh relies on: setpriv (drop privileges) and
# mountpoint (never chown a bind mount). Named explicitly so a missing binary
# fails the build rather than the boot.
# curl is not needed by dsh: it is installed so `docker exec … curl` can probe
# the UI and the other services on the box from inside the container.

# Browser libraries for browser-driven checks are deliberately *not* here: they are ~14MB of
# shared libraries for a tool the deployment never runs. They live in Dockerfile.dev, which is
# built from this file's `base` target and tagged separately (see "Images" in AGENTS.md):
#   docker build --target base -t devockr/idsh:base .
#   docker build -f Dockerfile.dev -t devockr/idsh:dev .
# Named caches, like npm_cache: the archives and lists persist across builds, and a cache mount
# is not part of the layer — which is why the cleanup that used to follow is gone instead of
# moved: it would empty the cache on every build.
RUN --mount=type=cache,id=apt_cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=apt_lists,target=/var/lib/apt/lists,sharing=locked \
  rm -f /etc/apt/apt.conf.d/docker-clean \
   && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
   && apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git openssh-client util-linux


# Install the CLI globally (as root, so it can write to the global prefix).
# The web profile's HMR service requires Node's --expose-internals flag, which
# Node refuses to accept via NODE_OPTIONS, so it is passed in entrypoint.sh.
# The cache mount persists npm's package cache (named "npm_cache") across builds.
# Both versions are pinned instead of floating so the build is reproducible; the
# regex custom manager in renovate.json keeps them up to date (npm's own manager
# does not read RUN lines).
# pnpm is in the same install because the plugin manager drives it and has no npm
# fallback, and because it must resolve from the image's PATH: the in-app installer
# spawns it with a scrubbed environment, so a user-prefix install is invisible.
# The mirror is an argument, and an ARG is scoped to the stage that declares it. Without this
# declaration the RUN below expands it to nothing — which silently sent this install to the default
# registry instead of the mirror, and is why a base build here was slow.
ARG NPM_REGISTRY=https://registry.npmmirror.com/

RUN --mount=type=cache,id=npm_cache,target=/root/.npm \
  npm install -g --registry="$NPM_REGISTRY" @deepseek-ai/dsh@0.2.1-rc.3 pnpm@12.15.0

# This image used to patch dsh's installed JavaScript here: the loopback gate the
# settings page hides behind, the touch CSS, the home-screen icon, and the composer's
# Enter key. All of that lives in packages/ now, published separately, so the runtime in here is an
# untouched dsh, and entrypoint.sh only hands a fresh deployment the profile baked at the end of
# this file.

COPY --chmod=755 entrypoint.sh /entrypoint.sh
# Only the one tool the entrypoint runs, not the whole directory: `COPY tools/` made every helper
# — the probe, the deploy tool, the checks — part of this stage, so adding one invalidated the npm
# install above and the browser libraries the dev image adds on top of it. Everything else under
# tools/ belongs to the dev image, which copies the directory itself.
COPY --chmod=755 tools/sync-companions.mts /opt/dsh/tools/sync-companions.mts

# Deliberately no USER here: the container starts as root so entrypoint.sh can
# re-point `app` to PUID/PGID and fix ownership, then it drops to that uid with
# setpriv before exec'ing dsh. This is what makes the image reusable by anyone —
# no uid is baked in.
#   docker exec ... -> root; use `docker exec -u app ...` for a shell as app.
# Do not cap_drop ALL: switching uid needs CAP_SETUID/CAP_SETGID.

WORKDIR /app

EXPOSE 3080

ENTRYPOINT ["/entrypoint.sh"]

# The published image: this base plus the profile it bakes — dsh's own `web` template and the
# packages this repository publishes, installed by name from the registry, exactly as `dsh plugin
# add` would. Strict on purpose: a release that cannot ship its own plugins is not a release.
# Dockerfile.dev bakes the same profile from packages/ instead; the closing test pins the path
# entrypoint.sh copies from, and renovate.json reads the version off that line.
FROM base

# An ARG declared in the base stage is out of scope here, so the registry has to be declared again.
ARG NPM_REGISTRY=https://registry.npmmirror.com/

RUN mkdir -p /opt/dsh/home \
  && export HOME=/opt/dsh/home \
  && printf 'registry=%s\n' "$NPM_REGISTRY" > "$HOME/.npmrc" \
  && dsh web --dump-config > /dev/null \
  && dsh plugin --profile web add @idsh/mobile@0.0.2 \
  && dsh plugin --profile web add @idsh/privileged-ui@0.0.2 \
  && dsh plugin --profile web add @idsh/remote-access@0.0.2 \
  && test -f /opt/dsh/home/.dsh/profiles/web/package.json
