---
"@idsh/host-ops": patch
---

Read the job registry through cordis's injection-free accessor (`ctx.get('jobs')`): `ctx.jobs` needs
`jobs` in `inject`, and `inject` gates loading, so a required injection would keep the plugin from
loading in a deployment that has no registry. Before this, every tool call failed with
`cannot get property "jobs" without inject` — the registry is provided from a sibling fiber, which
the property read cannot see.
