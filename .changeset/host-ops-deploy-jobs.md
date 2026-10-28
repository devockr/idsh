---
"@idsh/host-ops": minor
---

`deploy.build` and `deploy.main` run as dsh background jobs when the host has a job registry: the
tool answers with a job id at once, the broker's build log streams into the job's output ring (the UI
follows it, `job_output` reads it), and an interrupted tool call no longer loses the deployment.
Each build writes its own `build-<log>.log`, so a job follows only its own call's output. Streaming
needs a broker whose table declares `log`: against an older broker the operations stay synchronous
(no background job, the answer is the tool result), which is the pre-existing behaviour rather than
a regression. Mount the broker's state directory at `/run/idsh-host-state` for the log; `statePath`
overrides it.
