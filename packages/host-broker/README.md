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
         [--container <name>] [--docker <path>] [--git <path>] [--checkout <dir>]
```

Both paths belong **outside every bind mount**, and the host's scheduler is what keeps the process
alive:

A user unit, so the broker runs as the same uid the socket is for:

```ini
# ~/.config/systemd/user/idsh-host.service
[Service]
ExecStart=%h/.local/bin/idsh-host --socket %h/.local/state/idsh-host/host.sock --audit %h/.local/state/idsh-host/audit.jsonl
Restart=always

[Install]
WantedBy=default.target
```

```sh
npm i -g --prefix ~/.local @idsh/host-broker
systemctl --user enable --now idsh-host
loginctl enable-linger "$USER" # keep it running without a login session
```

A system unit would default to root, which changes both whose files it reads and who may open the
socket; do not use one. The unit's user also needs to reach the docker daemon, and the broker runs
`docker` from `PATH` — on DSM that is `/usr/local/bin/docker`, so pass `--docker /usr/local/bin/docker`.

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

| op                | behaviour                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log.tail`        | the last lines of `messages`, `syslog` or `kern.log`, optionally filtered by a literal string                                                     |
| `proc.read`       | `mdstat`, `loadavg`, `meminfo`, `uptime` or `vmstat`                                                                                              |
| `disk.usage`      | `df -h`                                                                                                                                           |
| `deploy.status`   | the deployment container: image, creation time and state                                                                                          |
| `deploy.log`      | the tail of the deployment container log                                                                                                          |
| `deploy.build`    | builds `:dev` from a PR head or an origin branch tip; the six root-surface files come from `main`, and the previous image id is kept for rollback |
| `deploy.recreate` | runs fixed `docker compose up -d --no-build` in `--checkout`; confirmation required                                                               |
| `ops.describe`    | the table itself: names, summaries and each operation's schema                                                                                    |

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
  longer `timeoutMs` (the build takes up to 15 minutes), and the plugin then waits that long.
- **Buffer**: one program may write 1 MiB. Past that a tail operation keeps the last 1 MiB (the
  oldest bytes are dropped) and a head operation the first 1 MiB (the newest are), then the answer
  cap keeps the newest lines for a log and the first ones otherwise, always saying `truncated`.
- **Audit**: one JSON line per request — operation, outcome, duration, bytes, truncation, the
  arguments capped at 200 characters — written before the response. If the audit cannot be written,
  the response is an error, not a success. The file is append-only and unbounded; rotating it is the
  host's job, with the same log rotation everything else on that machine gets. The state directory
  also holds `compose.log` and `build.log` (detached launches), `rollback` (the last build's target),
  and `build/<socket-name>/` (build clones, swept when this broker takes its socket).

## What is not here yet

`deploy.rollback`, the router operations and the `run` allowlist are phase‑1/phase‑3 work in
`ROADMAP.md`. `deploy.recreate` is the first destructive operation: it runs one fixed
`docker compose` in `--checkout` (which must hold `docker-compose.yml` and `docker-compose.dev.yml`),
and the plugin asks the person before calling it. It is acknowledged first and launched detached, so
the answer arrives before the container is replaced; `<stateDir>/compose.log` records the outcome.

## Not in the image

This is not a dsh plugin: it has no `dsh` field, and the container has no reason to see it. The
plugin that talks to it (`@idsh/host-ops`) is separate, and only that one is baked into the
profile.
