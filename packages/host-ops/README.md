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
sees. The socket's directory is the deployment's to mount; this package names nothing else.

## Shape

- A tool call is one line to the broker and one line back, on a fresh connection. Nothing is
  pipelined, and the broker validates the arguments against the schema it published.
- The broker owns the bounds and the audit log: output is capped, operations are rate-limited, and
  every call — refusals included — leaves a line before the answer.
- A broker that is down does not fail the profile: the plugin logs a warning and registers no tools,
  so the delegation still boots and the tools appear the next time the plugin loads.
- A destructive operation (`confirm: true` in the broker's table) asks first, inside the tool call:
  the question service blocks and holds the answer, so a model cannot fabricate a yes. Anything but
  the explicit "Run" option — cancel, a skipped question, an empty answer — means the host is not
  touched.

## Not in this package

The operation table, the bounds and the audit are `@idsh/host-broker` (the host program). This
package is the client, and it does not decide what exists.
