# @idsh/host-broker

## 0.3.0

### Minor Changes

- [#99](https://github.com/devockr/idsh/pull/99) [`dd432be`](https://github.com/devockr/idsh/commit/dd432be781a9cc15f76cbb9eaead231cb1ec7cdf) Thanks [@JounQin](https://github.com/JounQin)! - `run` joins the table: one declared, read-only binary per call — `ping`, `dig`, `traceroute`,
  `ip addr/route/neigh`, `ss`, `df`, `free`, `uptime` — with an argv parsed against the declaration
  instead of a shell, so an undeclared binary, an undeclared flag, a missing flag value or an extra
  positional is `bad-argument` rather than something the host runs. `dryRun: true` answers the verdict
  without executing, and the operation is `confirm: true`: a person is asked before a program starts on
  the host. No declaration takes a filesystem path yet, so the race-safe path guard arrives with the
  first one that does.

### Patch Changes

- [#94](https://github.com/devockr/idsh/pull/94) [`8b5773b`](https://github.com/devockr/idsh/commit/8b5773b919f707ca1897f92e1cf6c305d7594226) Thanks [@JounQin](https://github.com/JounQin)! - `broker.update` decides how it was installed by comparing the running entry with `--checkout`, and
  that comparison is now made on resolved paths: both sides go through `realpath`, a path that no
  longer exists is named through its nearest existing ancestor, a symlink whose target is gone is
  followed by the target it names, and `..` is matched as a path segment rather than a string prefix. A
  checkout reached through a symlink (the deployment's `/var/services/…` against a process that
  resolved to `/volume1/…`), or a rebuild that cleaned `lib/`, is therefore recognised as the checkout
  it is instead of refusing with "cannot tell which npm prefix … belongs to" — and a child directory
  named `..build` stays inside it. The resolution is asynchronous: the broker answers every request
  from one event loop, so a synchronous lookup on a filesystem that stopped answering would stall all
  of them, not only this operation.

## 0.2.0

### Minor Changes

- [#88](https://github.com/devockr/idsh/pull/88) [`7ae99f5`](https://github.com/devockr/idsh/commit/7ae99f5ef8b036e473f67577865e6c1926166eb0) Thanks [@JounQin](https://github.com/JounQin)! - `ops.describe` is negotiated: a client that declares `{protocol}` gets `{ protocol, version, ops }` and
  a client that declares nothing gets the bare table it has always read. A newer plugin therefore
  warns — "older broker", or a different protocol number — instead of an older plugin losing every host
  tool against a newer broker, which is what a one-way change to the answer would have caused.

## 0.1.0

### Minor Changes

- [#70](https://github.com/devockr/idsh/pull/70) [`77c0768`](https://github.com/devockr/idsh/commit/77c07688685e3852ec9f8bbdbe2627f7d57f5f6d) Thanks [@JounQin](https://github.com/JounQin)! - Add `broker.status` (version, pid, start time, socket, audit file, checkout) and `broker.update`:
  the broker pulls and builds itself from `--checkout` (`git pull`, `pnpm install`,
  `pnpm --filter @idsh/host-broker build`), or installs the published package when it has no checkout,
  then exits so its supervisor starts the new build. A failed step is the answer, not a silent no-op,
  and no deployment can overlap the update.

- [#64](https://github.com/devockr/idsh/pull/64) [`556b592`](https://github.com/devockr/idsh/commit/556b5925d32dc5bed747bbdfd16fe0d334a2fc37) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.build`: resolve a PR head or an origin branch tip with `git ls-remote` (fetching first, so
  a stale checkout still works), pin `main` to the sha resolved at the same moment, clone into a fresh
  temporary directory and replace the six root-surface files with main's, then build `:dev` in the base
  image with `--entrypoint`/`--user`. Images it produces carry `--label idsh.keep=1`, so a prune keeps
  them; separately, the image the container was running before the build is recorded in
  `<stateDir>/rollback` — its manifest digest when it was pulled, its id otherwise — as the rollback
  target. The plugin waits for the operation's own `timeoutMs`; the build log lands in
  `<stateDir>/build.log`.

- [#66](https://github.com/devockr/idsh/pull/66) [`2e2afde`](https://github.com/devockr/idsh/commit/2e2afdef9a9f5d71c35a8ef490a4acf6e75903ca) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.main`: resolve the tip of `origin/main`, build it as `:dev` with the same root-surface
  pin as `deploy.build`, record the previous image for `deploy.rollback`, and recreate the container
  from the new image in the same call — acknowledged first, with the compose detached 500 ms later,
  under the deployment lock.

- [#83](https://github.com/devockr/idsh/pull/83) [`8653f42`](https://github.com/devockr/idsh/commit/8653f4255052d2dc6b76b87d022797b384fec90e) Thanks [@JounQin](https://github.com/JounQin)! - A `deploy.build`/`deploy.main` now retires the images earlier builds left behind: after the build it
  removes every image labelled `idsh.keep=1` that is neither the one it just produced nor the recorded
  rollback target. The label still keeps a locally built target through the host's `docker image
  prune -a --filter 'label!=idsh.keep=1'`; what changes is that the exemption is bounded by the broker
  instead of relying on an operator. After a build at most two such images stay on disk, and a sweep
  that cannot finish leaves the rest for the next build: one whose `docker image rm` fails stays where
  it is, a listing longer than the broker's output window removes nothing rather than sweeping the part
  it can see, an image this build produced that does not resolve is not touched (removing it would take
  the tag the recreate is about to use), and a sweep that runs out of the build's time stops where it
  stood. The build answer names which of them happened, so a sweep that finished short is visible
  instead of looking complete.

- [#63](https://github.com/devockr/idsh/pull/63) [`60ea040`](https://github.com/devockr/idsh/commit/60ea040137ee53cc812386aacfa0be9a1cbc13f3) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.recreate`: one fixed `docker compose up -d --no-build` in the configured checkout, marked
  `confirm` in the table. The plugin now asks the person inside the tool call before any such operation
  and treats anything but an explicit "Run" as no.

- [#65](https://github.com/devockr/idsh/pull/65) [`481f972`](https://github.com/devockr/idsh/commit/481f9722749ca5873983546f563dfd8e1e9153b9) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.rollback`: retag `:dev` to the image recorded in `<stateDir>/rollback` before the last
  build — the manifest digest when it was pulled, the id otherwise — and recreate from it. A missing,
  empty, non-image or multi-line target is refused before anything is queued (the read-only
  `docker image inspect` is that check); an image removed after it fails the deferred tag, which is
  written to `compose.log` and stops the compose.

  Builds, recreates and rollbacks now share one deployment lock: a build cannot retag `:dev` while a
  recreate's compose is starting, and a rollback's tag cannot land under a running build. An operation that
  finds another deployment running answers `unavailable` (stop it or wait, then run again) instead of
  queueing; one whose answer times out is stopped, so it cannot finish its work behind the answer.

- [#82](https://github.com/devockr/idsh/pull/82) [`e8e6280`](https://github.com/devockr/idsh/commit/e8e62806c4881b21f217d4ce51b8ffdee3d92d82) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb.update`: rebuild the credential broker from its own checkout — `git pull`, then
  `docker build --target host` with the image its compose names — recreate only that service with
  `--no-build --pull never --wait`, and probe it through the deployment's own client. `--gcb-compose`
  takes one or more files, comma-separated (a base file plus an overlay), and `--gcb-service` (default
  `gcb`) names the broker inside them; both are validated at boot and against `config --services`.
  It asks the person first, runs under the deployment lock, and refuses a service that declares more
  than one container.

- [#55](https://github.com/devockr/idsh/pull/55) [`dd79783`](https://github.com/devockr/idsh/commit/dd79783829339e6e57ece77b05cea173200708b3) Thanks [@JounQin](https://github.com/JounQin)! - Add the first slice of the host broker: the unix-socket protocol, `log.tail`, `proc.read`,
  `disk.usage`, `ops.describe`, rate limiting and an audit log. The dsh plugin that consumes it, and
  `run(binary, argv)`, are not in this release.

- [#62](https://github.com/devockr/idsh/pull/62) [`46f72f6`](https://github.com/devockr/idsh/commit/46f72f6223c3312bb5be79d9f90f054d727099d9) Thanks [@JounQin](https://github.com/JounQin)! - Add `deploy.status` and `deploy.log`: the broker inspects the deployment container through one
  fixed `docker` invocation — no shell and no caller-supplied argv — with `--container` and
  `--docker` for hosts where either differs.

- [#68](https://github.com/devockr/idsh/pull/68) [`beafce8`](https://github.com/devockr/idsh/commit/beafce8e207fbbfb916df9df1f3913fa490976c2) Thanks [@JounQin](https://github.com/JounQin)! - Add `net.sockets`: the host's listening sockets (`ss -tulpn`) and its TCP/UDP connections
  (`ss -tunp`), one `## <table>` section each; `what` picks `listen`, `connections` or `all` (the
  default). The `ss` client is resolved from the usual locations with a `PATH` fallback, and `--ss`
  overrides it.

- [#67](https://github.com/devockr/idsh/pull/67) [`7f48ec5`](https://github.com/devockr/idsh/commit/7f48ec5e89d2c66d33ce0becc891ea688bd3ef5f) Thanks [@JounQin](https://github.com/JounQin)! - Add `net.status`: the host's addresses, routes and neighbours, read with `ip -br` — `what` picks
  `addr`, `route`, `neigh` or `all` (the default), and each table is its own section. `route` reads
  both address families (`ip -4 -br route` and `ip -6 -br route`), labelled, because `ip route`
  alone is IPv4 and a dual-stack LAN needs both; a host that cannot answer one family fails the
  request rather than returning a partial table. The client is resolved the way the deployment's
  `ip` is installed (the first of `/usr/bin/ip`, `/usr/sbin/ip`, `/sbin/ip`, `/bin/ip`), and
  `--ip` overrides it.

- [#69](https://github.com/devockr/idsh/pull/69) [`861c00a`](https://github.com/devockr/idsh/commit/861c00a96e4617cfea51bf8b914471d030cd4ced) Thanks [@JounQin](https://github.com/JounQin)! - Add `proc.list`: the process table, read from `/proc/<pid>` (never the environment or the argv),
  sorted by resident set and capped at `lines` (default 20, at most 100) — pid, parent, state, RSS in
  KiB and the command name, one row each.

- [#84](https://github.com/devockr/idsh/pull/84) [`7c3ccc2`](https://github.com/devockr/idsh/commit/7c3ccc28f6a8e72a0c2aa3418843051e4c33e0e2) Thanks [@JounQin](https://github.com/JounQin)! - `deploy.build` and `deploy.main` now carry a `preview`: the new read-only `deploy.source` resolves
  the request — the branch tip, and the `main` sha the build pins — before the person is asked, so the
  confirmation shows a commit rather than `{"pr": 82}`. `deploy.source` also answers with `main`
  alone, which is what `deploy.main` builds, and checks the whole request with the functions the
  build runs, so a `log` id or a `pr`/`sha` pair the build would refuse is refused before the
  question. A preview that cannot resolve is the error the person sees: no question is asked and the
  operation is never called.
