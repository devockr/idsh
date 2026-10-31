# @idsh/host-ops

## 0.1.0

### Minor Changes

- [#63](https://github.com/devockr/idsh/pull/63) [`60ea040`](https://github.com/devockr/idsh/commit/60ea040137ee53cc812386aacfa0be9a1cbc13f3) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.recreate`: one fixed `docker compose up -d --no-build` in the configured checkout, marked
  `confirm` in the table. The plugin now asks the person inside the tool call before any such operation
  and treats anything but an explicit "Run" as no.

- [#58](https://github.com/devockr/idsh/pull/58) [`b76a1bb`](https://github.com/devockr/idsh/commit/b76a1bbc424e4797d961527e7722b593452862f6) Thanks [@JounQin](https://github.com/JounQin)! - Add the agent-facing half of the host broker: the plugin asks it for the operation table at load
  time and registers one dsh tool per operation, so whatever the broker advertises reaches the agent
  without a host credential in the container. The tool names are mapped to the providers'
  `[a-zA-Z0-9_-]` alphabet (`idsh_log_tail`), while the call still goes to the broker as `log.tail`.

- [#72](https://github.com/devockr/idsh/pull/72) [`636c7ca`](https://github.com/devockr/idsh/commit/636c7cabe2998ce1826024d577597751e29fcc64) Thanks [@JounQin](https://github.com/JounQin)! - `deploy.build` and `deploy.main` run as dsh background jobs when the host has a job registry: the
  tool answers with a job id at once, the broker's build log streams into the job's output ring (the UI
  follows it, `job_output` reads it), and an interrupted tool call no longer loses the deployment.
  Each build writes its own `build-<log>.log`, so a job follows only its own call's output. Streaming
  needs a broker whose table declares `log`: against an older broker the operations stay synchronous
  (no background job, the answer is the tool result), which is the pre-existing behaviour rather than
  a regression. Mount the broker's state directory at `/run/idsh-host-state` for the log; `statePath`
  overrides it.

### Patch Changes

- [#64](https://github.com/devockr/idsh/pull/64) [`556b592`](https://github.com/devockr/idsh/commit/556b5925d32dc5bed747bbdfd16fe0d334a2fc37) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.build`: resolve a PR head or an origin branch tip with `git ls-remote` (fetching first, so
  a stale checkout still works), pin `main` to the sha resolved at the same moment, clone into a fresh
  temporary directory and replace the six root-surface files with main's, then build `:dev` in the base
  image with `--entrypoint`/`--user`. Images it produces carry `--label idsh.keep=1`, so a prune keeps
  them; separately, the image the container was running before the build is recorded in
  `<stateDir>/rollback` — its manifest digest when it was pulled, its id otherwise — as the rollback
  target. The plugin waits for the operation's own `timeoutMs`; the build log lands in
  `<stateDir>/build.log`.

- [#70](https://github.com/devockr/idsh/pull/70) [`77c0768`](https://github.com/devockr/idsh/commit/77c07688685e3852ec9f8bbdbe2627f7d57f5f6d) Thanks [@JounQin](https://github.com/JounQin)! - A destructive operation is confirmed only by the "Run" option. A free-text answer is a reply, not an
  approval: the host is left untouched and the text is passed back in the error, so the assistant can
  answer the question and ask again instead of the reply disappearing.
