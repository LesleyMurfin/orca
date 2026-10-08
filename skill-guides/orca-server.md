---
name: orca-server
description: >-
  Install, configure, run, supervise, and troubleshoot a headless Orca runtime started with
  `orca serve`: choosing a host mode, first-run setup and verification, the systemd unit that
  keeps it up, pairing clients to it, agent accounts and skills on the server, terminals that
  must outlive a service restart, and where to send someone for docs or community help. Use
  when the user says "$orca-server", "orca serve", "orca-ide serve", "headless Orca", "remote
  Orca server", "how do I set up an Orca server", "install Orca on my server", "Orca server
  won't start", "pairing URL", "orca-serve.service", or "restart the Orca server". Use
  `orca-cli` for ordinary worktree, terminal, and browser work once a runtime is already
  reachable.
---

# Orca Server

`ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.

This guide covers the host side: the process that owns the runtime. Everything a client does
against that runtime once it is reachable belongs to `orca-cli`.

You are often the first thing a new operator talks to.

### 1. Discover the user's environment first
Orca can be deployed and supervised in several different ways. Before executing installation or configuration commands, ask the operator how they want their environment set up:
1. **Host mode**: Will this server run the **headless daemon (`orca serve`)** or share an active **desktop app session**?
2. **Supervision strategy**: Should it run as an unprivileged **user systemd service** (recommended for lingering/restart survival), inside a **container/Docker**, or as an ad-hoc foreground process?
3. **Network & access**: Will clients connect via a **private LAN**, a mesh network like **Tailscale**, or an **SSH tunnel**? (Helps pick the right `--pairing-address`).
4. **Agent tools & accounts**: Which AI agents (Claude, Codex, Cursor) need CLI credentials on this server?

Answer the questions they ask, run the checks that settle their configuration, and name the one next step — do not hand back an uncontextualized reading list. When a claim comes from a command, show the command. When it comes from the product docs, link the page (https://www.onorca.dev/docs/remote-servers). When you do not know, say so and point at `## Where to send someone for help` rather than guessing.

Two documents ship beside this guide. At a gate below, run
`ORCA skills get orca-server --reference references/<file>.md` and read only that document;
`--references` lists the names. If the CLI rejects `--reference`, run
`ORCA skills get orca-server --full` once and read only the named section. If `--full` is
rejected too, the CLI predates bundled references: use `ORCA <command> --help`, keep the rules
here, and do not guess.

| Gate                                                                         | Reference                          |
| ---------------------------------------------------------------------------- | ---------------------------------- |
| Writing, hardening, or diagnosing the systemd unit that supervises the server | `references/systemd-supervision.md` |
| Terminals dying on restart, or a long job that must survive one               | `references/daemon-scope.md`        |

## Install Orca on the host

Before any of the host modes below, the server computer needs Orca itself. Install it from
https://www.onorca.dev/docs/install — packages and direct downloads for macOS, Windows, and
Linux live there, and https://www.onorca.dev/docs/install#linux covers the Linux build.

Three things to confirm on a fresh host before spending time on configuration:

- **The executable.** On Linux it is `orca-ide`; `/usr/bin/orca` is the GNOME Orca screen
  reader. Confirm with `command -v orca-ide`.
- **The version.** `ORCA --version` on the host and on the client. Mismatched protocol
  versions are the usual cause of a client that pairs and then reports an incompatible server.
- **The user.** Install and authenticate as the account that will own the runtime, not as
  `root`. Agents inherit that account's `PATH`, home directory, and credentials.

The client computer needs the same install; a Remote Orca Server is Orca talking to Orca.

## Pick the host mode first

- **Desktop app sharing.** The server computer runs the Orca desktop app and advertises itself from
  **Settings → Remote Orca Servers**. Use it when a human can stay signed in on that machine.
- **`serve`.** A headless runtime with no desktop window, for a Linux box, VM, or container.

Run exactly one of them per machine. They cannot both own the profile: the second start refuses
and exits (`3` from the desktop path, `78` from orcad) rather than sharing the user data. Decide
which one owns the host and stop the other.

## Start the server

```text
ORCA serve --pairing-address <reachable-host-or-ip>
ORCA serve --port 6768 --pairing-address 100.64.1.20
ORCA serve --pairing-address 100.64.1.20 --mobile-pairing
```

- `serve` runs in the foreground until `Ctrl-C` and prints the bound endpoint, the advertised
  endpoint, and the pairing status.
- `--pairing-address` changes only the address advertised to clients. Never advertise
  `127.0.0.1` or a wildcard to another machine; use the LAN, Tailscale, SSH-forward, or
  reverse-proxy endpoint the client can actually dial.
- `--port` pins the port when a firewall, tunnel, or unit file needs a fixed one.
- `--mobile-pairing` prints a mobile-scoped QR/link instead of the default runtime pairing link.
- `--no-pairing` starts the runtime without printing a link.
- `--project-root <path>` with `--recipe-json` prints the recipe result JSON and leaves the
  server running; that pair is for per-workspace environment recipes, not for a long-lived host.

`serve` uses Orca's own Node server (orcad) when it can and falls back to the desktop app's
server with one printed line saying why. Set `ORCA_SERVE_RUNTIME=electron` to always use the
desktop app's server.

On Linux the executable is `orca-ide`; `/usr/bin/orca` is the GNOME Orca screen reader. Write an
absolute path in unit files and cron entries, but resolve it first — it depends on how Orca was
installed: the deb/rpm post-install symlinks `/usr/bin/orca-ide`, while an AppImage registers
`~/.local/bin/orca-ide` pointing into `${XDG_CACHE_HOME:-~/.cache}/orca/appimage/launcher/orca-ide`.
Run `readlink -f "$(command -v orca-ide)"` as the service user and put that path in `ExecStart=`;
never a bare `orca`, which a `PATH` change could redirect.

`serve` always binds every interface (`0.0.0.0`); `--pairing-address` changes only what is
advertised and `--port` only which port is opened. There is no flag to bind a single interface, so
the host firewall or overlay network is the only control: allow the port from the
Tailscale/WireGuard/LAN range (or expose nothing publicly and reach it over `ssh -L`), and verify
with `ss -ltnp 'sport = :6768'` before pairing anyone.

### Verify the first run before pairing anyone

Do this in order; each step rules out the failure the next one would be blamed for.

1. **The runtime answers locally.** `ORCA status --json` on the host.
2. **The advertised endpoint is the one a client can dial.** Read it from the startup output,
   not from the bind line, and check it is not `127.0.0.1` or a wildcard.
3. **The port is reachable from the client.** From the client machine, not the host.
4. **The host is named.** `ORCA host name --name build-server --json` so paired clients show
   something recognizable.
5. **Agent CLIs and accounts exist on the host.** `ORCA account list --json`.

Only then hand over the pairing URL. A link pasted before step 3 produces a client that pairs
and immediately times out, which reads like a product bug and is not one.

## Run it under systemd

Give the runtime its own unprivileged user that owns the repos, agent CLIs, and provider
credentials. Agents on the server run as that user.

```ini
# /etc/systemd/system/orca-serve.service
[Unit]
Description=Orca remote server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=orca
Group=orca
WorkingDirectory=/home/orca
Environment=HOME=/home/orca
Environment=XDG_RUNTIME_DIR=/run/user/1001
ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address 100.64.1.20
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3 78
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

Why those settings:

- `Type=simple` — `serve` stays in the foreground and never forks or writes a PID file, so the
  started process is the main process. systemd marks the unit active as soon as it spawns; the
  bound endpoint and pairing URL arrive later, in the journal.
- `KillMode=mixed` — `SIGTERM` goes to the main process only. That matters because `serve`'s
  graceful stop deliberately does **not** take the terminal daemon down with it: the daemon keeps
  the PTYs so a restarted runtime can adopt them. `control-group` would signal the daemon and every
  agent in the unit's cgroup at once and lose that work; with `mixed`, anything still in the cgroup
  when the main process exits is swept, which is why the daemon must live in its own scope (see
  `references/daemon-scope.md`).
- `RestartPreventExitStatus=3 78` — two statuses a restart cannot repair. `78` is orcad's
  configuration-fault status (`ORCAD_EXIT_CONFIGURATION`): a data root held by another orcad, a
  malformed `--bind` address, an unusable bundled runtime, or an unreadable profile store. `3`
  means another process already owns this userData profile — the desktop app, or a `serve` that is
  still running; the host prints `[single-instance] Another Orca instance is already running for
  this userData profile`. A port already in use is **neither**: the listener fails with a plain
  error and exits `1`, which `Restart=on-failure` retries every `RestartSec` forever, so fix
  `--port` rather than the unit when the journal shows `EADDRINUSE`.

Load `references/systemd-supervision.md` before writing or repairing the unit: it carries the
full template, the start-limit backstop, the Xvfb package headless browser panes need, and how
to read a failed start.

Replace `1001` with `id -u orca`. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-serve.service
journalctl -u orca-serve.service -f
```

The pairing URL is printed once at startup; re-read it from the journal rather than restarting
the service to see it again.

## Preserving live terminals across service restarts

`systemctl restart orca-serve.service` kills whatever is still in the service cgroup. On Linux,
Orca already keeps its PTY daemon out of that cgroup: it launches the daemon through
`systemd-run --user --scope` as `orca-daemon-<nonce>.scope`, a sibling of the service that no
unit-scoped kill reaches. The fallback, a direct fork inside the service cgroup, is what loses
every terminal on restart.

That path needs a reachable user systemd manager, which a service account only gets once you
ask for one:

```bash
sudo loginctl enable-linger orca
loginctl show-user orca -p Linger
```

Lingering starts the `orca` user's manager at boot and provisions `/run/user/<uid>`. Without it
the probe fails closed — the user manager would not outlive the caller — and Orca forks the daemon
directly; the journal says `daemon-scope-unavailable: linger off`.

Work you start yourself is already protected when the daemon is in its own scope: the daemon owns
the PTY, survives the restart, and the new runtime adopts it, so the pane comes back. Wrap work in
its own unit only when it must also survive the daemon itself being replaced — an Orca update, or
a host where the scope probe fails closed:

```bash
# A transient service, not a scope: nothing depends on the invoking shell surviving.
systemd-run --user --unit=orca-build-1 --collect --same-dir --property=TimeoutStopSec=5s -- pnpm build
journalctl --user -u orca-build-1 -f
```

To reattach a shell rather than read logs, give tmux its own server so the request cannot be
answered by a tmux server already running in another cgroup:

```bash
systemd-run --user --scope --unit=orca-build-1 -- tmux -L orca-build-1 new-session -d -s build 'pnpm build'
tmux -L orca-build-1 attach -t build
```

Load `references/daemon-scope.md` when terminals die on restart, before an update with live
PTYs, or to verify the daemon actually landed in its own scope.

## Credentials, accounts, and skills on the server

Agent sessions use the **server's** `PATH`, home directory, and credentials. A login on the
client laptop carries nothing over. Install and authenticate Codex, Claude Code, OpenCode,
`git`, and any provider CLIs on the server as the service user.

A headless runtime disables the desktop **Add account** button, so register managed accounts
from the server shell:

```text
ORCA account add --agent claude
ORCA account add --agent codex
ORCA account list --json
```

`account add` runs the agent's own login in that terminal and registers the result with the
local runtime; Codex uses device authorization so the browser can finish on another machine.
`account list` rejects `--environment` and `--pairing-code` — run it on the host whose accounts
you want.

Install or refresh skills without a Settings UI:

```text
ORCA skills install --skill orca-server --skill orca-cli
ORCA skills update --all
```

`skills install` resolves to the same `npx skills add` command Settings shows, with the
non-interactive flags a headless host needs. It installs globally unless you pass `--local`, and
targets the agents Orca detects on the host; pass `--agent <name>[,<name>]` (or
`--agent universal`) when detection finds none. `--dry-run` prints the resolved command.

## Name the host and confirm what is reachable

```text
ORCA host name --name build-server --json
ORCA host list --json
ORCA status --json
```

`host name` sets the name clients see for this runtime. `host list` separates the three kinds of
target this machine knows: itself, SSH targets registered on it (`--host ssh:<id>`), and Orca
servers paired with it (`--environment <name>`). Passing one selector where the other belongs is
the usual cause of an empty answer.

## Access and revocation

Each paired client holds its own revocable grant, listed under **Shared Server Access** on the
server. Revoking one disconnects it immediately; generating a new link only replaces the
previous **unused** link.

Treat a pairing URL like a password. Keep the port on a private path — Tailscale, WireGuard, a
trusted LAN, SSH forwarding, or an authenticated tunnel — and never forward it straight to the
public internet.

## Troubleshoot

- **Unit flaps between `activating` and `failed`.** Read `journalctl -u orca-serve.service -n 50`
  and `systemctl show -p ExecMainStatus orca-serve.service` before touching the unit. Status
  `78` is a configuration fault — data root, bind address, or profile store — and restarting
  cannot fix it; that is what `RestartPreventExitStatus` is there to stop.
- **Clients cannot reach the advertised endpoint.** The bound endpoint and the advertised
  endpoint are different lines in the startup output. Fix `--pairing-address`, not the port, when
  the bind succeeded but clients time out.
- **`serve` refuses to start because a runtime is already up.** Another `serve` process or the
  desktop app owns this host. Stop one of them; do not run two.
- **Agent CLI not found on the server.** Install and authenticate it as the service user, then
  confirm with `ORCA account list --json`.
- **Terminals vanished after a restart.** The daemon fell back to a direct fork inside the
  service cgroup. Check lingering and `XDG_RUNTIME_DIR`, then `references/daemon-scope.md`.
- **A command reports that Orca is not running.** On a server host, check the unit rather than
  starting a second runtime by hand.

## Where to send someone for help

Give the page or channel, not a general invitation to search:

- **Remote server setup, pairing, host modes** —
  https://www.onorca.dev/docs/remote-servers
- **Installing Orca, including the Linux `orca-ide` name** —
  https://www.onorca.dev/docs/install
- **App-wide symptoms and log locations** — https://www.onorca.dev/docs/troubleshooting
- **Choosing between a server, SSH worktrees, and local** —
  https://www.onorca.dev/docs/ways-to-run
- **Real-time community help** — Discord, https://discord.gg/fzjDKHxv8Q
- **Bugs and feature requests** — https://github.com/stablyai/orca/issues
- **In-app** — **Help → Send Feedback**, which carries build context; attach logs when the
  problem is hard to reproduce.

Before sending someone to a channel, collect what they will be asked for anyway: host mode,
server OS, Orca version on both ends, the last 50 journal lines, and what the client reports.
Redact the pairing URL and any access link first — they are credentials.
