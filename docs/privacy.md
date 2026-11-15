# What it reads and what it keeps

The extension runs on your machine and sends nothing anywhere. It has no network origin, no integration, no token of yours; the only connections it makes are to OpenCode's read-only endpoint, through OpenChamber's loopback proxy, inside your machine.

## What it sees

Like anything that follows a session's events, the service is handed each event whole, including command lines and the arguments of tool calls. From that it takes **names, and nothing else**:

- a file: the last two parts of its path;
- a web address: the host alone — no login, password, path or query;
- a shell command: the command's name, or the short description the model wrote for it — never the command line; `npx` counts as network only with `-y`;
- a search or fetch: the tool's name or the host, never the query;
- a subagent: the description it was started with;
- a background task: that it ended and whether it failed, never its output;
- your message: that it arrived, never its text.

Control characters are stripped from every label before it is drawn.

## What it keeps

- Session state (counts, feed rows, pulses) lives in the service's memory only, for the sessions it watched. It is gone when the service stops.
- Panel options (layout, motion, colors) are stored in OpenChamber's extension storage, per device.
- One diagnostics file: `lot-map.log` in the extension's own data dir, written by the service so failures can be told apart (boot, stream open/close, session-list reads, per-session event counts with session titles, the last OpenCode read error). It holds no message content and no command lines — at most session titles, station names and counts. It is capped at 100 lines and wiped after a week without a write. Delete the file any time; the map does not depend on it.

## What it never does

- No network requests beyond the read-only OpenCode stream on this machine.
- No file system access, no processes spawned, no model calls, nothing added to any conversation.
- Secrets never reach the panel; the OpenCode connection is authenticated by the per-service token OpenChamber mints, which the panel never sees.

A hosted copy of this repository is installable straight from its URL; installing fetches only what is committed here — the same code you can read.
