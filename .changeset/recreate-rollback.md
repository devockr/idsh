---
"@idsh/host-broker": minor
---

A recreate verifies what it created. Success is compose exiting 0 and the container it started
running with `health=healthy`: a non-zero `up` fails the recreate even when a container looks fine,
a container with no health status at all counts as failed, and a container that exits, dies,
restarts in a loop or reports `unhealthy` ends the wait at once instead of burning the window.
One that is merely starting is watched.

A no-op `up` is a success, not a failure: a profile-only change, or re-shipping an unchanged `main`,
leaves a bind-mounted container alone and is reported as unchanged.

On failure the deployment is restored to the image it was running — `deploy.main` to the image
recorded before its build, `deploy.recreate` to the image it found, and a first deploy to the
recorded file — and the rescue counts when the deployment runs that image again and is healthy.
A tag moved back to the image already running therefore restores it without replacing the container.
The one case deliberately left alone is a failed `up` that did not touch a healthy container:
restoring the image already running could only reproduce it. `deploy.rollback` verifies its own
result the same way but cannot roll back further, and says so.

None of it can be reported to the caller (the session's container is what was replaced), so each
outcome is written to `compose.log`, with parsed docker reads answering from stdout only so a
wrapper's warning cannot become an id, a state or a rollback target. `docker-compose.example.yml`
now carries the health check this requires.
