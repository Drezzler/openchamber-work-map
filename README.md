# Work map

An [OpenChamber](https://openchamber.dev) extension: a live map of your OpenCode sessions, in a panel beside the chat — a port of the [lot-map](https://github.com/alexeyw/lot-map) idea to OpenChamber. Every tool call flies a pulse from the centre to its station, so you see files, shell, network, subagents and skills at work instead of reading a list of calls.

```
            You
     Skills        Model
   Agents    ·    Memory
 Browser          Files
  Network   ·    Shell
```

## What you get

- **Work map panel** (rail) — nine stations around the core: **You · Model · Memory · Files · Shell · Network · Browser · Agents · Skills**.
  - Pulses out when a call starts, back when it ends; red on error.
  - Spokes wear thicker and brighter with use — the map remembers where the work went.
  - Clock hands grow around a station while it works; a ring around the core fills with the session's context (amber at 70 %, red at 90 %).
  - Subagents orbit the Agents station; their calls start from it.
  - A shell that outlives its turn keeps its station lit (`bg ×N`) until it truly ends.
  - A change of model rings the core and lands a `◆ old → new` row.
  - One wide ring leaves the core when the answer is ready.
- **The feed** — the now-line and the last 16 calls: `●` running, `·` done, `✕` failed, `◆` model change. Finished repeats fold into `+n`; a running call is never pushed out; long rows open whole with `▸`.
- **Auto follows focus** — the map watches the chat you have open, switching as you click between sessions. Pin any session from the picker to override; Auto falls back to following the work when no panel is focused.
- **Work Status section** — two app-drawn rows: the watched session and what runs now.

## Install

From a chat in the desktop app:

```markdown
[Install Work map](openchamber://extensions/install?url=https://github.com/Drezzler/openchamber-work-map)
```

or Settings → Extensions → add the repository URL `https://github.com/Drezzler/openchamber-work-map`.

The install asks for two things, once:

- a **local service** (kept running) that reads OpenCode's event stream;
- **read-only OpenCode access** — sessions and messages, tool calls included.

## How it works

```
OpenCode ──(read-only event stream)──► service ──(snapshots)──► panel canvas
                                         │
                                         └──► Work Status (app-drawn rows)
```

The service subscribes to OpenCode's live events, classifies each tool call the way lot-map does — file tools and file-only shell commands (`cat`, `grep`, `mv`, `sed`, `Get-Content`…) light **Files**; `curl`, `gh`, `ssh`, `npm install`, `npx -y`, `kubectl`, MCP tools light **Network**; subagents light **Agents**; memory-ish paths (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/`) light **Memory** — and pushes snapshots to the open panel. Details in [docs/architecture.md](docs/architecture.md).

**Privacy:** labels carry names, never content — a file's last two path parts, a URL's host, a command's name. Nothing leaves the machine. The whole story is in [docs/privacy.md](docs/privacy.md).

## Options

At the bottom of the panel, saved per device:

| Option | Meaning |
|---|---|
| You at top / bottom | Turns the ring half a turn |
| Full / Reduced motion | Nothing flies, breathes or orbits; clock hands stay |
| Accent / Memory colors | Your own `#rrggbb` |

The context ring's window size is estimated per model family (Gemini 1 M, GPT-5 400 K, GLM/Claude 200 K) — treat the percentage as a close estimate.

## Develop

```sh
bun install
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check      # what the host would refuse
node scripts/smoke.mjs            # end-to-end against a fake OpenCode server
```

To release: rebuild, bump `version` in `package.json`, commit, push — users get the update in Settings → Extensions. CI runs the package check on every push.

## Credits and license

The map and its reading are a port of [alexeyw/lot-map](https://github.com/alexeyw/lot-map) (MIT), rebuilt for OpenChamber's extension model. This code is MIT too — see [LICENSE](LICENSE).
