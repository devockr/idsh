#!/bin/sh
set -e

umask 077

# We start as root (the Dockerfile has no USER) and drop to the host user below.
# dsh keeps its state in $HOME/.dsh.
export HOME=/home/app

# --- Run as the host user (PUID/PGID) -----------------------------------------
# PUID/PGID bring the host uid/gid in from docker-compose, so the image itself
# stays free of any uid and can be built once and reused by anyone.
#
# The account must exist in /etc/passwd: OpenSSH clients call getpwuid(getuid())
# unconditionally and die with "No user exists for uid ...". Plain node/bash don't
# care — which is why this only ever bites ssh/scp/sftp/ssh-keygen.
#
# Needs CAP_SETUID/CAP_SETGID, so do not cap_drop ALL. On Alpine these commands
# come from the `shadow` package, and setpriv/mountpoint from `util-linux`.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$PUID" = 0 ]; then
  # uid 0 already owns the image's `root` entry, so there is nothing to create or
  # re-point — and the surgery below would be actively harmful: getpwuid(0)
  # returns `root`, so the re-home line would move /root to /home/app. Running as
  # root is the caller's explicit choice; just say so and carry on.
  echo "entrypoint: PUID=0 — running as root, skipping account setup" >&2
else
  # Re-point the image's pre-created `app` account at the host uid/gid. `-o` allows
  # the non-unique case where another account already owns that id (node=1000, or
  # users=100 for the group), so no branching is needed — the linuxserver.io idiom.
  #
  # The uid is written into /etc/passwd rather than through `usermod -u`, which chowns
  # the account's home directory recursively: /home/app holds the state directory
  # (11 GB, 139k inodes) plus whatever a deployment mounts beside it, and that walk cost
  # six minutes on every start. Anything that actually needs fixing is fixed
  # non-recursively further down.
  groupmod -o -g "$PGID" app
  # `sed -i` writes a copy and renames it, which can carry the copy's mode over: /etc/passwd
  # has to stay 0644 or every non-root lookup fails.
  sed -i "s|^app:x:[0-9]*:[0-9]*:|app:x:$PUID:$PGID:|" /etc/passwd
  chmod 0644 /etc/passwd

  # `-o` can leave two accounts sharing a uid: app + node when PUID=1000, which is
  # the most common uid on Linux — so this is the *likely* case for anyone reusing
  # the image, not an exotic one. ssh resolves ~/.ssh through getpwuid(getuid()),
  # not $HOME, so it would read the *other* account's home. Point that account at
  # /home/app too, so ~ means the same thing however the uid is resolved.
  # getpwuid()/glibc getent return only the first match for a uid, but BusyBox
  # getent (Alpine) lists every match — head -n 1 keeps this safe on both.
  CUR="$(getent passwd "$PUID" | head -n 1 | cut -d: -f1)"
  [ "$CUR" = app ] || usermod -d /home/app -s /bin/bash "$CUR"
fi

# --- Point every package manager at one registry ------------------------------
# The registry is only ever configured in these user-level files, never through an
# environment variable: npm honours NPM_CONFIG_REGISTRY, but pnpm and yarn 1 ignore
# it while installing, and an environment variable outranks a project's own
# configuration, which would defeat a project that pins its own registry. The files
# merge per key instead.
#
#   ~/.npmrc       registry=           npm, pnpm and yarn 1
#   ~/.yarnrc      registry "…"        yarn 1's own config view
#   ~/.yarnrc.yml  npmRegistryServer:  yarn 2/3/4, the file `config set --home` writes
#
# pnpm reads only the npm-compatible keys from .npmrc (its own settings moved to
# pnpm-workspace.yaml in v10) and its global ~/.config/pnpm/config.yaml is left
# alone on purpose: that file outranks even a project's own .npmrc. Yarn 1 ignores
# .yarnrc.yml, so the three files coexist in one home without disturbing anyone.
#
# Only the account dsh runs as is covered — $HOME, /home/app — since a root shell
# is not where package managers run. Keys that are already there are kept, so a
# hand-written file survives a restart, and this runs before the chown below so
# the new files end up owned by PUID.
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com/}"

# Append a line, first ensuring the file ends with a newline, so a hand-edited
# config file cannot have the new key glued onto its last line.
append_line() {
  append_file="$1"
  shift
  if [ -s "$append_file" ] && [ -n "$(tail -c 1 "$append_file")" ]; then
    printf '\n' >> "$append_file"
  fi
  printf '%s\n' "$*" >> "$append_file"
}

# Add one setting to one file, unless it is already there: npm's ini and yarn 1's
# store ignore whitespace around the key, so those patterns allow it, while the
# YAML one is anchored at column 0 — indentation there means nesting, not spacing,
# and `npmScopes.<scope>.npmRegistryServer` is only that scope's registry. A file
# that exists but is not writable — a read-only bind mount holding an auth token,
# say — is left untouched, and a write that fails anyway must not take the
# container down with it: this is the user's configuration, not a precondition.
add_setting() {
  if [ -e "$1" ] && [ ! -w "$1" ]; then
    return 0
  fi
  grep -qsE "$2" "$1" || append_line "$1" "$3" || true
}

if [ -w "$HOME" ]; then
  add_setting "$HOME/.npmrc" '^[[:space:]]*registry[[:space:]]*=' "registry=$NPM_REGISTRY"
  add_setting "$HOME/.yarnrc" '^[[:space:]]*(-{1,2})?registry[[:space:]=]' "registry \"$NPM_REGISTRY\""
  add_setting "$HOME/.yarnrc.yml" '^npmRegistryServer[[:space:]]*:' "npmRegistryServer: \"$NPM_REGISTRY\""
fi

# Corepack and node-gyp have no config file to write, so their two mirrors have to
# travel in the environment. Corepack's is the same npm registry; node-gyp's is a
# binary mirror, because it appends /v<version>/node-v<version>-headers.tar.gz to
# whatever base it is given — the registry root answers 422 at that path. An
# inherited value wins, and a project's own `disturl` wins over it for node-gyp.
# (`disturl` is not written above: it is deprecated, and npm 11 warns about it on
# every command.)
export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"
export NODEJS_ORG_MIRROR="${NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"

# NPM_REGISTRY has done its job: a variable meaning "use this registry" should not
# be inherited by every tool dsh spawns.
unset NPM_REGISTRY

# Chown the home directory and every top-level entry that is not itself a
# bind-mount point. The mounts are owned by whoever owns them on the host, and
# this image is published for arbitrary mount layouts, so we can't assume their
# names — `mountpoint` detects them instead. The skeleton files (.bashrc & co)
# are what this fixes: they can still carry the build-time uid, and the running user should be
# able to read/write them.
#
# /home/app and /app themselves are always ours — a non-recursive chown cannot
# reach into the mounts below /home/app — so they go first and unconditionally.
chown "$PUID:$PGID" /home/app /app 2> /dev/null || true

for f in /home/app/* /home/app/.[!.]*; do
  [ -e "$f" ] || continue
  mountpoint -q "$f" && continue
  chown "$PUID:$PGID" "$f" 2> /dev/null || true
done

# The state directory is a bind mount, so the loop above skips it — and this one file has to be
# readable by the uid dsh drops to. It is named here on purpose: anything recursive would walk the
# 11 GB of cache beside it on every start, which is the whole reason `usermod -u` is gone.
CRED="$HOME/.dsh/.credentials.yaml"
if [ -f "$CRED" ]; then
  chown "$PUID:$PGID" "$CRED" 2> /dev/null || true
  chmod 600 "$CRED"
fi

# @idsh/remote-access describes the reachability rules in its own README; with it absent — a
# profile that never had it, or one where it was removed — dsh keeps its shipped loopback bind.

# The browser-trust fence rejects API requests whose Host is not loopback or a
# trusted host. DSH_TRUSTED_HOSTS is a space-separated list of authorities
# (host or host:port) to allow, e.g. "192.168.1.10" or "dsh.local:3080".
# Append these to the incoming args (docker run <image> …) rather than clobbering
# them, so extra dsh flags can be passed through.
for h in ${DSH_TRUSTED_HOSTS:-}; do
  set -- "$@" --trusted-host "$h"
done

# Which address dsh should bind. Reachability used to come from @idsh/remote-access's config layer,
# which only worked while dsh checked the command line alone; the newer releases validate the value
# wherever it comes from and refuse the wildcard, and dsh owns that check. So the entrypoint decides
# only which address to offer — DSH_BIND_HOST when set, otherwise this container's own, which is
# where a published port forwards — and stops if it has none, since dsh would answer on loopback.
# An explicit --host from the caller wins: appending ours would be parsed last and replace it, and a
# caller may be opting back into loopback on purpose (packages/remote-access/README.md says so).
explicit_host=
for arg in "$@"; do
  case "$arg" in
    --host | --host=*) explicit_host=1 ;;
  esac
done
if [ -n "$explicit_host" ]; then
  echo "entrypoint: --host was passed in; leaving the bind address to it" >&2
else
  bind_host="${DSH_BIND_HOST:-}"
  if [ -n "$bind_host" ]; then
    echo "entrypoint: binding $bind_host (DSH_BIND_HOST)" >&2
  else
    # One pass: an IPv4 address wins outright and an IPv6 one is kept only as a fallback; an
    # address carrying an interface zone id is skipped, since no URL can express one. All of
    # them are listed with the choice, so a multi-network container is not a silent guess.
    addresses=$(hostname -i 2> /dev/null)
    for addr in $addresses; do
      case "$addr" in
        ::1 | 127.*) continue ;;
        *%*) continue ;;
        *:*) bind_host="${bind_host:-$addr}" ;;
        *)
          bind_host="$addr"
          break
          ;;
      esac
    done
    if [ -z "$bind_host" ]; then
      echo "entrypoint: no bind address found; set DSH_BIND_HOST. dsh's default answers on loopback only." >&2
      exit 1
    fi
    echo "entrypoint: binding $bind_host (this container; addresses: $addresses)" >&2
  fi
  set -- "$@" --host "$bind_host"
fi

# Advertise the root a reverse proxy fronts (--public-url); no-op when unset.
if [ -n "${DSH_PUBLIC_URL:-}" ]; then
  set -- "$@" --public-url "$DSH_PUBLIC_URL"
fi
# The profile the image baked goes to a deployment that has none. An existing one keeps the packages
# the image declares: anything missing, broken or behind the image's version is put in place as the
# image installed it, and anything at that version or above — a pin, a fork, a link into a mounted
# checkout — is left alone. No boot downloads anything. Disabling is dropping a package from the
# bundle list, not uninstalling it; nothing is ever removed, and nothing here names a package.
profile="$HOME/.dsh/profiles/web"
# The baked profile keeps its `link:` packages as symlinks written relative to /opt/dsh/home, which
# stop resolving once the profile lives under $HOME — dsh then skips those bundles entirely — so the
# same repair runs here. Ownership is fixed before stopping: the script replaces packages one at a
# time as root, so a failure halfway through would otherwise leave the ones already swapped
# root-owned in the host bind mount, which is what the chown after it is for.
repair_profile() {
  if ! node /opt/dsh/tools/sync-companions.mts; then
    echo "entrypoint: could not repair the companion packages" >&2
    chown -R "$PUID:$PGID" "$1" || echo "entrypoint: could not fix the profile ownership" >&2
    exit 1
  fi
  chown -R "$PUID:$PGID" "$1" || echo "entrypoint: could not fix the profile ownership" >&2
}

if [ ! -d "$profile" ] && [ -d /opt/dsh/home/.dsh/profiles/web ]; then
  mkdir -p "$HOME/.dsh/profiles"
  cp -a /opt/dsh/home/.dsh/profiles/web "$HOME/.dsh/profiles/"
  repair_profile "$profile"
elif [ -d "$profile" ] && [ ! -f "$profile/package.json" ]; then
  # Half-initialised: fill it in place, or the copy above would nest itself one level down.
  cp -a /opt/dsh/home/.dsh/profiles/web/. "$profile/"
  repair_profile "$profile"
elif [ -d /opt/dsh/home/.dsh/profiles/web/node_modules ]; then
  repair_profile "$HOME/.dsh/profiles/web"
fi

# Drop privileges before exec: dsh and everything it spawns must run as the host
# user, so files written into the bind mounts belong to the host user.
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups \
  node --expose-internals "$(command -v dsh)" --profile web --no-open "$@"
