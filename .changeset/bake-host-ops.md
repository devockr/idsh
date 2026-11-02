---
"@idsh/image": patch
---

The published image bakes `@idsh/host-ops` as well: `:latest` now ships the host tools
(`idsh_deploy_*`, `idsh_broker_*`, `idsh_log_tail`, …) that only `:dev` had, so a published
deployment can reach its host broker. Without a broker the plugin logs its "broker is down" warning
and registers no tools, exactly as it already does on a deployment that mounts no socket. The host
broker itself stays a host program: it is not `dsh plugin add`ed, and nothing in the image runs it.
