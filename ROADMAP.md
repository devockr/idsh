# ROADMAP

This is the plan for letting the agent reach the machine it runs on — to diagnose the host, the
LAN and the router, and to deploy — without the credentials that make that reach possible ever
living inside the container.

Nothing here is implemented yet: the tree is at the last green baseline, and this file is the
contract the implementation will be judged against.

## The problem

`dsh` runs the agent in a container. Some work still needs the host: a disk that filled up, a
package that stopped, a container that will not start, a LAN address that does not answer, a
router that needs looking at. Today that is done with SSH keys kept in the state directory,
which is bind-mounted into the container.

That is worse than it looks:

- **The keys are not temporary.** They are persistent files, readable by the agent, and one of
  them may open more than one machine. Rotating does not help while the file sits in a mount.
- **A shell as the deployment's user is root by another name.** On a host where that user can
  reach the Docker daemon, anything the agent can do over SSH it could do with `docker`.
- **Approval is not a boundary.** With the approval policy set to `never` nothing is asked at
  all, and a container cannot keep a secret from the process it runs.

So the change is not how SSH is invoked. It is **where the credentials live** and **what shape
the operations take**.

## Goals

- The agent can answer "what is wrong with this host / LAN / router" and can deploy, from a
  phone as readily as from a desk.
- No **host** credential — key, token or password — is readable inside the container. The agent
  can _request_ an operation; it cannot _hold_ the means to perform it. The model's own
  credentials stay in the state directory, which is mounted, and that is a separate problem
  (see _what this does not solve_).
- Every operation is enumerated and typed. There is no shell.
- Reads are open; writes are closed by default and visible when opened.
- Every call is audited, rate-limited and can be switched off.
- A deployment that fails to start does not need a computer to recover.

**Not goals:** a root shell for the agent; approval prompts as the security boundary; merging
host diagnostics into the credential broker.

## Architecture

```
agent
  │  host(op, args)                     ← the model only sees the shape of the op table
  ▼
@idsh/host-ops (plugin, in the container)
  │  one JSON object per line
  ▼
<socket directory>/host.sock          (0660)
  │
  ▼
host broker (on the host, as the deployment's user)
  ├─ execFile(fixed argv) — rebuilt from parsed values, never forwarded
  ├─ ssh <router> <fixed op>            ← the hop is the broker's, not the container's
  └─ audit / timeout / output cap / kill the process group
```

- The broker is a **host process**, started by the host's scheduler and kept alive by it. It
  must not live in a container: it exists to use the host's binaries and the host user's
  identity, and a container would have to mount both — a larger exposure, not a smaller one.
- The socket is the only thing the container reaches. It lives in a directory of its own — not the
  state directory, which the container can write — and that directory is bound in **read-only**.
  The directory rather than the file, because the socket only appears after the container starts;
  read-only, so the container can connect but cannot unlink the socket and bind its own in its
  place. If a kernel will not connect through a read-only mount, the host's scheduler hands the
  broker a pre-opened socket instead (socket activation), which has the same property. A socket
  that is replaced anyway costs a denial of service or a mocked answer to the plugin, not a
  privilege: the replacement and the caller share the container's uid.
- **Who may call it.** The socket is owned by the deployment's user and group, mode `0660`, and
  its directory is owner-only. The broker can authenticate the peer by uid and by nothing finer:
  every process the container runs shares that uid, so the plugin cannot be told apart from
  anything else inside it. The broker therefore trusts nothing the plugin says — it validates,
  authorizes, rate-limits and audits every request on its own, recording the peer uid and the
  session the plugin names. The socket is a capability limiter, not an authenticator; the uid
  boundary is what keeps every other host user out.
- **Credentials, configuration, audit log and build clones live outside every mount.** A
  directory beside the deployment, owned by its user, is enough: the container cannot read it,
  and rebuilding the container cannot lose it.
- The wire protocol is line-delimited JSON with a bounded line, the same shape the host-side
  credential broker already uses: one request in, one answer out, nothing pipelined.

**Why not MCP.** `dsh-mcp-client` can speak Streamable HTTP, but the token would have to live
in the container (which is the thing being removed) or a bridging process would have to sit in
front of the socket. The plugin is in this repository already, and it can ask the broker for its
op list at load time, so the tool schema carries the real enumeration instead of a model
guessing at strings.

**Why not SSH with a forced command for the host.** A forced command needs a dispatcher, and a
dispatcher is a shell script doing what the broker would do — with SSH's own surface (pty,
forwarding, interactive auth) still in front of it. It is the right tool for the router
(below), where the alternative is a shell on the LAN's root of trust; it is the wrong tool for
the host, where the socket is a file permission instead of a network service.

## Host operations

### The finite part is the sources, not the commands

"One op per command" is the wrong shape: commands are unbounded, so the table could never be
finished. What is finite is the set of **data sources** — a property of the machine, not of the
question. The API is `source.query(...)`, not `command(args)`.

| source    | what it reads                                     | where the freedom is          |
| --------- | ------------------------------------------------- | ----------------------------- |
| `log`     | the host's logs, the kernel ring buffer, journald | unit, window, pattern, lines  |
| `proc`    | `/proc` and `/sys` state                          | which file                    |
| `service` | the package and service managers                  | name, read-only action        |
| `docker`  | `ps`, `inspect`, `logs`                           | container, tail, since        |
| `net`     | `ip`, `ss`, `ping`, `dig`, `traceroute`           | target, port, count           |
| `disk`    | `df`, scrub status, SMART                         | volume, device                |
| `router`  | the router's read-only operations (see below)     | key name, within an allowlist |

Each source knows which files it reads, how to filter, and how much output it may return. It also
knows what it must not return: `proc` exposes a fixed list of files and never a process's
environment, `docker inspect` is projected onto the fields a diagnosis needs rather than passed
through, and logs go through the same deny list. A cap bounds volume, and an audit entry assigns
blame; neither is a disclosure control.

### The long tail: `run(binary, argv)`

Sources cannot cover everything — a one-off, a tool nobody anticipated. That case goes through
`run`, which is still not a shell: an allowlisted binary and an argv rebuilt from parsed values.

- **No executors:** `sh`, `bash`, a language runtime, `awk`, `find -exec`, `xargs`, `env`,
  `setsid`, `nsenter`, `docker run`/`exec`.
- **No writers:** `rm`, `mv`, `cp`, `dd`, `tee`, `truncate`, `chmod`, `chown`, `mkdir`, `ln`,
  `tar` (`tar cf -` is exfiltration with a friendly name).
- **A race-safe path guard:** every path in the argv is resolved once and consumed through that
  resolved object, so validation and use cannot be separated. A recursive tool may only walk an
  allowed root, never `/` or a home directory, and an allowed root must itself be immutable to
  the container's uid — a root the agent can write is refused rather than guarded, because a
  writable root is one rename away from a protected path.
- Caps, a timeout, process-group kill, audit. `run({argv, dryRun: true})` answers the policy
  verdict without executing, so the agent can plan before it acts.

**Adding a binary is a declaration, not code** — a name, the flags it may take, a validator per
argument class. The table does not have to predict the future; it has to be cheap to extend.

### Three tiers

1. **Sources** — unattended, the fast path.
2. **`run`** — most of the long tail, still typed, still audited.
3. **A person** — a new binary, or a write. The agent asks; nothing pretends this is automatic.

A time-boxed shell lease is deliberately not part of this. Once it exists, the first two tiers
stop mattering.

### Why not a shell

Not fastidiousness: on a host whose user reaches the Docker daemon, an arbitrary shell is root.
A real sandbox would need a different uid, a read-only view of the host and a user namespace;
on the kernels these NAS-style deployments run, that is a project of its own. So "let the agent
run anything" has no safe version, and the tiers are the honest decomposition of it.

## Deploying through the same channel

Removing the container's SSH keys removes the only way a phone can ask for a deployment. The
channel has to carry deployment before the keys can go.

| op                    | source                                           | purpose                       |
| --------------------- | ------------------------------------------------ | ----------------------------- |
| `deploy.build({pr})`  | the PR head, on the remote, from this repository | verify an unmerged change     |
| `deploy.build({sha})` | any commit on a remote branch                    | verify a pushed branch        |
| `deploy.main()`       | the main branch                                  | ship                          |
| `deploy.recreate()`   | no build; the current image                      | profile-only changes          |
| `deploy.rollback()`   | the previous image                               | a deploy that will not boot   |
| `deploy.status()`     | —                                                | what is running, from a phone |

**Source rule: deploy only code that exists on the remote.** The container can write the
checkout, so a working-tree path would mean deploying whatever the agent has just typed. A
remote commit at least ties every deployment to a commit anyone can read afterwards. A PR head
must be reachable from a branch in the same repository; a fork's head is refused.

**Confirmation happens inside the tool call.** Every deploy resolves its source to a commit SHA
first, asks a question through the user question service — PR number, that SHA, a summary of the
change — and blocks until it is answered. The build and the deploy use only the SHA that was
shown, so a branch that moves while the question is open cannot change what was approved. The
model cannot answer the question, and it cannot deploy and then ask: the deployment is inside the
same call. Approval cannot do this job: under the `never` policy it is rejected before anyone is
asked.

**The files that run as root are pinned to main.** The image starts as root and drops to the
deployment's uid; anything executed before that drop is root, and it can write the mounts. So
the build takes `entrypoint.sh`, the tools it runs, both Dockerfiles and both ignore files from
main, never from the PR — `Dockerfile.dev` is included because one `RUN` in it could rewrite the
tool the entrypoint runs as root. `main` is resolved to a SHA at the same moment as the source,
both SHAs are shown in the confirmation, and the build checks out exactly those two snapshots —
a `main` that advances while the question is open cannot change what was approved. Everything
else comes from the PR, including `packages/`: the dev image copies that directory whole and
links every package that declares itself a plugin, so **a new plugin needs no Dockerfile change
and can be verified before it is merged**. Only a change to those six files must be merged first,
because that is exactly the root surface.

**The build runs in a container, and it is a disposable one.** `pnpm install` and `pnpm build`
execute scripts from `package.json`, and a pull request can change them — so they run in a
container built from the base image this project already has, with a frozen lockfile, not on the
host. That container gets the clone and nothing else: no Docker socket, no broker socket, no SSH
agent, no host credential, no bind mount that outlives it. It keeps the network it needs to reach
the registry, and it is removed when the build ends. Nothing about it grows the deployment image:
it is a different image, and the build context's ignore file already keeps `node_modules` out.
This is not a sandbox for the deployed image — that one runs with the deployment's mounts, as the
next paragraph says.

**The compose file belongs to the host.** It sits outside every mount, carries no `build:`
section, and uses absolute bind sources — relative ones would resolve against the compose file's
own directory. This is also what closes "edit the compose file and wait for the next rebuild".

**A deployment that will not come up rolls itself back.** Before the new image takes its place,
the previous one is recorded by digest, not by tag. After `up -d` the broker keeps the new
container's id, requires the compose health check to pass, and keeps watching for a stabilization
window: the boot line alone proves nothing, because a container can print it and then exit. An
exit, a failed health check, or an id that changed under it all mean rollback to the recorded
digest. The broker is not in the container, so it can watch the container die and bring it back.
The recreate itself is detached and delayed, because it kills the session that asked for it; the
next session asks `deploy.status`.

**One deployment at a time.** The rollback target is shared mutable state, so a single-flight lock
covers the whole transition — build, `up -d`, health wait and any rollback — and a second request
is refused rather than queued. Each deployment records its previous target as an image digest, so
a later deploy cannot retag what an earlier one meant to restore.

**The last resort is the host's own management UI.** If the broker is down and the container will
not start, a pre-written rescue script — retag the previous image, `up -d`, log it — can be run
from the host's task scheduler in a phone browser. The boot task runs the same script, so a
reboot heals the common case. If the host itself is unreachable, no browser helps; that is the
price of no longer holding host credentials.

**What this does not solve.** A malicious image still runs with the deployment's uid and the
deployment's mounts, so it can read the state directory — including the model credentials — and
can write the checkout. The boundary bought here is that it cannot become root and cannot reach
the host's own credentials. A pull request that changes a client plugin also runs that plugin in
the reader's browser, which no deployment rule can prevent.

## The router

The router is a second trust domain: it is the LAN's DNS, DHCP and firewall, and its login is
root. Reads are allowed, writes are not, and nothing about it is reachable from the container
except through the broker's fixed operations.

- The broker holds the router's key; the container never sees it, and the key is not shared with
  any other machine.
- The router's `authorized_keys` carries a forced command: a dispatcher with no arguments of its
  own, one `case` branch per read-only operation, nothing that takes input. The operation name
  arrives as `SSH_ORIGINAL_COMMAND` and is matched against that exact list — the whole string, not
  a prefix, and never handed to a shell; any other word, any argument, any empty command is
  denied. (One key per operation is the alternative; one dispatcher is fewer keys and the same
  allowlist.) The key is stripped of every other channel too — `no-pty`, `no-agent-forwarding`,
  `no-X11-forwarding`, `no-port-forwarding` — because a forced command on its own leaves those
  open. There is no shell to escape into because there is no shell.
- A forced command runs when someone logs in, so no boot hook is needed, and a firmware that
  never executes a user script is not an obstacle.
- The dispatcher's location must be proven persistent, not assumed: put it beside
  `authorized_keys`, which is already known to survive, and re-check after a firmware upgrade.
- If the script is gone, the forced command runs nothing and the operation fails — closed, never
  downgraded to a shell.

## Phases

| phase | work                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | The broker, the socket and the plugin; two or three sources; `run` with its allowlist and path guard; rate limits; audit; deploy. |
| 2     | Move the keys out of the container, split the shared key, rotate, pin the known hosts.                                            |
| 3     | Router operations and the forced command.                                                                                         |
| 4     | Remaining sources, writes, a `doctor` command.                                                                                    |
| 5     | The remaining keys: out of the container, or behind an agent socket that cannot be read but can still sign.                       |

Phase 1 has to land before phase 2: until deployment works without SSH, removing the keys
strands the phone. While phase 1 is in progress the broker still reads the keys from the state
directory, so it is not yet a boundary — that is deliberate, not an oversight.

## Open questions

- Whether the deployment confirmation should also require an action outside the container — a
  label on the pull request, say — for the case where the agent is not merely confused but
  hostile. The question inside the tool call stops accidents; it does not stop a lie.
- How the broker attributes a call to a session. The plugin knows; whether that is worth
  carrying over the socket is not settled.
- How much of the wire protocol, audit format and build recipe to share with the credential
  broker. The mechanism is the same; the process, the socket, the credentials and the
  configuration should stay separate, because one acts as a person's GitHub identity and the
  other as the host's own.
