# Work map

An OpenChamber extension: a live map of the session's work, in a panel on the rail — a port of the [lot-map](https://github.com/alexeyw/lot-map) idea. Every tool call flies a pulse from the centre to its station, so you see files, shell, network, browser, subagents and skills at work instead of reading a list of calls.

## What you get

- **Work map panel** (rail): stations You · Model · Files · Shell · Network · Browser · Agents · Skills around the centre. Pulses out on start and back on end, red on error; spokes wear with use; clock hands while a call runs; subagent dots circle Agents; an answer ring when the turn ends. Below: the now-line and the last 16 calls. A picker at the top watches the most recent session (preferring the open project) or any session you choose.
- **Work Status section**: two rows — the watched session and what runs now.

## How it works

A local service (kept running) subscribes to OpenCode's read-only event stream, classifies each tool call the way lot-map does — file tools and file-only shell commands (`cat`, `grep`, `mv`, `sed`, `Get-Content`…) light Files; `curl`, `gh`, `ssh`, `npm install`, `npx -y`, MCP tools light Network; subagents light Agents — and pushes snapshots to the panel. Labels show names, never content: a file's last two path parts, a URL's host, a command's name or the description the model wrote. Nothing leaves the machine.

## Approvals asked at install

- a local service (`D:\programming\experiments\lot-map\service\main.js`), kept running;
- read-only OpenCode access (sessions and messages, tool calls included).

## Develop

```
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
node scripts/smoke.mjs
```
