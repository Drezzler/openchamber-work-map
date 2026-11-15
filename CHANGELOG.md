# Changelog

## 1.0.0 — 2026-11-16

First release.

- Nine stations (You, Model, Memory, Files, Shell, Network, Browser, Agents, Skills) with per-tool-call pulses, worn spokes, clock hands on working stations, error marks (`!n`) until the next message.
- Context ring around the core from `session.usage.updated` (window estimated per model family; amber 70 %, red 90 %).
- Background shells keep their station lit (`bg ×N`) until they end.
- Subagents: dots orbit Agents, calls start from it, feed rows carry the agent mark.
- Feed: last 16 rows, `● · ✕ ◆`, `+n` folding, running rows pinned, `▸` row expand, time column.
- Model change: `◆ old → new` row plus a ring flash on the core and the Model station.
- Answer ring when a turn ends.
- Auto watch follows the focused session (heartbeated), falling back to the busiest recent one; sessions pinnable from the picker.
- Work Status section: watched session + what runs now.
- Options: You at top/bottom, full/reduced motion, accent and memory colors — saved per device.
- Works on OpenCode's current event wire (`data` envelopes, `session.tool.*`, `shell.*`, `session.usage.*`) with a fallback to `session.message.content.updated`.
- Diagnostics log in the extension data dir, capped and wiped after a quiet week.
