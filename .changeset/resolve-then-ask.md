---
"@idsh/host-broker": minor
"@idsh/host-ops": minor
---

`deploy.build` and `deploy.main` now carry a `preview`: the new read-only `deploy.source` resolves
the request — the branch tip, and the `main` sha the build pins — before the person is asked, so the
confirmation shows a commit rather than `{"pr": 82}`. `deploy.source` also answers with `main`
alone, which is what `deploy.main` builds, and checks the whole request with the functions the
build runs, so a `log` id or a `pr`/`sha` pair the build would refuse is refused before the
question. A preview that cannot resolve is the error the person sees: no question is asked and the
operation is never called.
