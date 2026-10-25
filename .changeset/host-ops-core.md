---
"@idsh/host-ops": minor
---

Add the agent-facing half of the host broker: the plugin asks it for the operation table at load
time and registers one dsh tool per operation, so `log.tail`, `proc.read` and `disk.usage` reach the
agent without a host credential in the container.
