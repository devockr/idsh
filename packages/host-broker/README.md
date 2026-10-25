# @idsh/host-broker

The host side of `@idsh/host-ops`: a **typed, audited operation table** behind a unix socket, so
the agent container never holds a host credential.

`ROADMAP.md` at the repository root is the plan; this package is its first slice. It runs on the
host as the deployment's user and answers questions about that host. There is no shell: every
operation reads from a **fixed source** — a known log, a known kernel file, one known program —
with a small set of validated arguments.

## Run it

```sh
idsh-host --socket [--proc-dir < path > --audit < path > [--log-dir < dir > ] < dir > ]
```

Both paths belong **outside every bind mount**, and the host's scheduler is what keeps the process
alive:

```ini
[Service]
ExecStart=/usr/local/bin/idsh-host --socket /srv/idsh-host/host.sock --audit /srv/idsh-host/audit.jsonl
Restart=always
```

The socket's directory is created `0700` and the socket is chmodded `0600`, so only the uid running
the broker can open it. No credentials are read: the operations are host-local, and the router hop
(phase 3) will take its key from the same directory.

## The protocol

Newline-delimited JSON over a unix stream socket; one request in, one response out, nothing
pipelined. A line is capped at 16 KiB.

```json
{"id":"1","op":"log.tail","args":{"file":"messages","lines":50,"pattern":"error"}}
{"id":"1","ok":true,"result":"…","truncated":false}
```

```json
{"op":"proc.read","args":{"file":"../etc/shadow"}}
{"ok":false,"error":{"code":"bad-argument","message":"file must be one of \"mdstat\", …"}}
```

Error codes are stable: `bad-json`, `bad-request`, `unknown-op`, `bad-argument`, `unavailable`,
`timeout`, `too-many-requests`, `line-too-long`, `internal`. A refusal is audited like any other
request.

## Operations (first slice)

| op             | reads                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| `log.tail`     | the last lines of `messages`, `syslog` or `kern.log`, optionally filtered by a literal string |
| `proc.read`    | `mdstat`, `loadavg`, `meminfo`, `uptime` or `vmstat`                                          |
| `disk.usage`   | `df -h`                                                                                       |
| `ops.describe` | the table itself: names, summaries and each operation's schema                                |

`log.tail` reads a bounded window from the end of the file and drops a partial first line, so it
never returns half a row. Its `pattern` is a literal substring, not a regular expression: nothing
to escape, nothing that can backtrack.

## Bounds

- **Output** is capped at 64 KiB, trimmed on a line boundary, and a truncated answer says so.
- **Rate**: 60 requests per operation per minute by default; the refusal is `too-many-requests`.
- **Time**: 10 seconds per operation by default.
- **Audit**: one JSON line per request — operation, outcome, duration, bytes, truncation, the
  arguments capped at 200 characters — written before the response. If the audit cannot be written,
  the response is an error, not a success.

## What is not here yet

`run(binary, argv)` with its allowlist and path guard, the deploy operations and the router
operations are all phase‑1/phase‑3 work in `ROADMAP.md`. This package is deliberately only the
socket, two read sources, the bounds and the audit — the parts the rest is built on.

## Not in the image

This is not a dsh plugin: it has no `dsh` field, and the container has no reason to see it. The
plugin that talks to it (`@idsh/host-ops`) is separate, and only that one is baked into the
profile.
