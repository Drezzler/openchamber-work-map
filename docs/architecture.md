# Architecture

## Surfaces

| Piece | Manifest key | Role |
|---|---|---|
| Panel | `contributes.panel` | Canvas map + feed + session picker + options; receives snapshots, never polls after the first push (a 1.5 s fallback poll runs only until the first push arrives) |
| Service | `contributes.service` (`provides: ["opencode"]`, `keepRunning`) | Subscribes to OpenCode's read-only event stream, classifies calls, keeps per-session state, emits snapshots |
| Status section | `contributes.statusSection.source` | The app polls `GET /status` and draws two rows itself; no frame loaded |

## The wire

The service consumes OpenCode's SSE stream (`GET /api/event`) and the session list (`GET /api/session?limit=200`). Events arrive as `{ id, created, type, data, location? }`; envelope ids dedupe replayed frames after a reconnect.

| Event | Use |
|---|---|
| `session.created`, `session.renamed`, `session.deleted` | Session registry (title, directory, `parentID` links subagents) |
| `session.inbox.delivered` | A user message: lights **You**, clears error marks |
| `session.message.content.updated` | Fallback path (older hosts): tool parts with `running/completed/error` states |
| `session.tool.input.started` / `.called` / `.success` / `.failed` | Primary path: name → args → end; calls keyed by call id |
| `session.step.started` | A model request: pulses **Model** |
| `permission.asked` | Lights **You** (`asked to approve`) |
| `session.model.selected` | Model change: `◆ old → new` row + ring flash |
| `session.status`, `session.execution.*` | Turn boundaries: busy/idle, answer ring, stuck-call cleanup |
| `session.usage.updated` | Context ring (input + cache read/write vs a per-family window estimate) |
| `shell.created` / `.exited` / `.deleted` | Background work: a shell alive after its session's turn keeps its station lit; attribution by session probes, else the event's project directory |

## Classification

`classifyPart` in `service/main.ts` maps a tool to a station:

- known file tools (`read`, `edit`, `glob`, `grep`, …) → **Files**, unless the path smells like memory (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/`, `memory`, `knowledge`) → **Memory**
- `bash`/`powershell` commands are unwrapped (`sudo`, `env`, `xargs`, `bash -c`, `$(…)`, loops) and read by first word: file-only commands → **Files**; `curl`, `gh`, `ssh`, `rsync`, `kubectl`, `git push`, `npm install`, `npx -y`, … → **Network**; the rest → **Shell**
- `task` and subagent sessions → **Agents** (their calls pulse from the Agents station; the spoke wears)
- `skill` → **Skills**; browser tools → **Browser**; unknown/MCP tools → **Network**

Labels are names, never content: last two path parts, URL host, command name, or the description the model wrote for a shell call. Control characters stripped, capped at 60.

## Watching: focus, Auto, pins

- Each panel reports its window's current session and directory (`onSession` / `onDirectory`) to `POST /context`, heartbeated every 60 s.
- **Auto** picks the focused session; if none was reported (or it lapsed after 10 min), it follows the work: a busy session from the last 5 minutes beats a recently-touched idle one, sessions from the open project are preferred, entries older than an hour drop out.
- A pinned session (`POST /watch`) overrides everything until the picker returns to Auto.
- Pulses, feeds and routes are per-session; switching sessions resets the panel's pulse gate so the new map animates at once.

## State and lifecycle

- Service state is in memory only: up to 10 session states (the watched one is never evicted), 40 feed rows, pulses pruned after 20 s, routes after 90 s.
- The SSE connection is limited in bytes per response; the service reconnects and reconciles still-"running" calls against the message list.
- A subagent discovered late (parent link arriving after its calls started) has its recorded work merged into the parent's map.
- Diagnostics: one JSONL log per extension data dir (`OPENCHAMBER_SERVICE_DATA_DIR/lot-map.log`), capped at 100 lines and wiped after a quiet week — see [privacy.md](privacy.md).
