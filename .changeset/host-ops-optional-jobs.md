---
"@idsh/host-ops": patch
---

Read the job registry through cordis's injection-free accessor, `ctx.get('jobs')`: `ctx.jobs` needs
`jobs` in `inject`, and `inject` gates loading, so a required injection would keep the plugin from
loading at all. The registry ships with dsh (`dsh-base` loads `@deepseek-ai/dsh-jobs-local`), so it is
treated as present — a deployment without it is not supported: its first background deploy fails
instead of silently dropping to a synchronous path.

Before this, every tool call failed with `cannot get property "jobs" without inject`: the registry is
provided from a sibling fiber, which the property read cannot see.
