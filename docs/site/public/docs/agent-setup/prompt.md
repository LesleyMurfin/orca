# Orca agent setup prompt

You are an AI coding agent setting up [Orca](https://www.onorca.dev/docs) for a human user. Follow this
file top to bottom. Run one step at a time, show the user what you ran, and stop and ask before
anything destructive (replacing an existing install, editing system units, opening ports).

Everything here is derived from the Orca documentation. When this file and
<https://www.onorca.dev/docs> disagree, the docs win.

## 0. Decide what to install

| The user wants                                              | Install                               | Go to                                       |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| Orca on the machine they are sitting at                     | Orca Desktop                          | [Step 2](#2-install-orca-desktop)           |
| A machine that keeps agents running while the laptop sleeps | Orca Desktop on that machine, paired  | [Step 5](#5-pair-a-remote-orca-server)      |
| A headless Linux box, VM, or container as the runtime       | Orca Server (`orca serve` / `orcad`)  | [Step 6](#6-headless-orca-server)           |

Orca Desktop is the only install path — the server mode is the same binary started without a
window. There is no separate server download. Compare all run modes at
<https://www.onorca.dev/docs/ways-to-run>.

## 1. Identify OS and architecture

```bash
# macOS / Linux
uname -s -m
# Windows (PowerShell)
$env:PROCESSOR_ARCHITECTURE; [System.Environment]::OSVersion
```

Map the result:

- `Darwin arm64` → macOS Apple Silicon
- `Darwin x86_64` → macOS Intel
- `Linux x86_64` → Linux x64
- `Linux aarch64` → Linux arm64
- `AMD64` on Windows → Windows x64

If the host is a headless Linux server (no `$DISPLAY`, no desktop session), you still install the
same package — skip the GUI steps and jump to [Step 6](#6-headless-orca-server).

## 2. Install Orca Desktop

### macOS

```bash
brew install --cask stablyai/orca/orca
```

`brew upgrade --cask orca` tracks the stable channel. Without Homebrew, download the DMG:

- Apple Silicon: <https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg>
- Intel: <https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg>

Orca is signed and notarized; macOS may still ask for confirmation on first launch.

### Windows

Download and run the installer:
<https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe>

### Linux

Three packages ship per release and contain the same app. Pick on how updates should reach the
user — **ask them, do not guess**:

| Package      | Pick it when                                      | Updates                                      |
| ------------ | ------------------------------------------------- | -------------------------------------------- |
| **AppImage** | They want Orca to update itself                   | Orca replaces the AppImage in place          |
| **`.deb`**   | They manage software with `apt` (Debian/Ubuntu)   | Orca downloads it and hands over the command  |
| **`.rpm`**   | They manage software with `dnf`, `yum`, `zypper`  | Same as `.deb`                               |

AppImage has a stable per-architecture URL and needs `chmod +x`, because GitHub release assets
carry no permission bits:

```bash
# x64
curl -fL -o ~/Applications/orca-linux.AppImage \
  https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage
# arm64
curl -fL -o ~/Applications/orca-linux-arm64.AppImage \
  https://github.com/stablyai/orca/releases/latest/download/orca-linux-arm64.AppImage
chmod +x ~/Applications/orca-linux*.AppImage
```

`.deb` and `.rpm` filenames carry the version and architecture, and the two formats spell the
architecture differently (`orca-ide_<version>_amd64.deb`, `orca-ide-<version>.x86_64.rpm`), so take
the exact asset from <https://github.com/stablyai/orca/releases> rather than a fixed URL.

<a id="linux-cli-name"></a>

> **The Linux command is `orca-ide`, not `orca`.** GNOME Orca's screen reader already owns
> `/usr/bin/orca`. Read every `orca …` command below as `orca-ide …` on Linux, and write the
> absolute `/usr/bin/orca-ide` path into any service unit.

Installing a `.deb`/`.rpm` update replaces the files of a running application — quit Orca first,
then reopen it. Orca never escalates privileges to do this for you.

## 3. Verify the install

```bash
orca status          # orca-ide status on Linux
orca --version
```

If the shell reports "command not found" on macOS or Windows, the CLI has not been registered yet:
open the app and enable it under **Settings → General → Orca CLI**. On macOS that installs a shim
into `~/.local/bin`, which must be on `PATH`.

Report the version back to the user. A client and a server on different protocol versions refuse
to pair, so both machines must be on the same release.

## 4. Configure agents, credentials, and skills

Agent CLIs (Codex, Claude Code, OpenCode), `git`, and any provider CLIs must be installed and
authenticated **on the machine that runs the work** — a login on the user's laptop does not carry
over to a server.

```bash
orca account add --agent claude
orca account add --agent codex
orca account list
```

Install the agent-facing skills so any agent on this machine can drive Orca:

```bash
orca skills install --skill orca-cli --skill orca-server --skill orchestration
orca skills update --all
orca skills list
```

Skill install scope and agent targeting: <https://www.onorca.dev/docs/cli/skills>.

On first launch Orca asks for home-directory access so it can add repos, and offers to import
`~/.claude`, `~/.codex`, and Ghostty settings when present. Let the user answer those prompts.

## 5. Pair a remote Orca Server

For a machine someone can stay signed in on, run the desktop app on both ends and pair them over a
private network path — [Tailscale](https://tailscale.com/) is the shortest route.

On the **server**: **Settings → Remote Orca Servers → Advertise this app as a server → New Link**,
choose the Tailscale address (usually `100.x.y.z`), **Generate Access Link**, copy it.

On the **client**: **Settings → Remote Orca Servers → Add Server**, paste the link, **Add Server**,
then **Connect** if the row reads Disconnected.

The pairing URL grants access to the runtime. Treat it like a password: never paste it into a
public channel, a commit, or an issue, and revoke it under **Shared Server Access** if it leaks.
Never expose the Orca port directly to the public internet, and never advertise `127.0.0.1` to
another computer.

Full guide: <https://www.onorca.dev/docs/remote-servers>.

## 6. Headless Orca Server

On a headless Linux box, VM, or container, start the runtime without a window:

```bash
orca-ide serve --pairing-address <reachable-tailscale-ip-or-hostname>
orca-ide serve --port 6768 --pairing-address 100.64.1.20   # fixed port behind a firewall/tunnel
orca-ide serve --pairing-address 100.64.1.20 --mobile-pairing  # QR code for Orca Mobile
```

It runs in the foreground until `Ctrl-C`, prints the bound endpoint and a pairing URL, and uses
`--pairing-address` only for the address clients should dial. Run **one** host mode per machine —
never `orca serve` alongside a desktop app that is already sharing the same computer.

To let systemd own it, follow the unit in
<https://www.onorca.dev/docs/remote-servers#running-as-a-systemd-service> rather than writing one from
scratch. Three settings carry the weight and must not be "simplified": `Type=simple`,
`KillMode=mixed`, and `RestartPreventExitStatus=3 78` (78 is a configuration fault that restarting
never repairs). Run it as an unprivileged user that owns the repos and credentials, and enable
lingering so terminals survive a service restart:

```bash
sudo loginctl enable-linger orca
sudo systemctl daemon-reload
sudo systemctl enable --now orca-serve.service
journalctl -u orca-serve.service -f
```

The pairing URL is printed once at startup — read it back from the journal instead of restarting
the service.

## 7. Health check

Work through these and report each result:

1. `orca status` returns without error on every machine involved.
2. Versions match on client and server.
3. The server row in **Settings → Remote Orca Servers** reads **Connected**.
4. `orca account list` shows the expected agent accounts on the machine that runs the work.
5. A worktree creates and a terminal opens in it (`orca worktree create`, then open a terminal).
6. For SSH hosts: `git` exists on the remote, and on Linux a C/C++ toolchain (make, g++/clang++,
   python3) so terminal natives can build.

## 8. When something fails

Collect this before escalating — it usually resolves in one round trip:

- host mode (desktop app or `orca serve`) and the server's OS;
- the Orca version on **both** machines;
- startup output, or `journalctl -u orca-serve.service -n 50`;
- what the client shows: Disconnected, a timeout, or a protocol-version error;
- logs from **Help → Open Logs** — `~/Library/Application Support/Orca/logs/` (macOS),
  `~/.config/Orca/logs/` (Linux), `%APPDATA%\Orca\logs\` (Windows); a headless host writes to
  `<data-root>/logs/`.

Redact pairing URLs, access links, and tokens from anything you paste or attach.

Then:

- **Troubleshooting & FAQ** — <https://www.onorca.dev/docs/troubleshooting>
- **Remote server troubleshooting** — <https://www.onorca.dev/docs/remote-servers#troubleshooting>
- **GitHub errors (PR panel, checks, rate limits)** — <https://www.onorca.dev/docs/github-errors>
- **Discord** — <https://discord.gg/fzjDKHxv8Q>
- **GitHub Discussions** — <https://github.com/stablyai/orca/discussions>
- **GitHub Issues** — <https://github.com/stablyai/orca/issues>
- **Help → Send Feedback** in the app, which attaches context from the running build.

For deep diagnostics — wedged UI, terminals that never spawn, an SSH worktree that will not
connect — load the diagnostics runbook as a skill and follow it:

```bash
orca skills install --skill orca-diagnostics
```

## Docs index

- Install — <https://www.onorca.dev/docs/install>
- Ways to run Orca — <https://www.onorca.dev/docs/ways-to-run>
- Your first 3-agent session — <https://www.onorca.dev/docs/first-session>
- Remote Orca Servers — <https://www.onorca.dev/docs/remote-servers>
- SSH worktrees — <https://www.onorca.dev/docs/ssh>
- Orca CLI reference — <https://www.onorca.dev/docs/cli/reference>
- Skills registry — <https://www.onorca.dev/docs/cli/skills>
- Settings — <https://www.onorca.dev/docs/settings>
- Troubleshooting & FAQ — <https://www.onorca.dev/docs/troubleshooting>
