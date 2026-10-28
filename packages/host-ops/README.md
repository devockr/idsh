# @idsh/host-ops

The agent-facing half of the host broker: the container holds a socket path, never a host
credential. On load the plugin asks `@idsh/host-broker` for its operation table and registers one
dsh tool per operation, so the model sees the broker's summaries and JSON Schemas under a
tool-safe name (`log.tail` becomes `idsh_log_tail`; the call still goes to the broker as `log.tail`).

## Configure

```yaml
- id: host-ops
  name: '@idsh/host-ops'
  config:
    socketPath: /run/idsh-host/host.sock
    timeoutMs: 15000
```

`socketPath` defaults to `/run/idsh-host/host.sock` and `timeoutMs` to 15 seconds — slightly longer
than the broker's own 10-second operation deadline, so the broker's `timeout` is the one the agent
sees. An operation that publishes its own `timeoutMs` (the build) uses that instead, for the tool
call and the socket wait alike. The socket's directory is the deployment's to mount; this package names nothing else.

## Shape

- A tool call is one line to the broker and one line back, on a fresh connection. Nothing is
  pipelined, and the broker validates the arguments against the schema it published.
- The broker owns the bounds and the audit log: output is capped, operations are rate-limited, and
  every call — refusals included — leaves a line before the answer.
- A broker that is down does not fail the profile: the plugin logs a warning and registers no tools,
  so the delegation still boots and the tools appear the next time the plugin loads.
- A destructive operation (`confirm: true` in the broker's table) asks first, inside the tool call:
  the question service blocks and holds the answer, so a model cannot fabricate a yes. Only the
  "Run" option confirms it. A free-text answer is a reply, not an approval — the person may be
  asking what the operation does — so it leaves the host untouched and is passed back in the error,
  where the assistant can answer it and ask again. Cancel, a skipped question and an empty answer
  behave the same.

## Long deploys as jobs

`deploy.build` and `deploy.main` take minutes, so with a job registry present (`ctx.jobs`) the tool
starts a `deploy` job and answers with its id at once: the broker keeps building, the job pulls the
broker's `build.log` into its output ring, and the UI streams it while `job_output` reads it.

Every deploy job follows the same `build.log`, so a _refused_ deploy — one the broker turns away
because another build holds the deployment lock — can show a sliver of that running build's output
before its own refusal lands. The lock keeps two builds from running, and a job that is accepted
starts at the file's current size, so its ring never replays anything earlier.

The job is process-local (the registry lives in this dsh process), so a container recreate ends it
with everything else — what survives is the broker's build log on the host, and what stops blocking
is the tool call. The registry drains every source one last time before settlement, so a build that
finished within one poll still leaves its tail in the ring. Without a job registry the operations
stay synchronous.

The deployment mounts the broker's state directory at `/run/idsh-host-state` (read-only) for that
log — that directory also holds `audit.jsonl`, so mount only `build.log` when the narrower view is
wanted. `statePath` overrides where the log is read from. Killed jobs report `killed` and cancel the
client call; the broker's own budget (15 minutes) still ends the build if nobody is watching.

## Not in this package

The operation table, the bounds and the audit are `@idsh/host-broker` (the host program). This
package is the client, and it does not decide what exists.
