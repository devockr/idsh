---
"@idsh/host-ops": minor
---

Add the agent-facing half of the host broker: the plugin asks it for the operation table at load
time and registers one dsh tool per operation, so `log.tail`, `proc.read` and `disk.usage` reach the
agent without a host credential in the container. The tool names are mapped to the providers'
`[a-zA-Z0-9_-]` alphabet (`idsh_log_tail`), while the call still goes to the broker as `log.tail`.
