# @idsh/host-broker

The host side of `@idsh/host-ops`: a **typed, audited operation table** behind a unix socket, so
the agent container never holds a host credential.

`ROADMAP.md` at the repository root is the plan; this package is its first slice. It runs on the
host as the deployment's user and answers questions about that host. There is no shell: every
operation reads from a **fixed source** — a known log, a known kernel file, one known program —
with a small set of validated arguments.

## Run it

```text
idsh-host --socket <path> --audit <path> [--log-dir <dir>] [--proc-dir <dir>]
         [--container <name>] [--docker <path>] [--git <path>]
         [--ip <path>] [--ss <path>] [--pnpm <path>] [--npm <path>] [--checkout <dir>]
         [--gcb-checkout <dir>] [--gcb-compose <file>] [--gcb-probe-repo <owner/name>]
```

Both paths belong **outside every bind mount**, and the host's scheduler is what keeps the process
alive:

A user unit, so the broker runs as the same uid the socket is for:

```ini
# ~/.config/systemd/user/idsh-host.service
[Service]
ExecStart=%h/.local/bin/idsh-host --socket %h/.local/state/idsh-host/host.sock --audit %h/.local/state/idsh-host/audit.jsonl --checkout %h/Workspaces/idsh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
npm i -g --prefix ~/.local @idsh/host-broker
systemctl --user enable --now idsh-host
loginctl enable-linger "$USER" # keep it running without a login session
```

`Restart=always` is what makes `broker.update` work: that operation installs the new build, answers,
drains the requests in flight and exits, and the unit starts the new one. The drain waits up to five
seconds (`DRAIN_TIMEOUT_MS`); a request still running then is disconnected and its answer is lost,
though its audit line still lands when the request finishes — a deploy build or a long log read
should be allowed to finish first. Without a supervisor the
CLI still exits after the update, so the broker is gone rather than still running the old build.

How the update installs depends on what the process is running from — it reads its own entry. Run
from `--checkout` (`.../packages/host-broker/lib/cli.js`), it pulls and rebuilds there, so the unit
must start that file. Installed under a prefix with `bin/idsh-host`, it runs
`npm install --global --prefix <prefix> @idsh/host-broker@latest` for that same prefix.

A system unit would default to root, which changes both whose files it reads and who may open the
socket; do not use one. The unit's user also needs to reach the docker daemon, and the broker runs
`docker` from `PATH` — on DSM that is `/usr/local/bin/docker`, so pass `--docker /usr/local/bin/docker`.
`net.status` looks for `ip` in the places a deployment installs it (`/usr/bin/ip`, `/usr/sbin/ip`,
`/sbin/ip`, `/bin/ip`) and falls back to `ip` through `PATH`; a user unit's `PATH` need not carry
`/usr/sbin`, so `--ip /usr/sbin/ip` is the override. `net.sockets` does the same for `ss`
(`--ss`).

A directory the broker creates is `0700` and the socket is chmodded `0600`, so only the uid running
the broker can open it. An existing directory is not narrowed — the read-only fallback in
`ROADMAP.md` uses `0750` — but one that the container could write to is refused.

No credentials are read: the operations are host-local, and the router hop (phase 3) will take its
key from the same directory.

## The protocol

Newline-delimited JSON over a unix stream socket; one request per line, one response per line, in
request order. A line is capped at 16 KiB. A client should send one request at a time; the broker
tolerates a pipeline but pauses reading once sixteen answers are queued.

```json
{"id":"1","op":"log.tail","args":{"file":"messages","lines":50,"pattern":"error"}}
{"id":"1","ok":true,"result":"…"}
```

```json
{"op":"proc.read","args":{"file":"../etc/shadow"}}
{"ok":false,"error":{"code":"bad-argument","message":"file must be one of \"mdstat\", …"}}
```

A `truncated` field appears only when it is `true`, so a normal answer is exactly `{id, ok, result}`.
Error codes are stable: `bad-json`, `bad-request`, `unknown-op`, `bad-argument`, `unavailable`,
`timeout`, `too-many-requests`, `line-too-long`, `internal`. A refusal is audited like any other
request.

## Operations (first slice)

| op                | behaviour                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `log.tail`        | the last lines of `messages`, `syslog` or `kern.log`, optionally filtered by a literal string                                                                                  |
| `proc.read`       | `mdstat`, `loadavg`, `meminfo`, `uptime` or `vmstat`                                                                                                                           |
| `proc.list`       | the process table: pid, parent, state, resident set and command name, biggest first                                                                                            |
| `net.status`      | the host's addresses, routes and neighbours, read with `ip`; `what` picks `addr`, `route` (IPv4 and IPv6), `neigh` or `all`                                                    |
| `net.sockets`     | the host's listening sockets and connections, read with `ss`; `what` picks `listen`, `connections` or `all` (the default)                                                      |
| `disk.usage`      | `df -h`                                                                                                                                                                        |
| `run`             | one declared, read-only binary with an argv parsed against its declaration (no shell), a fixed PATH, and `dryRun` answering the verdict without running; confirmation required |
| `broker.status`   | this broker: version, pid, start time, socket, audit file and checkout                                                                                                         |
| `broker.update`   | updates the broker where its own entry lives — pull and rebuild from `--checkout`, or install the published package under an npm prefix — then exits for its supervisor        |
| `deploy.status`   | the deployment container: image, creation time and state                                                                                                                       |
| `deploy.log`      | the tail of the deployment container log                                                                                                                                       |
| `deploy.versions` | read-only: the container state and image, and the `dsh` and `gcb` versions inside it                                                                                           |
| `deploy.build`    | builds `:dev` from a PR head or an origin branch tip, keeps the previous image for rollback, and reaps the `idsh.keep=1` images it made unnecessary                            |
| `deploy.main`     | builds the tip of `main` as `:dev` and recreates the container from it in the same call                                                                                        |
| `deploy.source`   | resolves a build request — branch tip and `main` sha, or `main` alone — without building; the `preview` of `deploy.build` and `deploy.main`                                    |
| `deploy.rollback` | retags `:dev` to the image recorded before the last build and recreates from it                                                                                                |
| `deploy.recreate` | runs fixed `docker compose up -d --no-build` in `--checkout`; confirmation required                                                                                            |
| `gcb.allow`       | adds or removes one allowlist entry through the staged gcb host CLI (host defaults to github.com); confirmation required                                                       |
| `gcb.update`      | updates both credential-broker halves from one commit (`--gcb-host`, `--gcb-client-image`, `target`); confirmation required                                                    |
| `ops.describe`    | the table itself — names, summaries and schemas; a `{protocol}` client gets the envelope, an older one the bare table                                                          |

### Operation notes

`gcb.allow` writes the configuration through gcb's own typed command — `config allow add|remove
<host> <owner/name> --config <file>` — run from the staged tree
(`node --conditions=development <deploy-dir>/app/packages/host/bin/gcb.js`). The write is gcb's
atomic replace, so the daemon reloads without a restart. `<file>` is the broker's `--gcb-config` (a startup option), defaulting to
`<deploy-dir>/config/broker.config.yml` — pass the file the host daemon was started with. gcb 0.7.0
reports `config: null` until its daemon has loaded the file, so the explicit option is what the
deployment uses; gcb#118 asks for a status that answers from the start.
An entry that is not exact (`owner/name`,
no glob or URL) is refused by that command. `--gcb-host` and `--gcb-checkout` are **broker startup options**, not arguments of this or any
operation: a broker started with them is the one that can stage a tree, and one started without
`--gcb-host` does not offer `gcb.allow` at all (`unknown-op`). The staged tree has to be a gcb that
has `config allow` (gcb#103); an older one answers with its own `config check|edit` usage, which
never says it is old — run `gcb.update` (target `host`, or the default both) to stage a newer one.

`run` takes one declared binary — `ping`, `dig`, `traceroute`, `ip addr/route/neigh`, `ss`,
`df`, `free`, `uptime` — with one declared spelling per flag and no path yet. The argv is rebuilt
from the parsed values rather than forwarded, the lookup uses a fixed PATH rather than the broker's
inherited one, and `dryRun: true` answers the policy verdict without executing.

`broker.update` from a checkout runs `git pull`, `pnpm install` and
`pnpm --filter @idsh/host-broker build`; under an npm prefix it installs the published package
there instead.

`deploy.versions` uses fixed probes — the broker deliberately exposes no arbitrary exec — which
is why it answers versions rather than arbitrary paths inside the image.

`deploy.build` takes the six root-surface files from `main` and the rest from the requested commit,
records the previous image id for `deploy.rollback`, and then removes every `idsh.keep=1` image that
is neither the image it produced nor that recorded target. What it could not remove, could not list
in full, could not resolve, or ran out of time for is reported and retried by the next build, so
builds do not accumulate.

`deploy.source` runs the same resolution as the build — the log id and the source — and names what
would be built. `deploy.build` and `deploy.main` use it as their `preview`, so the confirmation
asks about the resolved source rather than the request.

`gcb.update` pulls `--gcb-checkout` with a bounded, non-interactive `git pull --ff-only` (60 s,
`GIT_TERMINAL_PROMPT=0`, plus `BatchMode` when none of `GIT_SSH`, `GIT_SSH_COMMAND` or
`core.sshCommand` is configured — a configured command is left to avoid prompts itself; the remote's
configuration decides ssh or HTTPS, and the proxy). A dirty checkout is refused before the pull.

It then builds the client image first when `--gcb-client-image` names one (a canonical reference
equal to the broker image is refused, because the build would replace the image the service runs),
and the daemon image with the tag the compose service names. Once that image exists, a later failure
(pin, recreate, probe) restores the tag to the image the service was running when one was recorded;
a broker-build failure does not restore — the tag normally moves only when a build succeeds, but a build
that times out or is cancelled after Docker tagged the image can leave it moved: wait for the
deployment lock to clear, check the tag, and put it back on the image the service runs if it moved.
The client build has the same edge: a cancelled or timed-out one can have moved the
`--gcb-client-image` tag, so check that tag points where intended before a later `deploy.build`.
A restored tag does not replace
a container the recreate already started: a restart keeps that container's image, so running the
restored tag means checking the answer — or the broker log, after a timeout — for `the tag is back
on <id>` first: if the restore failed or was skipped, the tag still points at the new image and a
recreate will not return to the old one. When it did go back, recreate that one service with the same
`-f` files in the same order (absolute: the broker resolved them against its own working directory
when it started) and `up -d --no-deps --no-build --pull never <--gcb-service>`,
run from `--gcb-checkout`, where `gcb.update` runs compose, so a relative `COMPOSE_ENV_FILES`
resolves the same (`.env` comes from the first `-f` file's directory either way) — and with the
environment it used (the compose file needs `GCB_IMAGE`, and `UID`/`GID` for the broker's user).
A retry rebuilds the daemon image and replaces the tag again.
`deploy.build` reads the default `code-vaults/gcb-client:dev` tag, so a client built under another
tag has to be retagged to that default before the dev image picks it up.

With `--gcb-host` it pins the host-supervised broker (`--gcb-deploy-dir`, default
`$HOME/.broker-host`) to the commit, restarts it and waits until it has staged that commit; then it
recreates only `--gcb-service` (default `gcb`) with `--no-build --pull never --wait` and probes
`--gcb-probe-repo` with `docker exec <--container> gcb probe`. `--gcb-compose` takes one or more
files, comma-separated, so a base-plus-overlay deployment is handled.

`target` (`both` by default, or `container`/`host`) narrows the update to one half — the recovery
path after a two-phase failure, without rebuilding the other. It still pulls the latest commit, so if
upstream moved in between, run without `target` to converge both; naming a half that is not
configured is an error. The operation is offered when `--gcb-checkout` is set and at least one half
is configured.

The answer is negotiated, not changed: the envelope goes only to a client that declares a protocol,
so updating either side alone cannot cost the other its tools — an old plugin keeps getting the bare
table it expects, and a newer one compares the protocol it receives with its own instead of letting a
mismatch surface later as an unknown argument.

What the negotiation cannot fix is staleness: the broker and the plugin have **two lifecycles** (the
plugin is baked into the image, the broker runs from the deployment's checkout). The plugin asks for
the table at load and again every minute, so a broker change reaches it within a minute without a
container recreate, while a plugin change still never reaches the broker. After a plugin change,
`deploy.recreate`; after a broker change, `broker.update` (it exits and lets its supervisor start the
new build).

`log.tail` reads a bounded window from the end of the file and drops a partial first line, so it
never returns half a row. Its `pattern` is a literal substring, not a regular expression: nothing
to escape, nothing that can backtrack.

## Bounds

- **Output** is capped at 64 KiB: a tail answer keeps its last lines and a head answer its first,
  trimmed to a line boundary inside the window (or to a character boundary when the text has none);
  a truncated answer says so.
- **Rate**: 60 requests per operation per minute by default; the refusal is `too-many-requests`.
- **Time**: 10 seconds per operation by default; a program that outlives it answers `timeout`, and
  its process group is stopped with it, so whatever it started goes too. An operation may publish a
  longer `timeoutMs` (the build takes up to 15 minutes), and the plugin then waits that long. A
  serialized operation that finds another deployment running answers `unavailable` — stop it or wait
  for it, then run the operation again; nothing queues. When the answer's deadline passes, the
  request's signal stops the program it started. `gcb.update` is the exception: its tag restore
  ignores the signal so the tag can go back, and the deployment lock is held until that cleanup
  settles — a timed-out update can therefore retag after its `timeout` answer, and its restore
  outcome is written to the broker's stderr (its log), since the answer has already gone. `broker.status` does
  not expose that lock; on a broker that offers `gcb.update`, probe it with a request whose `target`
  is invalid — `unavailable` means the lock is held, `bad-argument` means it was free at that moment,
  and a broker without that operation answers `unknown-op` — rather than with a real deployment
  request, and wait for the lock to free before manual recovery.
- **Buffer**: one program may write 1 MiB. Past that a tail operation keeps the last 1 MiB (the
  oldest bytes are dropped) and a head operation the first 1 MiB (the newest are), then the answer
  cap keeps the newest lines for a log and the first ones otherwise, always saying `truncated`.
- **Audit**: one JSON line per request — operation, outcome, duration, bytes, truncation, the
  arguments capped at 200 characters — written before the response. If the audit cannot be written,
  the response is an error, not a success. The file is append-only and unbounded; rotating it is the
  host's job, with the same log rotation everything else on that machine gets. The state directory
  also holds `compose.log` and `build.log` (detached launches), `rollback` (the last build's target),
  and `build/<socket-hash>/` (build clones, keyed by the socket path and swept when this broker takes
  its socket).

## What is not here yet

`run` has its first declarations (the table above lists them) but takes no path yet: the race-safe
path guard comes with the first declaration that does. The router operations are phase‑3 work in
`ROADMAP.md`. Through the plugin, `run` is `confirm: true`, so a `dryRun: true` call still asks
before it answers the verdict.
`deploy.recreate` is the first destructive operation: it runs one fixed `docker compose` in
`--checkout` (which must hold `docker-compose.yml` and `docker-compose.dev.yml`, and
`docker-compose.broker.yml` too when the credential broker runs in a container, and `GCB_IMAGE` must name the image that file
runs. Put it in the deployment's `.env`: compose runs with the checkout as its working directory,
so that file is read for the manual command, for `pnpm deploy:prod` and for the broker's detached
recreate alike, and it moves when the pin moves. A value in the broker's own environment wins over
`.env`, so pinning it only there would let a bump in `.env` leave the broker's recreate on the
older image; without a value at all the recreate fails at interpolation, with compose's own
message in `compose.log`). The broker's recreate always merges `docker-compose.dev.yml`, so it
brings a deployment back to `:dev`: a production deployment is deployed by `pnpm deploy:prod`,
not by this operation), and the plugin asks the person before calling it. `deploy.build` records the rollback target, and `deploy.rollback`
uses the recreate path with that image; one deployment lock serializes the four. A recreate is
acknowledged first and launched detached, so the answer arrives before the container is replaced;
`<stateDir>/compose.log` records the outcome.

## Not in the image

This is not a dsh plugin: it has no `dsh` field, and the container has no reason to see it. The
plugin that talks to it (`@idsh/host-ops`) is separate, and only that one is baked into the
profile.
