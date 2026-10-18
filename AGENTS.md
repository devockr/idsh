# AGENTS.md

The parts of this repository that are easy to get wrong. `README.md` covers what it is and how to
deploy it.

**This file is public**: no hostnames, addresses, ports, ssh commands, no reference to a file
that exists on one machine only, and none of _your own_ proxy or registry settings. Those go
in untracked local notes — the tracked `.gitignore` already ignores `.tasks/`. A public mirror
is not one of them: both Dockerfiles already default `NPM_REGISTRY` to the same npmmirror, so
naming a public mirror here leaks nothing.

## Invariants

- **Compose goes through a login shell.** `${UID:?…}`/`${GID:?…}` and the proxy variables
  only exist there; a bare `sh` dies with `required variable UID is missing a value`. Otherwise
  pass them: `env UID="$(id -u)" GID="$(id -g)" docker compose …`.
- **No patching dsh.** The `sed` block that rewrote `isLoopbackHostname`, the touch CSS, the
  favicon and the composer's Enter key is gone; that behaviour comes from `packages/`. If the UI
  must behave differently, write a plugin.
- **Two images, two purposes — one base.** `Dockerfile`'s `base` target is dsh + pnpm; its final
  stage is the published image: that base plus a profile baked from the registry, installed by name
  and _strictly_ — a release that cannot ship its own plugins is not a release, so the build fails
  while one is unpublished. `Dockerfile.dev` is built from the same `base` target, never from the
  published image, so it does not depend on anything being published; it adds the browsers'
  libraries (the headless shell's set, plus the three the full Chromium adds), and bakes the same
  profile from this checkout's `packages/` as a `link:`. A deployment may mount a checkout over
  `/opt/dsh/packages`, but that checkout has to be **built**
  first (`pnpm --recursive build` turns `src/` into the `lib/` the manifests name): a linked
  package whose entry files are missing is put back to the image's copy, exactly like a broken one.
  A test or development convenience never goes into `Dockerfile`; the published image _should_ fail to
  launch a browser.
- **The image bakes the profile; the entrypoint keeps it to that.** A deployment with no profile gets
  the baked one, exactly as built — that is what keeps a restart free of downloads. An existing
  profile keeps the packages the image declares in the state it declares, compared by the version in
  each package's _own_ `package.json`: one that is missing, declares without files, or sits below the
  image's version is put in place the way the image installed it — a `link:` when the image linked
  (how `Dockerfile.dev` gives a deployment that mounts a **built** checkout over
  `/opt/dsh/packages` source to run), files otherwise, and `file:` specs refreshed on every boot
  because their string cannot show that their files changed. One at that version or above is left
  alone, which is where a pin or a fork lives. Nothing is ever removed, and turning a package off
  means dropping it from `dsh.profile.bundles`, never uninstalling it. Nothing names a package in the
  entrypoint.
- **Script in Node, not Python.** The images carry node 24 — which runs `.ts`/`.mts` directly, no
  flag needed — and no Python: whatever a check or a helper needs, it can do in Node.
- **Alpine is blocked, not abandoned.** `node-addon-require-builtin` ships `linux-*-gnu` prebuilds
  only, so a musl base dies at boot; revisit when upstream ships one, and keep musl-compatible
  choices in `entrypoint.sh` until then.
- **The state directory is runtime state**, bind-mounted and gitignored — not a place for scripts,
  and neither is the image. Local helpers go in `.tasks/` (also gitignored); verification helpers
  stay on the machine that runs them.
- **Machine specifics never get committed.** The real compose file is gitignored; what is tracked
  is `docker-compose.example.yml` for the deployment and `docker-compose.dev.yml` for the browser
  settings, which are a state-directory path and a public mirror and hold nothing personal.
- **Each image has its own ignore file**: `.dockerignore` for `Dockerfile` (which copies
  `entrypoint.sh` and the one tool the entrypoint runs, `tools/sync-companions.mts`),
  `Dockerfile.dev.dockerignore` for the dev image (`packages/` and `tools/dev/`, plus the Dockerfile
  itself, which BuildKit reads from the context). Neither build carries the other's
  content, and a new `COPY` has to be whitelisted in the right one or the build fails loudly.
- **The `@deepseek-ai/dsh@…`/`pnpm@…` pins and the plugins baked into the images** are read by the
  custom managers in `renovate.json`: the first parses the `npm install -g` RUN line to its end, the
  second the `dsh plugin add` lines. Keep both readable by those regexes — on one line, and with
  the versions still in them.

## Images

| tag                   | contents                                                      | used by                              |
| --------------------- | ------------------------------------------------------------- | ------------------------------------ |
| `devockr/idsh:base`   | dsh + pnpm, nothing baked, no browser libraries               | the two images below                 |
| `devockr/idsh:latest` | `:base` + a profile baked from the registry (strict)          | the deployment                       |
| `devockr/idsh:dev`    | `:base` + those libraries; the profile baked from `packages/` | local runs and browser-driven checks |

Build the dev image with `pnpm dev`: it compiles the packages (`pnpm build`), then builds `:base`
and then `:dev` — in that order, and both orders are the point. `:base` carries
`entrypoint.sh` and `tools/sync-companions.mts`, so a `:dev` built without rebuilding it keeps the old ones, which is a stale image
that looks fresh; and the compiled `lib/` is what dsh loads, so `Dockerfile.dev` refuses to build a package
that has none — or whose `src/` is newer than its `lib/`, which is what a forgotten rebuild
looks like — rather than shipping one that cannot load, or is stale. `prepack` runs the same
build on publish. The dev overlay does not build anything: it selects
`image: devockr/idsh:dev`, refuses to pull, and resets the base service's `build`, so
`pnpm dev` stays the only path to `:dev`, and a stale `:base` cannot end up in a `:dev` that looks
freshly built. It needs Compose 2.24.4+ for `!reset`; an older one fails at parse time rather than
building the wrong image.
`docker compose build` is the published image on its own — the one build that needs the plugins
published.

A cached layer once left a browser-dependency set inside `:latest` that the Dockerfile no longer
declared. After an apt change, check the image instead of trusting the build; `--no-cache` when in
doubt.

## Deploying

Rebuilding the container is how `entrypoint.sh`, the `Dockerfile` or the profile's bundle list
takes effect. It also kills whatever is running inside it — including an agent session (sessions
live in the state directory, so the conversation survives, the process does not).

- Start it **on the host, detached** (`setsid sh -c '…' >/dev/null 2>&1 < /dev/null &`): a restart
  dies with the connection that asked for it. The command itself, with the host and the paths,
  lives in the local deployment notes. A deployment may wrap it in a local script that warms the
  image layers and logs what it did — read the log, don't assume.
- Until the plugins are published the published image cannot be built at all, so local runs use
  `:dev` (built from `:base`, plugins from `packages/`) — which is also what "dogfood the source"
  means here.
- A restart is enough when only the _profile_ changed: it re-runs the entrypoint and re-resolves
  bundles. **Hot reload does not re-resolve bundles.**
- **Compose runs as the user who owns the deployment.** `~`-relative bind sources and
  `${UID}`/`${GID}` resolve against whoever invokes it, so the same file launched from another
  HOME (a root container, say) binds different paths — and `docker compose up -d` removes the
  old container _before_ creating the new one, which makes that an outage rather than an error.
  Pass the real HOME, create a throwaway container with the deployment's own bind list before
  recreating, and prove the rollback in that same environment. The concrete commands live in
  the local notes.
- A detached command needs `docker` on `PATH` (or an absolute path) and stderr not discarded: a
  missing binary looks exactly like a successful restart.
- `docker run <image> <cmd>` may hand `<cmd>` to the entrypoint as arguments. Use `--entrypoint`,
  `--user <uid>:<gid>`, absolute paths, and the flags that borrow a running container's
  volumes/network when a check has to reach the live server.

## Verifying

Observe the running thing; do not reason from source.

- Client plugins write markers into `document.body.dataset` (`idshPrivileged`, `idshMobile`).
- **A loopback origin is privileged by definition** — to show that a plugin flipped the gate, load
  the page over a non-loopback address.
- Take the **newest** boot token (an older one answers 401). Logs accumulate across restarts: use
  timestamps before reading anything into a count.
- Browser-driven checks run in `:dev`, not in the published image. The browser binaries are in
  neither image: they live under the state directory (`PLAYWRIGHT_BROWSERS_PATH`), which is why
  a container rebuild re-uses them, and `PLAYWRIGHT_DOWNLOAD_HOST` points a real download at a
  mirror on a slow network — `docker-compose.dev.yml` sets both, the second to the same public
  npmmirror `NPM_REGISTRY` defaults to. An install that was killed leaves a `__dirlock`
  behind and the next attempt waits on it — clear that before retrying.
- For A/B work that must not touch a live deployment, boot a throwaway state directory with its
  own profile instead of the deployment's, and point the launcher at a different dsh build when
  you need one.
- `dsh --profile <name> --dump-config` prints `# == <bundle>, patched by <package>` — that is how
  to prove which layer supplies a value.

## Packages under `packages/`

- Layout: `src/index.ts` for the host half and, when there is a browser half, `src/client.ts`
  — a plain script with no imports, because dsh serves exactly one file per package —
  compiled by `tsc` into `lib/`, which is what `main`/`exports`/`files` name and what ships;
  `cordis.patch.yml`, `README.md`; npm scope `@idsh`.
- **`lib/` is build output**, gitignored, produced by `pnpm --recursive build` _before_ the images
  are built — `Dockerfile.dev` ships those compiled files and refuses to build a package whose
  `lib/index.js` — or `lib/client.js`, when the package also has a browser half — is missing, or
  older than its `src/`, so a forgotten rebuild fails the build instead of shipping a `link:`
  target with nothing to load.
- **A package has no URL.** Its browser half arrives through the bundle endpoint
  (`plugins/??<pkg>/client.js,…&rev=…`), and nothing else under the package is reachable — on a
  deployment the app's own `/favicon.svg` answers 200 while every `/plugins/…` path answers 404.
  What dsh does expose is the manifest `icon` field: a path relative to the package, SVG/PNG/JPEG/
  WebP up to 256KiB, read by the host without activating the plugin and handed to the web UI as a
  `data:` URI. A file the page itself needs therefore has to travel inside the browser half.
- **Synthetic keyboard events have no default behaviour.** A plugin that wants an editor command
  has to drive it: the composer is Lexical, and its `insertLineBreak` runs from `beforeinput` — a
  dispatched `Shift+Enter` inserts nothing, however it is routed.

- A patch **replaces the row's whole `config`** — restate every key that should survive.
- Patch YAML takes `#` comments only; `//` fails validation and the install rolls back.
- `link:` dogfoods from source; `file:` copies.
- An image's plugin set is the `dsh plugin add` line its Dockerfile bakes with: registry versions in
  `Dockerfile`, `link:` copies from `packages/` in `Dockerfile.dev`. `pnpm run version` writes the
  `Dockerfile` versions from the manifests, and the second custom manager in `renovate.json` still
  tracks those lines, for a version published outside this flow.
- No `dependencies`. `@deepseek-ai/dsh-*` appear as `peerDependencies`, which says which dsh line a
  plugin is built against without pinning one into the profile: `dsh plugin --profile web add` on a
  peers-only manifest installs the plugin alone (`Packages: +1`) and only warns that the peers are
  unmet, so nothing of dsh's lands in the profile. A `devDependency` pin instead fights the version
  the container actually runs.
- **The `@deepseek-ai/*` peer ranges carry one clause per dsh line, and a new line needs its own.** npm
  lets a prerelease satisfy a range only when a comparator has a prerelease on the same
  `major.minor.patch`, so no static range covers a line whose patch position is still open:
  `>=0.2.0-rc.1 <0.3.0` accepts `0.2.0-rc.2` but not `0.2.1-alpha.4`, `0.2.x-0` accepts neither, and `*`
  accepts nothing in default mode. When dsh publishes a new line, add its clause (`^0.2.2-rc.0` and so
  on) to both `packages/mobile` and `packages/privileged-ui`, and check it with dsh's own semver: the
  version the images pin must satisfy the range, or the deployment cannot install its own plugins.
- New workspace package → `pnpm install --force`, and drop `node_modules/.pnpm/lock.yaml` plus
  `.pnpm-workspace-state-v1.json` if the importer is skipped.

## Scripts under `tools/`

- **`tools/` itself holds what ships or what CI runs**: the release and check scripts
  (`sync-image-pins.mts`, `check-image-changesets.mts`, `check-peer-ranges.mts`), the shared
  `image-pins.mts` and `types.d.ts`, and
  `sync-companions.mts` — the one script `entrypoint.sh` runs at boot, which the `Dockerfile`
  copies by name so that everything else here stays out of the image.
- **`tools/dev/` is for local development only** — `deploy-dev.ts`, `ui-probe.mts` — nothing in
  there runs in CI or ships. A directory of its own, rather than a per-file convention, because the
  rule is who runs it, and that is a property of the whole set.

## Docs site

- `pnpm docs:dev` / `pnpm docs:build` render `README.md` and each package's `CHANGELOG.md` as a
  small site (`docs/`, `index.html`, `vite.config.ts`). It has no content of its own: the Markdown
  files are the source, and `dist/` is build output and gitignored. `@vitejs/plugin-react` is used
  rather than the SWC one because `@swc/core` needs a build script, which `allowBuilds` refuses.

## Releasing and CI

- **Every action is pinned to a full commit SHA with its release tag in a trailing comment**
  (`uses: actions/checkout@<sha> # v7.0.1`): a tag can be moved, a SHA cannot.
- A change to a package under `packages/` needs a changeset (`.changeset/`). The `Release` workflow
  folds those into one version PR and publishes it with `pnpm release` — `changeset publish`, which
  runs each package's `prepack`, so the tarball it uploads always carries a fresh `lib/`.
- **pnpm is pinned once, in `packageManager`**, which `pnpm/action-setup` reads — no `version:` in a
  workflow. The `Dockerfile`'s `npm install -g pnpm@…` carries the same number and Renovate keeps
  both current, so bump them together. It also gives `pnpm-lock.yaml` a second document (the `pnpm`
  package and its `@pnpm/exe` set): that is pnpm 12 recording the managed version, not damage.
- `autofix.yml` fixes formatting and autofixable lint on pull requests, and has to keep the name
  `autofix.ci`; `pkg-pr-new.yml` runs `pkg-pr-new` through `pnpm dlx`, against that project's advice
  to use the lockfile in CI, to keep a preview-only tool out of the workspace dependencies.
- **Only `ci.yml` pins Node lines**: a matrix of 24 (what the images run) and 26 (the oldest line
  `engines` allows). Every other workflow runs `lts/*`, because none of them decides what ships.
- **The `Dockerfile` pins ride changesets' version lifecycle**: `pnpm run version` runs
  `tools/sync-image-pins.mts`, so the version pull request bumps the `dsh plugin …` lines with the
  manifests — never by hand. It has to be `pnpm run version`: bare `pnpm version` is pnpm's own bump
  and dies asking for a version argument. The script only moves the version and keeps each line's
  shape, because `renovate.json`'s second custom manager still reads those lines.
- **The image has a version of its own, in `image/`**: a private package that carries nothing else, so
  changesets bumps it and never publishes it (`privatePackages.version`; npm never sees it). A release
  that changes what the image bakes has to bump it in **one** of its changesets — changesets applies
  the whole set at once, so one bump covers the release; `tools/check-image-changesets.mts` (run by
  `ci.yml`) enforces the same rule on the only set it can see, one pull request, which is stricter
  than the release. That version is the only thing that releases the image, and `release.yml` decides
  by asking the registry: one step reads `image/package.json` and looks the tag up through Docker
  Hub's tag API — 200 published, 404 not, anything else fails the step — once the changesets action
  reports `has-changesets == 'false'`. A diff against `github.event.before` cannot answer that: the
  same commit may be re-run, and a failed attempt leaves the version unchanged, which is how `0.0.3`
  was skipped once. A private package publishes nothing, so the action's own `published` flag
  cannot be the image's trigger.
- **The image job publishes `Dockerfile`'s final stage** — not `:base`, which is a stage — to
  `ghcr.io/devockr/idsh` and `docker.io/devockr/idsh` as `:latest`, `:sha-<commit>` and `:<version>`.
  It is a multi-arch manifest list for `linux/amd64` and `linux/arm64`: the base pin is a manifest-list
  digest, which is what lets one `FROM` resolve per platform, and the arm64 half runs under QEMU on an
  amd64 runner — the slow half, which is what the job's `timeout-minutes` is for.
  `node-addon-require-builtin` ships `linux-arm64-gnu` prebuilds, so dsh installs there.
- **The release build installs from the official registry**, not the mirror the Dockerfiles default to
  for local builds: `release.yml` passes `NPM_REGISTRY=https://registry.npmjs.org/` as a build
  argument. A mirror is for a slow network, not for the thing that publishes.
- **The `unknown/unknown` rows on the package page are the attestations**, not a broken build:
  `buildx` writes provenance and the SBOM into the same manifest list as entries that carry no real
  platform. `release.yml` keeps both on (`provenance: true`, `sbom: true`) — they record which
  commit and workflow produced a digest, though nothing here signs them. Do not turn them off to tidy
  the page.
- **The Hub page is maintained by hand, on purpose.** Docker Hub's Overview changes only through its
  REST API, and that API grants repository metadata writes to tokens carrying Read, Write _and_
  Delete — measured: Read and Write alone answer 403 `insufficient scope`, and "Allow Cloud
  Sandboxes access" makes no difference. Those permissions are account-wide and a token that can
  delete repositories has no business in CI, so nothing here automates the page: it is a short,
  Hub-specific text pasted into the settings page, not `README.md`. The OCI labels keep the sidebar
  correct without any credential.
- **Docker Hub needs `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`** (an access token, not the account
  password); both registry logins run before the build, so a missing one fails the job rather than
  leaving one registry a release behind the other. A change that moves neither a package nor the image
  — a Renovate pin bump, an `entrypoint.sh` fix with no changeset — reaches the published image with
  the next release.

## Pull requests

- Target `main`; a stacked PR uses the branch below as its base, and GitHub retargets it on merge.
- Fetch before pushing; never force-push a branch you did not author.
