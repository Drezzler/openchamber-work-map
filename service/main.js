// service/main.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// service/main.ts
var host = createServiceHost({ env: process.env });
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var ocBase = (process.env.OPENCHAMBER_OPENCODE_URL ?? "").replace(/\/$/, "");
var dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? path.join(os.tmpdir(), "lot-map");
var logPath = path.join(dataDir, "lot-map.log");
function log(event, detail = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      const stat = fs.statSync(logPath);
      if (Date.now() - stat.mtimeMs > 7 * 24 * 3600000)
        fs.writeFileSync(logPath, "");
    } catch {}
    const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...detail })}
`;
    fs.appendFileSync(logPath, line);
    const stat = fs.statSync(logPath);
    if (stat.size > 64 * 1024) {
      const lines = fs.readFileSync(logPath, "utf8").split(`
`);
      fs.writeFileSync(logPath, lines.slice(-100).join(`
`));
    }
  } catch {}
}
log("boot", { pid: process.pid, opencode: Boolean(ocBase), dataDir });
var lastOcError = null;
function ocError(msg) {
  lastOcError = msg;
  log("oc-error", { msg });
}
var STATIONS = ["you", "model", "memory", "files", "shell", "network", "browser", "agents", "skills"];
var FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "ls",
  "list",
  "ast_grep_search",
  "ast_grep_replace"
]);
var AGENT_TOOLS = new Set(["task", "subagent"]);
var SKILL_TOOLS = new Set(["skill", "find", "tool_search"]);
var BROWSER_TOOLS = new Set(["openchamber_web", "browser", "browser_navigate", "browser_snapshot"]);
var YOU_TOOLS = new Set(["question"]);
var FILE_CMDS = new Set([
  "cat",
  "grep",
  "rg",
  "find",
  "sed",
  "awk",
  "tee",
  "mv",
  "rm",
  "cp",
  "ln",
  "touch",
  "mkdir",
  "rmdir",
  "ls",
  "dir",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "chmod",
  "chown",
  "stat",
  "file",
  "du",
  "df",
  "diff",
  "patch",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "iconv",
  "get-content",
  "set-content",
  "add-content",
  "select-string",
  "get-childitem",
  "move-item",
  "copy-item",
  "remove-item",
  "rename-item",
  "new-item",
  "get-item",
  "set-location",
  "test-path",
  "split-path",
  "join-path"
]);
var NET_CMDS = new Set([
  "curl",
  "curl.exe",
  "wget",
  "ping",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "gh",
  "ftp",
  "telnet",
  "nslookup",
  "dig",
  "host",
  "invoke-webrequest",
  "invoke-restmethod",
  "iwr",
  "helm",
  "kubectl"
]);
var NET_PARENTS = {
  npm: new Set(["install", "i", "add", "publish", "update", "ci", "uninstall", "create", "init", "run", "exec", "test"]),
  yarn: new Set(["add", "install", "publish", "upgrade", "create", "dlx"]),
  pnpm: new Set(["add", "install", "i", "publish", "update", "dlx", "create"]),
  bun: new Set(["add", "install", "i", "publish", "update", "create", "x"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  uv: new Set(["add", "pip", "tool", "x"]),
  cargo: new Set(["install", "publish"]),
  go: new Set(["get", "install", "mod"]),
  gem: new Set(["install", "push"]),
  composer: new Set(["install", "require", "update"]),
  dotnet: new Set(["add", "restore", "tool"]),
  git: new Set(["push", "pull", "fetch", "clone", "remote", "ls-remote", "submodule"]),
  docker: new Set(["pull", "push", "login", "build"]),
  podman: new Set(["pull", "push", "login", "build"])
};
var WRAPPERS = new Set([
  "sudo",
  "env",
  "timeout",
  "nohup",
  "setsid",
  "nice",
  "stdbuf",
  "command",
  "builtin",
  "watch",
  "strace",
  "gtimeout",
  "xargs",
  "eval",
  "exec"
]);
function cleanLabel(text, cap = 60) {
  const stripped = (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > cap ? stripped.slice(0, cap - 1) + "…" : stripped;
}
function hostOf(url) {
  try {
    return cleanLabel(new URL(url).host, 40) || "web";
  } catch {
    return "web";
  }
}
function tail2(p) {
  const parts = (p ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0)
    return "file";
  return cleanLabel(parts.slice(-2).join("/"), 48);
}
function unwrapOnce(line) {
  let s = line.trim();
  if (s.startsWith("!"))
    return s.slice(1).trim() || null;
  if (s.startsWith("{"))
    s = s.slice(1).trim();
  if (s.startsWith("$("))
    return s.slice(2).split(")")[0] ?? null;
  if (s.startsWith("`"))
    return s.slice(1).split("`")[0] ?? null;
  const words = s.split(/\s+/);
  const name = (words[0] ?? "").toLowerCase();
  const kw = /^(for|if|while|until|case)$/.test(name);
  if (kw) {
    const after = s.split(/;\s*(do|then)\s*/i)[2] ?? s.split(/&&/)[1];
    if (after)
      return after.trim();
    return null;
  }
  if (WRAPPERS.has(name)) {
    let i = 1;
    while (i < words.length) {
      const w = words[i];
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i += 1;
        continue;
      }
      if (w.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    if (i >= words.length)
      return null;
    return words.slice(i).join(" ");
  }
  if (/^(bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|fish)$/.test(name)) {
    const rest = words.slice(1);
    while (rest.length && rest[0].startsWith("-"))
      rest.shift();
    if (rest.length === 0)
      return null;
    let inner = rest.join(" ");
    if (name === "cmd")
      return inner;
    inner = inner.replace(/^["']|["']$/g, "");
    return inner.trim() || null;
  }
  return null;
}
function classifyShell(commandText) {
  let line = (commandText ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  line = line.slice(0, 8000);
  for (let i = 0;i < 6; i += 1) {
    const next = unwrapOnce(line);
    if (!next)
      break;
    line = next;
  }
  const words = line.split(/\s+/).filter(Boolean);
  const name = (words[0] ?? "").toLowerCase();
  const sub = (words[1] ?? "").toLowerCase();
  let station = "shell";
  if (FILE_CMDS.has(name))
    station = "files";
  else if (NET_CMDS.has(name))
    station = "network";
  else if (NET_PARENTS[name]?.has(sub))
    station = "network";
  else if (name === "npx" || name === "bunx" || name === "pnpx") {
    station = words.includes("-y") || words.includes("--yes") ? "network" : "shell";
  }
  return { station, name: name || "shell" };
}
function classifyPart(tool, input, title) {
  const inp = input && typeof input === "object" ? input : {};
  const str = (k) => typeof inp[k] === "string" ? inp[k] : "";
  if (tool === "bash" || tool === "shell" || tool === "powershell" || tool === "pwsh" || tool === "terminal") {
    const cmd = str("command") || str("cmd") || (Array.isArray(inp.command) ? inp.command.join(" ") : "");
    const { station, name } = classifyShell(cmd);
    const t = cleanLabel(title ?? "");
    return { station, label: t && t.toLowerCase() !== name ? t : name };
  }
  if (FILE_TOOLS.has(tool)) {
    const p = str("file_path") || str("path") || str("file") || str("pattern");
    if (p && isMemoryPath(p))
      return { station: "memory", label: tail2(p) };
    return { station: "files", label: tail2(p || tool) };
  }
  if (tool === "webfetch")
    return { station: "network", label: hostOf(str("url")) };
  if (tool === "websearch" || tool === "google_search" || tool === "search")
    return { station: "network", label: "web search" };
  if (AGENT_TOOLS.has(tool) || tool.startsWith("subagent")) {
    return { station: "agents", label: cleanLabel(str("description") || str("prompt").split(".")[0] || title || "subagent", 40) || "subagent" };
  }
  if (SKILL_TOOLS.has(tool))
    return { station: "skills", label: cleanLabel(str("id") || str("name") || tool) || "skill" };
  if (BROWSER_TOOLS.has(tool) || tool.startsWith("browser_"))
    return { station: "browser", label: "browser" };
  if (YOU_TOOLS.has(tool))
    return { station: "you", label: cleanLabel(str("question") || title || "question", 40) || "question" };
  if (tool === "execute" || tool === "code_mode")
    return { station: "shell", label: cleanLabel(title || "run script") };
  return { station: "network", label: cleanLabel(title || tool, 40) || tool };
}
var sessions = new Map;
var states = new Map;
var inboxSeen = new Set;
var messageSeen = new Set;
var settledCalls = new Set;
var callTools = new Map;
var fineGrained = new Set;
var seenEvents = new Set;
var bgShells = new Map;
function shellSession(d, e) {
  const info = d.info ?? {};
  const meta = info.metadata ?? e.metadata ?? {};
  for (const v of [d.sessionID, info.sessionID, meta.sessionID, meta.sessionId]) {
    if (typeof v === "string" && v)
      return v;
  }
  const loc = e.location ?? {};
  if (typeof loc.directory === "string" && loc.directory) {
    const dir = loc.directory;
    const tops = [...sessions.values()].filter((s) => !s.parentId && s.directory && sameDir(s.directory, dir)).sort((a, b) => b.lastAt - a.lastAt);
    if (tops[0])
      return tops[0].id;
  }
  return null;
}
var watchMode = "auto";
var watchFixed = null;
var directoryHint = null;
var focusSessionId = null;
var focusAt = 0;
var pulseSeq = 0;
var feedSeq = 0;
var eventCounts = new Map;
function zeroRecord() {
  return { you: 0, model: 0, memory: 0, files: 0, shell: 0, network: 0, browser: 0, agents: 0, skills: 0 };
}
function windowFor(model) {
  const m = (model ?? "").toLowerCase();
  if (m.includes("gemini"))
    return 1e6;
  if (m.includes("gpt-5"))
    return 400000;
  if (m.includes("qwen"))
    return 262144;
  if (m.includes("kimi"))
    return 256000;
  return 200000;
}
var MEMORY_FILE = /(^|[\\/])(agents|claude|globallangents|memories)\.md$/i;
var MEMORY_PATH = /(^|[\\/])\.(claude|agents)([\\/]|$)|memory|knowledge/i;
function isMemoryPath(p) {
  return MEMORY_PATH.test(p) || MEMORY_FILE.test(p.replace(/\\/g, "/"));
}
function stateFor(id) {
  let s = states.get(id);
  if (!s) {
    s = { counts: zeroRecord(), errors: zeroRecord(), running: new Map, feed: [], route: [], pulses: [], lastAt: 0 };
    states.set(id, s);
    if (states.size > 10) {
      const keep = watchedSession()?.id;
      const oldest = [...states.entries()].filter(([id2]) => id2 !== keep).sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest && oldest[0] !== id)
        states.delete(oldest[0]);
    }
  }
  return s;
}
function mergeState(fromId, toId) {
  const from = states.get(fromId);
  if (!from || fromId === toId)
    return;
  const to = stateFor(toId);
  for (const k of STATIONS) {
    to.counts[k] += from.counts[k];
    to.errors[k] += from.errors[k];
  }
  for (const [key, call] of from.running)
    to.running.set(key, { ...call, from: "agents" });
  to.feed.push(...from.feed.map((r) => ({ ...r, agent: true })));
  to.route.push(...from.route.map((r) => ({ ...r, from: "agents" })));
  to.pulses.push(...from.pulses);
  states.delete(fromId);
}
function ensureSession(id, patch = {}) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, parentId: patch.parentId ?? null, busy: false, lastAt: 0 };
    sessions.set(id, s);
  }
  const gainedParent = patch.parentId !== undefined && patch.parentId !== null && s.parentId == null;
  if (patch.parentId !== undefined)
    s.parentId = patch.parentId;
  if (patch.title !== undefined && patch.title)
    s.title = patch.title;
  if (patch.directory !== undefined && patch.directory)
    s.directory = patch.directory;
  if (patch.busy !== undefined)
    s.busy = patch.busy;
  if (patch.lastAt !== undefined)
    s.lastAt = Math.max(s.lastAt, patch.lastAt);
  if (gainedParent && states.has(id)) {
    const top = topOf(id);
    if (top)
      mergeState(id, top.id);
  }
  return s;
}
function topOf(id) {
  let cur = id ? sessions.get(id) : null;
  if (!cur && id)
    cur = ensureSession(id);
  let guard = 0;
  while (cur?.parentId && guard < 8) {
    const parent = sessions.get(cur.parentId) ?? ensureSession(cur.parentId);
    cur = parent;
    guard += 1;
  }
  return cur ?? null;
}
function sameDir(a, b) {
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
function watchedSession() {
  if (watchMode === "fixed" && watchFixed)
    return sessions.get(watchFixed) ?? null;
  if (focusSessionId && Date.now() - focusAt < 10 * 60000) {
    const focused = sessions.get(focusSessionId);
    if (focused)
      return topOf(focused.id);
  }
  const tops = [...sessions.values()].filter((s) => !s.parentId);
  if (tops.length === 0)
    return null;
  const fresh = tops.filter((s) => Date.now() - s.lastAt < 60 * 60000);
  const pool0 = fresh.length ? fresh : tops;
  const inDir = directoryHint ? pool0.filter((s) => s.directory && sameDir(s.directory, directoryHint)) : [];
  const pool = inDir.length ? inDir : pool0;
  const busy = pool.filter((s) => s.busy && Date.now() - s.lastAt < 5 * 60000);
  const race = busy.length ? busy : pool;
  race.sort((a, b) => b.lastAt - a.lastAt);
  return race[0] ?? null;
}
function pruneState() {
  const cutoff = Date.now() - 90000;
  for (const st of states.values()) {
    st.route = st.route.filter((r) => r.at > cutoff);
    st.pulses = st.pulses.filter((p) => p.at > Date.now() - 20000).slice(-80);
    if (st.feed.length > 40)
      st.feed = st.feed.slice(-40);
  }
}
function pulse(st, station, from, dir, error = false) {
  pulseSeq += 1;
  st.pulses.push({ id: pulseSeq, station, from, dir, error, at: Date.now() });
}
function feedRow(st, row) {
  feedSeq += 1;
  st.feed.push({ ...row, id: feedSeq });
  if (st.feed.length > 40)
    st.feed = st.feed.slice(-40);
}
function endCall(st, key, error, endedAt) {
  const call = st.running.get(key);
  if (!call)
    return;
  st.running.delete(key);
  const end = endedAt ?? Date.now();
  pulse(st, call.station, call.from, "in", error);
  const started = call.startedAt || end;
  const idx = st.feed.findIndex((r) => r.status === "running" && r.station === call.station && r.label === call.label && r.at >= started - 1500 && r.at <= started + 1500);
  if (idx >= 0) {
    const r = st.feed[idx];
    st.feed[idx] = { ...r, status: error ? "error" : "done", ms: Math.max(0, end - started) };
  } else {
    feedRow(st, { station: call.station, label: call.label, status: error ? "error" : "done", at: end, ms: Math.max(0, end - started), agent: call.from === "agents" });
  }
  if (error)
    st.errors[call.station] += 1;
}
function startCall(st, key, station, label, from, sessionId, startedAt) {
  if (st.running.has(key))
    return;
  const at = startedAt ?? Date.now();
  const call = { key, station, label, from, sessionId, startedAt: at };
  st.running.set(key, call);
  st.counts[station] += 1;
  if (from === "agents" && station !== "agents")
    st.counts.agents += 1;
  st.route.push({ station, at, from });
  if (st.route.length > 14)
    st.route = st.route.slice(-14);
  pulse(st, station, from, "out");
  feedRow(st, { station, label, status: "running", at, agent: from === "agents" });
}
function processContent(sessionID, messageID, content) {
  ensureSession(sessionID, { lastAt: Date.now() });
  const top = topOf(sessionID);
  if (!top)
    return;
  const st = stateFor(top.id);
  const isSub = top.id !== sessionID;
  if (inboxSeen.has(messageID)) {
    return;
  }
  const parts = Array.isArray(content) ? content : [];
  if (fineGrained.has(sessionID)) {
    return;
  }
  if (!messageSeen.has(messageID)) {
    messageSeen.add(messageID);
    if (messageSeen.size > 400) {
      const drop = [...messageSeen].slice(0, 200);
      for (const d of drop)
        messageSeen.delete(d);
    }
    if (!isSub) {
      pulse(st, "model", "core", "out");
      feedRow(st, { station: "model", label: st.model ?? "model", status: "model", at: Date.now() });
    }
  }
  for (const p of parts) {
    if (p.type !== "tool")
      continue;
    const status = p.state?.status ?? "";
    const key = p.id ?? `${messageID}#tool`;
    const tool = p.name ?? p.tool ?? "tool";
    if (status === "running" || status === "pending") {
      if (st.running.has(key))
        continue;
      const title = typeof p.state?.title === "string" ? p.state.title : typeof p.state?.metadata?.title === "string" ? p.state.metadata.title : undefined;
      const { station, label } = classifyPart(tool, p.state?.input, title);
      const created = p.state?.time?.created;
      startCall(st, key, station, label, isSub ? "agents" : "core", sessionID, typeof created === "number" ? created : undefined);
    } else if (status === "completed" || status === "error") {
      if (st.running.has(key)) {
        endCall(st, key, status === "error", p.state?.time?.completed);
      } else if (!settledCalls.has(key)) {
        settledCalls.add(key);
        if (settledCalls.size > 400)
          for (const k of [...settledCalls].slice(0, 200))
            settledCalls.delete(k);
        const title = typeof p.state?.title === "string" ? p.state.title : undefined;
        const { station, label } = classifyPart(tool, p.state?.input, title);
        const created = p.state?.time?.created;
        const completed = p.state?.time?.completed;
        startCall(st, key, station, label, isSub ? "agents" : "core", sessionID, typeof created === "number" ? created : undefined);
        endCall(st, key, status === "error", typeof completed === "number" ? completed : undefined);
      }
    }
  }
  st.lastAt = Date.now();
  markDirty();
}
function sessionIdle(sessionID) {
  const info = sessions.get(sessionID);
  if (info)
    info.busy = false;
  const top = topOf(sessionID);
  if (!top) {
    markDirty();
    return;
  }
  const st = stateFor(top.id);
  for (const [key, call] of [...st.running]) {
    if (call.sessionId === sessionID)
      endCall(st, key, false);
  }
  if (top.id === sessionID && !st.running.size)
    st.answerAt = Date.now();
  markDirty();
}
function handleEvent(evt) {
  const e = evt ?? {};
  const type = typeof e.type === "string" ? e.type : "";
  const d = e.data ?? e.properties ?? e.payload ?? {};
  if (typeof e.id === "string") {
    if (seenEvents.has(e.id))
      return;
    seenEvents.add(e.id);
    if (seenEvents.size > 600)
      for (const k of [...seenEvents].slice(0, 300))
        seenEvents.delete(k);
  }
  eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
  const sid = typeof d.sessionID === "string" ? d.sessionID : typeof d.session?.id === "string" ? d.session.id : "";
  const createdAt = typeof e.created === "number" ? e.created : undefined;
  if (sid)
    tickBySession.set(sid, (tickBySession.get(sid) ?? 0) + 1);
  if (sid && !sessions.has(sid)) {
    const loc = e.location ?? {};
    ensureSession(sid, {
      directory: typeof loc.directory === "string" ? loc.directory : undefined,
      lastAt: createdAt ?? Date.now()
    });
  }
  const endToolCall = (callId, error) => {
    if (!sid || typeof callId !== "string")
      return;
    const top = topOf(sid);
    if (top)
      endCall(stateFor(top.id), `t:${callId}`, error, createdAt);
  };
  const titleOf = (v) => {
    const rec = v ?? {};
    return typeof rec.title === "string" ? rec.title : undefined;
  };
  switch (type) {
    case "session.tool.input.started": {
      if (sid && typeof d.id === "string" && typeof d.name === "string") {
        fineGrained.add(sid);
        callTools.set(d.id, d.name);
        if (callTools.size > 400)
          for (const k of [...callTools.keys()].slice(0, 200))
            callTools.delete(k);
      }
      break;
    }
    case "session.tool.called": {
      if (!sid || typeof d.id !== "string")
        break;
      const top = topOf(sid);
      if (!top)
        break;
      const st = stateFor(top.id);
      const key = `t:${d.id}`;
      if (st.running.has(key))
        break;
      const name = callTools.get(d.id) ?? d.native?.name ?? "tool";
      const { station, label } = classifyPart(name, d.input, titleOf(d.native) ?? titleOf(d.metadata));
      startCall(st, key, station, label, top.id !== sid ? "agents" : "core", sid, createdAt);
      break;
    }
    case "session.tool.success":
      endToolCall(d.id, false);
      break;
    case "session.tool.failed":
      endToolCall(d.id, true);
      break;
    case "session.usage.updated":
    case "session.usage.recorded": {
      const tokens = d.tokens ?? {};
      if (!sid)
        break;
      const top = topOf(sid);
      if (!top)
        break;
      const st = stateFor(top.id);
      const nums = [tokens.input, tokens.cache?.read, tokens.cache?.write].filter((v) => typeof v === "number");
      if (nums.length)
        st.usage = { used: nums.reduce((a, b) => a + b, 0), window: windowFor(st.model) };
      break;
    }
    case "shell.created": {
      const info = d.info ?? {};
      if (typeof info.id !== "string" || info.status !== "running")
        break;
      const owner = shellSession(d, e);
      if (!owner)
        break;
      ensureSession(owner, { lastAt: Date.now() });
      const { station, name } = classifyShell(typeof info.command === "string" ? info.command : "");
      bgShells.set(info.id, { sessionId: owner, station, label: name, at: info.time?.started ?? Date.now() });
      break;
    }
    case "shell.exited":
    case "shell.deleted": {
      const info = d.info ?? {};
      if (typeof info.id !== "string")
        break;
      const shell = bgShells.get(info.id);
      bgShells.delete(info.id);
      if (!shell)
        break;
      const top = topOf(shell.sessionId);
      if (!top)
        break;
      const st = stateFor(top.id);
      const wasBackground = !sessions.get(shell.sessionId)?.busy && Date.now() - shell.at > 3000;
      if (wasBackground) {
        pulse(st, shell.station, "core", "out");
        feedRow(st, { station: shell.station, label: `${shell.label} (bg)`, status: "done", at: Date.now(), ms: Date.now() - shell.at });
      }
      break;
    }
    case "session.step.started": {
      if (!sid)
        break;
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        pulse(st, "model", "core", "out");
        st.lastAt = Date.now();
      }
      break;
    }
    case "permission.asked": {
      if (!sid)
        break;
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        st.counts.you += 1;
        pulse(st, "you", "core", "out");
        feedRow(st, { station: "you", label: "asked to approve", status: "you", at: createdAt ?? Date.now() });
      }
      break;
    }
    case "session.created": {
      if (!sid)
        break;
      const loc = d.location ?? {};
      const model = d.model ?? {};
      ensureSession(sid, {
        title: typeof d.title === "string" ? d.title : typeof d.slug === "string" ? d.slug : undefined,
        directory: typeof loc.directory === "string" ? loc.directory : undefined,
        parentId: d.parentID === null || d.parentID === undefined ? undefined : String(d.parentID),
        lastAt: Date.now()
      });
      const st = stateFor(topOf(sid).id);
      if (model.id && !st.model)
        st.model = model.id;
      break;
    }
    case "session.inbox.delivered": {
      if (!sid)
        break;
      const inboxID = typeof d.inboxID === "string" ? d.inboxID : "";
      if (inboxID) {
        inboxSeen.add(inboxID);
        if (inboxSeen.size > 300)
          for (const k of [...inboxSeen].slice(0, 150))
            inboxSeen.delete(k);
      }
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        st.errors = zeroRecord();
        st.counts.you += 1;
        pulse(st, "you", "core", "out");
        feedRow(st, { station: "you", label: "message", status: "you", at: Date.now() });
        st.lastAt = Date.now();
        ensureSession(sid, { busy: true, lastAt: Date.now() });
      }
      break;
    }
    case "session.message.content.updated": {
      const messageID = typeof d.messageID === "string" ? d.messageID : "";
      if (sid && messageID)
        processContent(sid, messageID, d.content);
      break;
    }
    case "session.status": {
      const status = d.status ?? {};
      const t = status.type ?? "";
      if (!sid)
        break;
      if (t === "busy" || t === "retry") {
        ensureSession(sid, { busy: true, lastAt: Date.now() });
      } else if (t === "idle") {
        sessionIdle(sid);
      }
      break;
    }
    case "session.idle":
    case "session.busy": {
      if (!sid)
        break;
      if (type === "session.busy")
        ensureSession(sid, { busy: true, lastAt: Date.now() });
      else
        sessionIdle(sid);
      break;
    }
    case "session.model.selected": {
      const model = d.model ?? {};
      if (sid && model.id) {
        const top = topOf(sid);
        if (top) {
          const st = stateFor(top.id);
          if (st.model && st.model !== model.id) {
            st.modelFlashAt = Date.now();
            feedRow(st, { station: "model", label: `${st.model} → ${model.id}`, status: "change", at: Date.now() });
          }
          st.model = model.id;
        }
      }
      break;
    }
    case "session.renamed": {
      if (sid && typeof d.title === "string")
        ensureSession(sid, { title: d.title });
      break;
    }
    case "session.deleted": {
      if (sid)
        sessions.delete(sid);
      break;
    }
    case "session.execution.started": {
      if (sid)
        ensureSession(sid, { busy: true, lastAt: Date.now() });
      break;
    }
    case "session.execution.succeeded": {
      if (sid)
        sessionIdle(sid);
      break;
    }
    case "session.execution.failed":
    case "session.execution.interrupted": {
      if (!sid)
        break;
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        for (const key of [...st.running.keys()])
          endCall(st, key, true);
        feedRow(st, { station: "model", label: type === "session.execution.failed" ? "turn failed" : "turn stopped", status: "error", at: Date.now() });
      }
      sessionIdle(sid);
      break;
    }
    default:
      break;
  }
  markDirty();
}
var tickBySession = new Map;
setInterval(() => {
  const watched = watchedSession();
  const children = [...sessions.values()].filter((s) => s.parentId);
  const busyChildren = children.filter((s) => s.busy);
  const bySession = [...tickBySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${id.slice(-8)}:${n}${sessions.get(id)?.title ? `(${sessions.get(id).title.slice(0, 24)})` : ""}`).join(" ");
  tickBySession = new Map;
  log("tick", { events: Object.fromEntries(eventCounts), sessions: sessions.size, watched: watched?.id ?? null, watchedTitle: watched?.title ?? null, subs: children.length, subsBusy: busyChildren.length, bySession, ocError: lastOcError });
  eventCounts.clear();
}, 1e4).unref?.();
async function ocGet(pathName) {
  if (!ocBase)
    return null;
  try {
    const res = await fetch(ocBase + pathName, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      ocError(`${pathName} → ${res.status} ${bodyText.slice(0, 120)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    ocError(`${pathName} → ${err.message}`);
    return null;
  }
}
function listOf(body) {
  if (Array.isArray(body))
    return body;
  const b = body ?? {};
  for (const key of ["sessions", "items", "list", "messages", "data"]) {
    if (Array.isArray(b[key]))
      return b[key];
  }
  return [];
}
async function refreshSessions() {
  const body = await ocGet("/api/session?limit=200");
  if (!body)
    return;
  const arr = listOf(body);
  const shape = Array.isArray(body) ? "array" : Object.keys(body ?? {}).join(",");
  const first = arr[0];
  log("sessions-read", { shape, count: arr.length, first: first ? Object.keys(first).slice(0, 12).join(",") : null });
  for (const raw of arr) {
    const s = raw ?? {};
    if (typeof s.id !== "string")
      continue;
    const time = s.time ?? s.updatedAt ?? {};
    const loc = s.location ?? {};
    ensureSession(s.id, {
      title: typeof s.title === "string" ? s.title : undefined,
      directory: typeof s.directory === "string" ? s.directory : typeof loc.directory === "string" ? loc.directory : undefined,
      parentId: s.parentID === null || s.parentID === undefined ? undefined : String(s.parentID),
      lastAt: typeof time.updated === "number" ? time.updated : undefined
    });
  }
  markDirty();
}
async function reconcile() {
  await refreshSessions();
  const watched = watchedSession();
  if (!watched)
    return;
  const st = states.get(watched.id);
  if (!st || st.running.size === 0)
    return;
  const body = await ocGet(`/api/session/${encodeURIComponent(watched.id)}/message`);
  const liveKeys = new Set;
  for (const raw of listOf(body)) {
    const m = raw ?? {};
    if (m.type !== "assistant" || !Array.isArray(m.content))
      continue;
    for (const p of m.content) {
      if (p?.type === "tool" && p.id)
        liveKeys.add(p.id);
    }
  }
  for (const key of [...st.running.keys()]) {
    if (!liveKeys.has(key))
      endCall(st, key, false);
  }
}
var sseAbort = null;
var sseRunning = false;
async function streamLoop() {
  if (sseRunning || !ocBase)
    return;
  sseRunning = true;
  log("sse-start");
  while (sseRunning) {
    sseAbort = new AbortController;
    try {
      const res = await fetch(`${ocBase}/api/event`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: sseAbort.signal
      });
      if (!res.ok || !res.body)
        throw new Error(`event stream ${res.status}`);
      log("sse-open");
      await refreshSessions();
      const reader = res.body.getReader();
      const decoder = new TextDecoder;
      let buffer = "";
      for (;; ) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf(`

`)) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split(`
`)) {
            if (!line.startsWith("data:"))
              continue;
            const text = line.slice(5).trim();
            if (!text || text === "[DONE]")
              continue;
            try {
              handleEvent(JSON.parse(text));
            } catch {}
          }
        }
      }
      log("sse-end");
    } catch (err) {
      log("sse-error", { msg: err.message });
      ocError(`event stream: ${err.message}`);
    }
    if (!sseRunning)
      break;
    await new Promise((r) => setTimeout(r, 800));
    await reconcile().catch(() => {});
  }
}
setInterval(() => {
  pruneState();
  refreshSessions().catch(() => {});
}, 30000).unref?.();
function foldFeed(feed) {
  const rows = feed.slice(-16);
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && row.status === "done" && last.status === "done" && last.station === row.station && last.folded === undefined && last.label === row.label) {
      out[out.length - 1] = { ...last, folded: (last.folded ?? 0) + 1 };
      continue;
    }
    out.push(row);
  }
  const running = out.filter((r) => r.status === "running");
  if (running.length === 0)
    return out;
  const limit = Math.max(8, 16 - running.length);
  const shown = out.filter((r, i) => r.status === "running" || i >= out.length - limit);
  return shown.slice(-16);
}
function snapshot() {
  const watched = watchedSession();
  pruneState();
  const st = watched ? stateFor(watched.id) : null;
  const subagents = watched ? [...sessions.values()].filter((s) => s.busy && topOf(s.id)?.id === watched.id && s.id !== watched.id) : [];
  const runningByStation = {};
  if (st)
    for (const c of st.running.values())
      runningByStation[c.station] = (runningByStation[c.station] ?? 0) + 1;
  const bg = watched ? [...bgShells.values()].filter((b) => topOf(b.sessionId)?.id === watched.id && !sessions.get(b.sessionId)?.busy) : [];
  for (const b of bg)
    runningByStation[b.station] = (runningByStation[b.station] ?? 0) + 1;
  const tops = [...sessions.values()].filter((s) => !s.parentId).sort((a, b) => b.lastAt - a.lastAt).slice(0, 12);
  let feed = st ? foldFeed(st.feed) : [];
  if (st && bg.length > 0) {
    const earliest = Math.min(...bg.map((b) => b.at));
    feed = [...feed, {
      id: -1,
      station: bg[0].station,
      label: bg.length > 1 ? `${bg.length} background tasks` : `${bg[0].label} (bg)`,
      status: "running",
      at: earliest
    }].slice(-16);
  }
  return {
    ok: true,
    opencode: Boolean(ocBase),
    debug: lastOcError,
    watch: watched ? { sessionId: watched.id, title: (watched.title ?? watched.id).slice(0, 60), directory: watched.directory ?? null, busy: watched.busy, model: st?.model ?? null } : null,
    watchMode,
    sessions: tops.map((s) => ({ id: s.id, title: (s.title ?? s.id).slice(0, 60), directory: s.directory ?? null, busy: s.busy })),
    stations: st ? Object.fromEntries(STATIONS.map((k) => [k, { used: st.counts[k], running: runningByStation[k] ?? 0, errors: st.errors[k] }])) : Object.fromEntries(STATIONS.map((k) => [k, { used: 0, running: 0, errors: 0 }])),
    feed,
    route: st ? st.route.slice(-12) : [],
    subagents: subagents.map((s) => s.id),
    bg: bg.length,
    answerAt: st?.answerAt ?? null,
    modelFlashAt: st?.modelFlashAt ?? null,
    context: st?.usage ? { used: st.usage.used, window: st.usage.window, pct: Math.min(100, Math.round(st.usage.used / st.usage.window * 100)) } : null,
    pulses: st ? st.pulses.slice(-60) : [],
    now: Date.now()
  };
}
function statusRows() {
  const snap = snapshot();
  if (!snap.opencode) {
    return { rows: [{ kind: "note", id: "oc", text: "This host cannot provide OpenCode access yet.", tone: "warning" }] };
  }
  if (!snap.watch) {
    const text = snap.debug ? `No session seen yet. OpenCode read failed: ${String(snap.debug).slice(0, 100)}` : "No session yet. Work in a session and the map lights up.";
    return { rows: [{ kind: "note", id: "empty", text, tone: snap.debug ? "error" : "default" }] };
  }
  const running = Object.entries(snap.stations).filter(([, v]) => v.running > 0);
  let now;
  if (running.length > 0) {
    now = running.map(([k, v]) => `${k} ×${v.running}`).join(", ");
  } else if (snap.subagents.length > 0) {
    now = `${snap.subagents.length} agent${snap.subagents.length > 1 ? "s" : ""} at work`;
  } else if (snap.watch.busy) {
    now = "model thinking";
  } else {
    now = "idle";
  }
  const errors = Object.values(snap.stations).reduce((a, v) => a + v.errors, 0);
  return {
    rows: [
      { kind: "line", id: "watch", label: "Session", value: snap.watch.title.slice(0, 40), dot: snap.watch.busy ? "accent" : "success" },
      { kind: "line", id: "now", label: "Now", value: now.slice(0, 80), dot: errors > 0 ? "error" : undefined },
      { kind: "note", id: "map", text: "Open the Work map panel on the rail for the live map." }
    ]
  };
}
var emitDirty = false;
var emitTimer = null;
var lastEmit = 0;
var lastEmitErrorLog = 0;
var emitHealthy = false;
function markDirty() {
  emitDirty = true;
  const now = Date.now();
  const wait = 120 - (now - lastEmit);
  if (wait <= 0) {
    flushEmit();
  } else if (!emitTimer) {
    emitTimer = setTimeout(flushEmit, wait);
  }
}
function flushEmit() {
  emitTimer = null;
  if (!emitDirty)
    return;
  emitDirty = false;
  lastEmit = Date.now();
  host.emit("map", snapshot()).then(() => {
    if (!emitHealthy) {
      emitHealthy = true;
      log("emit-ok", {});
    }
  }, (err) => {
    if (Date.now() - lastEmitErrorLog > 30000) {
      lastEmitErrorLog = Date.now();
      log("emit-error", { msg: err.message });
    }
  });
}
var json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
async function route(req, res, pathName, query, body) {
  if (pathName === "/health") {
    json(res, 200, {});
    return;
  }
  if (pathName === "/state" && req.method === "GET") {
    json(res, 200, snapshot());
    return;
  }
  if (pathName === "/context" && req.method === "POST") {
    try {
      const data = JSON.parse(body || "{}");
      directoryHint = data.directory ?? null;
      if (data.sessionId !== undefined) {
        focusSessionId = data.sessionId ?? null;
        focusAt = Date.now();
        if (focusSessionId && !sessions.has(focusSessionId))
          ensureSession(focusSessionId, { lastAt: Date.now() });
      }
    } catch {}
    markDirty();
    json(res, 200, snapshot());
    return;
  }
  if (pathName === "/watch" && req.method === "POST") {
    try {
      const data = JSON.parse(body || "{}");
      if (data.sessionId) {
        watchMode = "fixed";
        watchFixed = data.sessionId;
      } else {
        watchMode = "auto";
        watchFixed = null;
      }
    } catch {}
    markDirty();
    json(res, 200, snapshot());
    return;
  }
  if (pathName === "/status") {
    if (req.method === "GET") {
      const dir = query.get("directory");
      if (dir)
        directoryHint = dir;
      json(res, 200, statusRows());
      return;
    }
    json(res, 200, {});
    return;
  }
  json(res, 404, {});
}
http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    route(req, res, url.pathname, url.searchParams, body).catch((err) => {
      log("http-error", { msg: err.message });
      if (!res.headersSent)
        res.writeHead(500).end("{}");
    });
  });
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0) || 4599, "127.0.0.1", () => {
  refreshSessions().then(() => streamLoop()).catch((err) => log("start-error", { msg: err.message }));
});
