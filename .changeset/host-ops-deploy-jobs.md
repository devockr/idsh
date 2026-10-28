---
"@idsh/host-ops": minor
---

`deploy.build` and `deploy.main` run as dsh background jobs when the host has a job registry: the
tool answers with a job id at once, the broker's build log streams into the job's output ring (the UI
follows it, `job_output` reads it), and an interrupted tool call no longer loses the deployment.
Mount the broker's state directory at `/run/idsh-host-state` for the log; `statePath` overrides it.
