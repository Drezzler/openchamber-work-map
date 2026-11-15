// Work map service: reads OpenCode's live event stream (read-only), classifies
// every tool call into a station the way lot-map does, keeps per-session state,
// and pushes snapshots to the panel through host.emit.
//
// Wire: OpenCode 2.x events are { id, created, type, data, location? } with the
// payload in `data` (older hosts used `properties`; both are accepted below).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServiceHost } from '@openchamber/sdk';

const host = createServiceHost({ env: process.env });
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const ocBase = (process.env.OPENCHAMBER_OPENCODE_URL ?? '').replace(/\/$/, '');
const dataDir = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? path.join(os.tmpdir(), 'lot-map');

// ---------------------------------------------------------------- diagnostics

const logPath = path.join(dataDir, 'lot-map.log');
function log(event: string, detail: Record<string, unknown> = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      const stat = fs.statSync(logPath);
      if (Date.now() - stat.mtimeMs > 7 * 24 * 3600_000) fs.writeFileSync(logPath, ''); // a quiet week: start over
    } catch { /* no file yet */ }
    const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...detail })}\n`;
    fs.appendFileSync(logPath, line);
    const stat = fs.statSync(logPath);
    if (stat.size > 64 * 1024) {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n');
      fs.writeFileSync(logPath, lines.slice(-100).join('\n'));
    }
  } catch {
    /* logging must never break the service */
  }
}
log('boot', { pid: process.pid, opencode: Boolean(ocBase), dataDir });

let lastOcError: string | null = null;
function ocError(msg: string) {
  lastOcError = msg;
  log('oc-error', { msg });
}

type Station = 'you' | 'model' | 'memory' | 'files' | 'shell' | 'network' | 'browser' | 'agents' | 'skills';
const STATIONS: Station[] = ['you', 'model', 'memory', 'files', 'shell', 'network', 'browser', 'agents', 'skills'];

// ---------------------------------------------------------------- classify

const FILE_TOOLS = new Set([
  'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'ls', 'list',
  'ast_grep_search', 'ast_grep_replace',
]);
const AGENT_TOOLS = new Set(['task', 'subagent']);
const SKILL_TOOLS = new Set(['skill', 'find', 'tool_search']);
const BROWSER_TOOLS = new Set(['openchamber_web', 'browser', 'browser_navigate', 'browser_snapshot']);
const YOU_TOOLS = new Set(['question']);

// Shell commands that only read, search, move, delete or edit files in place.
const FILE_CMDS = new Set([
  'cat', 'grep', 'rg', 'find', 'sed', 'awk', 'tee', 'mv', 'rm', 'cp', 'ln',
  'touch', 'mkdir', 'rmdir', 'ls', 'dir', 'head', 'tail', 'less', 'more',
  'wc', 'sort', 'uniq', 'cut', 'tr', 'chmod', 'chown', 'stat', 'file', 'du',
  'df', 'diff', 'patch', 'basename', 'dirname', 'realpath', 'readlink',
  'md5sum', 'sha1sum', 'sha256sum', 'iconv',
  'get-content', 'set-content', 'add-content', 'select-string',
  'get-childitem', 'move-item', 'copy-item', 'remove-item', 'rename-item',
  'new-item', 'get-item', 'set-location', 'test-path', 'split-path', 'join-path',
]);

// Shell commands known to reach the network. Subcommands matter for npm/git/npx.
const NET_CMDS = new Set([
  'curl', 'curl.exe', 'wget', 'ping', 'ssh', 'scp', 'sftp', 'rsync', 'gh',
  'ftp', 'telnet', 'nslookup', 'dig', 'host', 'invoke-webrequest',
  'invoke-restmethod', 'iwr', 'helm', 'kubectl',
]);
const NET_PARENTS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'add', 'publish', 'update', 'ci', 'uninstall', 'create', 'init', 'run', 'exec', 'test']),
  yarn: new Set(['add', 'install', 'publish', 'upgrade', 'create', 'dlx']),
  pnpm: new Set(['add', 'install', 'i', 'publish', 'update', 'dlx', 'create']),
  bun: new Set(['add', 'install', 'i', 'publish', 'update', 'create', 'x']),
  pip: new Set(['install', 'download']),
  pip3: new Set(['install', 'download']),
  uv: new Set(['add', 'pip', 'tool', 'x']),
  cargo: new Set(['install', 'publish']),
  go: new Set(['get', 'install', 'mod']),
  gem: new Set(['install', 'push']),
  composer: new Set(['install', 'require', 'update']),
  dotnet: new Set(['add', 'restore', 'tool']),
  git: new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'ls-remote', 'submodule']),
  docker: new Set(['pull', 'push', 'login', 'build']),
  podman: new Set(['pull', 'push', 'login', 'build']),
};
const WRAPPERS = new Set([
  'sudo', 'env', 'timeout', 'nohup', 'setsid', 'nice', 'stdbuf', 'command',
  'builtin', 'watch', 'strace', 'gtimeout', 'xargs', 'eval', 'exec',
]);

function cleanLabel(text: string, cap = 60): string {
  const stripped = (text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > cap ? stripped.slice(0, cap - 1) + '…' : stripped;
}

function hostOf(url: string): string {
  try {
    return cleanLabel(new URL(url).host, 40) || 'web';
  } catch {
    return 'web';
  }
}

function tail2(p: string): string {
  const parts = (p ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return 'file';
  return cleanLabel(parts.slice(-2).join('/'), 48);
}

/** Strip one layer of wrapping; return null when not wrapped. */
function unwrapOnce(line: string): string | null {
  let s = line.trim();
  if (s.startsWith('!')) return s.slice(1).trim() || null;
  if (s.startsWith('{')) s = s.slice(1).trim();
  if (s.startsWith('$(')) return s.slice(2).split(')')[0] ?? null;
  if (s.startsWith('`')) return s.slice(1).split('`')[0] ?? null;
  const words = s.split(/\s+/);
  const name = (words[0] ?? '').toLowerCase();
  const kw = /^(for|if|while|until|case)$/.test(name);
  if (kw) {
    const after = s.split(/;\s*(do|then)\s*/i)[2] ?? s.split(/&&/)[1];
    if (after) return after.trim();
    return null;
  }
  if (WRAPPERS.has(name)) {
    let i = 1;
    while (i < words.length) {
      const w = words[i];
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
      if (w.startsWith('-')) { i += 1; continue; }
      break;
    }
    if (i >= words.length) return null;
    return words.slice(i).join(' ');
  }
  if (/^(bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|fish)$/.test(name)) {
    const rest = words.slice(1);
    while (rest.length && rest[0].startsWith('-')) rest.shift();
    if (rest.length === 0) return null;
    let inner = rest.join(' ');
    if (name === 'cmd') return inner;
    inner = inner.replace(/^["']|["']$/g, '');
    return inner.trim() || null;
  }
  return null;
}

function classifyShell(commandText: string): { station: Station; name: string } {
  let line = (commandText ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  line = line.slice(0, 8000);
  for (let i = 0; i < 6; i += 1) {
    const next = unwrapOnce(line);
    if (!next) break;
    line = next;
  }
  const words = line.split(/\s+/).filter(Boolean);
  const name = (words[0] ?? '').toLowerCase();
  const sub = (words[1] ?? '').toLowerCase();
  let station: Station = 'shell';
  if (FILE_CMDS.has(name)) station = 'files';
  else if (NET_CMDS.has(name)) station = 'network';
  else if (NET_PARENTS[name]?.has(sub)) station = 'network';
  else if (name === 'npx' || name === 'bunx' || name === 'pnpx') {
    station = words.includes('-y') || words.includes('--yes') ? 'network' : 'shell';
  }
  return { station, name: name || 'shell' };
}

type Classified = { station: Station; label: string };

function classifyPart(tool: string, input: unknown, title?: string): Classified {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof inp[k] === 'string' ? (inp[k] as string) : '');
  if (tool === 'bash' || tool === 'shell' || tool === 'powershell' || tool === 'pwsh' || tool === 'terminal') {
    const cmd = str('command') || str('cmd') || (Array.isArray(inp.command) ? (inp.command as string[]).join(' ') : '');
    const { station, name } = classifyShell(cmd);
    const t = cleanLabel(title ?? '');
    // Prefer the description the model wrote; never the command line itself.
    return { station, label: t && t.toLowerCase() !== name ? t : name };
  }
  if (FILE_TOOLS.has(tool)) {
    const p = str('file_path') || str('path') || str('file') || str('pattern');
    if (p && isMemoryPath(p)) return { station: 'memory', label: tail2(p) };
    return { station: 'files', label: tail2(p || tool) };
  }
  if (tool === 'webfetch') return { station: 'network', label: hostOf(str('url')) };
  if (tool === 'websearch' || tool === 'google_search' || tool === 'search') return { station: 'network', label: 'web search' };
  if (AGENT_TOOLS.has(tool) || tool.startsWith('subagent')) {
    return { station: 'agents', label: cleanLabel(str('description') || str('prompt').split('.')[0] || title || 'subagent', 40) || 'subagent' };
  }
  if (SKILL_TOOLS.has(tool)) return { station: 'skills', label: cleanLabel(str('id') || str('name') || tool) || 'skill' };
  if (BROWSER_TOOLS.has(tool) || tool.startsWith('browser_')) return { station: 'browser', label: 'browser' };
  if (YOU_TOOLS.has(tool)) return { station: 'you', label: cleanLabel(str('question') || title || 'question', 40) || 'question' };
  if (tool === 'execute' || tool === 'code_mode') return { station: 'shell', label: cleanLabel(title || 'run script') };
  // MCP and unknown tools reach outside the session: Network.
  return { station: 'network', label: cleanLabel(title || tool, 40) || tool };
}

// ---------------------------------------------------------------- state

type FeedRow = {
  id: number;
  station: Station;
  label: string;
  status: 'running' | 'done' | 'error' | 'model' | 'you' | 'change';
  at: number;
  ms?: number;
  agent?: boolean;
  folded?: number;
};

type Call = {
  key: string;
  station: Station;
  label: string;
  from: 'core' | 'agents';
  sessionId: string;
  startedAt: number;
};

type SessionState = {
  counts: Record<Station, number>;
  errors: Record<Station, number>;
  running: Map<string, Call>;
  feed: FeedRow[];
  route: { station: Station; at: number; from: 'core' | 'agents' }[];
  pulses: { id: number; station: Station; from: 'core' | 'agents'; dir: 'out' | 'in'; error: boolean; at: number }[];
  model?: string;
  modelFlashAt?: number;
  usage?: { used: number; window: number };
  answerAt?: number;
  lastAt: number;
};

type SessionInfo = {
  id: string;
  title?: string;
  directory?: string;
  parentId?: string | null;
  busy: boolean;
  lastAt: number;
};

const sessions = new Map<string, SessionInfo>();
const states = new Map<string, SessionState>();
const inboxSeen = new Set<string>();
const messageSeen = new Set<string>();
const settledCalls = new Set<string>();
const callTools = new Map<string, string>(); // fine-grained call id -> tool name
const fineGrained = new Set<string>(); // session ids that emit session.tool.* events
const seenEvents = new Set<string>(); // envelope ids, so a replayed stream counts once
const bgShells = new Map<string, { sessionId: string; station: Station; label: string; at: number }>();

/** Shells carry no session id on the wire; attribute by probes, then directory. */
function shellSession(d: Record<string, unknown>, e: Record<string, unknown>): string | null {
  const info = (d.info ?? {}) as Record<string, unknown>;
  const meta = (info.metadata ?? e.metadata ?? {}) as Record<string, unknown>;
  for (const v of [d.sessionID, info.sessionID, meta.sessionID, meta.sessionId]) {
    if (typeof v === 'string' && v) return v;
  }
  const loc = (e.location ?? {}) as { directory?: string };
  if (typeof loc.directory === 'string' && loc.directory) {
    const dir = loc.directory;
    const tops = [...sessions.values()]
      .filter((s) => !s.parentId && s.directory && sameDir(s.directory, dir))
      .sort((a, b) => b.lastAt - a.lastAt);
    if (tops[0]) return tops[0].id;
  }
  return null;
}

let watchMode: 'auto' | 'fixed' = 'auto';
let watchFixed: string | null = null;
let directoryHint: string | null = null;
let focusSessionId: string | null = null;
let focusAt = 0;
let pulseSeq = 0;
let feedSeq = 0;
const eventCounts = new Map<string, number>();

function zeroRecord(): Record<Station, number> {
  return { you: 0, model: 0, memory: 0, files: 0, shell: 0, network: 0, browser: 0, agents: 0, skills: 0 };
}

/** Rough context window per model family; the ring is an estimate. */
function windowFor(model?: string): number {
  const m = (model ?? '').toLowerCase();
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('gpt-5')) return 400_000;
  if (m.includes('qwen')) return 262_144;
  if (m.includes('kimi')) return 256_000;
  return 200_000;
}

const MEMORY_FILE = /(^|[\\/])(agents|claude|globallangents|memories)\.md$/i;
const MEMORY_PATH = /(^|[\\/])\.(claude|agents)([\\/]|$)|memory|knowledge/i;

function isMemoryPath(p: string): boolean {
  return MEMORY_PATH.test(p) || MEMORY_FILE.test(p.replace(/\\/g, '/'));
}

function stateFor(id: string): SessionState {
  let s = states.get(id);
  if (!s) {
    s = { counts: zeroRecord(), errors: zeroRecord(), running: new Map(), feed: [], route: [], pulses: [], lastAt: 0 };
    states.set(id, s);
    if (states.size > 10) {
      const keep = watchedSession()?.id;
      const oldest = [...states.entries()].filter(([id2]) => id2 !== keep).sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest && oldest[0] !== id) states.delete(oldest[0]);
    }
  }
  return s;
}

function mergeState(fromId: string, toId: string) {
  const from = states.get(fromId);
  if (!from || fromId === toId) return;
  const to = stateFor(toId);
  for (const k of STATIONS) {
    to.counts[k] += from.counts[k];
    to.errors[k] += from.errors[k];
  }
  for (const [key, call] of from.running) to.running.set(key, { ...call, from: 'agents' });
  to.feed.push(...from.feed.map((r) => ({ ...r, agent: true })));
  to.route.push(...from.route.map((r) => ({ ...r, from: 'agents' as const })));
  to.pulses.push(...from.pulses);
  states.delete(fromId);
}

function ensureSession(id: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  let s = sessions.get(id);
  if (!s) {
    s = { id, parentId: patch.parentId ?? null, busy: false, lastAt: 0 };
    sessions.set(id, s);
  }
  const gainedParent = patch.parentId !== undefined && patch.parentId !== null && s.parentId == null;
  if (patch.parentId !== undefined) s.parentId = patch.parentId;
  if (patch.title !== undefined && patch.title) s.title = patch.title;
  if (patch.directory !== undefined && patch.directory) s.directory = patch.directory;
  if (patch.busy !== undefined) s.busy = patch.busy;
  if (patch.lastAt !== undefined) s.lastAt = Math.max(s.lastAt, patch.lastAt);
  if (gainedParent && states.has(id)) {
    // This session turns out to be a subagent: hand its recorded work to the parent.
    const top = topOf(id);
    if (top) mergeState(id, top.id);
  }
  return s;
}

function topOf(id: string | undefined | null): SessionInfo | null {
  let cur = id ? sessions.get(id) : null;
  if (!cur && id) cur = ensureSession(id);
  let guard = 0;
  while (cur?.parentId && guard < 8) {
    const parent = sessions.get(cur.parentId) ?? ensureSession(cur.parentId);
    cur = parent;
    guard += 1;
  }
  return cur ?? null;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function watchedSession(): SessionInfo | null {
  if (watchMode === 'fixed' && watchFixed) return sessions.get(watchFixed) ?? null;
  // Auto follows focus: the session open in the window the user is looking at.
  // Falls back to following the work when no panel has reported a focus.
  if (focusSessionId && Date.now() - focusAt < 10 * 60_000) {
    const focused = sessions.get(focusSessionId);
    if (focused) return topOf(focused.id);
  }
  const tops = [...sessions.values()].filter((s) => !s.parentId);
  if (tops.length === 0) return null;
  // A session that is busy now wins over one merely touched recently, and
  // stale sessions (an hour old) drop out of the race.
  const fresh = tops.filter((s) => Date.now() - s.lastAt < 60 * 60_000);
  const pool0 = fresh.length ? fresh : tops;
  const inDir = directoryHint ? pool0.filter((s) => s.directory && sameDir(s.directory, directoryHint!)) : [];
  const pool = inDir.length ? inDir : pool0;
  const busy = pool.filter((s) => s.busy && Date.now() - s.lastAt < 5 * 60_000);
  const race = busy.length ? busy : pool;
  race.sort((a, b) => b.lastAt - a.lastAt);
  return race[0] ?? null;
}

function pruneState() {
  const cutoff = Date.now() - 90_000;
  for (const st of states.values()) {
    st.route = st.route.filter((r) => r.at > cutoff);
    st.pulses = st.pulses.filter((p) => p.at > Date.now() - 20_000).slice(-80);
    if (st.feed.length > 40) st.feed = st.feed.slice(-40);
  }
}

// ---------------------------------------------------------------- events

function pulse(st: SessionState, station: Station, from: 'core' | 'agents', dir: 'out' | 'in', error = false) {
  pulseSeq += 1;
  st.pulses.push({ id: pulseSeq, station, from, dir, error, at: Date.now() });
}

function feedRow(st: SessionState, row: Omit<FeedRow, 'id'>) {
  feedSeq += 1;
  st.feed.push({ ...row, id: feedSeq });
  if (st.feed.length > 40) st.feed = st.feed.slice(-40);
}

function endCall(st: SessionState, key: string, error: boolean, endedAt?: number) {
  const call = st.running.get(key);
  if (!call) return;
  st.running.delete(key);
  const end = endedAt ?? Date.now();
  pulse(st, call.station, call.from, 'in', error);
  const started = call.startedAt || end;
  const idx = st.feed.findIndex((r) => r.status === 'running' && r.station === call.station && r.label === call.label && r.at >= started - 1500 && r.at <= started + 1500);
  if (idx >= 0) {
    const r = st.feed[idx];
    st.feed[idx] = { ...r, status: error ? 'error' : 'done', ms: Math.max(0, end - started) };
  } else {
    feedRow(st, { station: call.station, label: call.label, status: error ? 'error' : 'done', at: end, ms: Math.max(0, end - started), agent: call.from === 'agents' });
  }
  if (error) st.errors[call.station] += 1;
}

function startCall(st: SessionState, key: string, station: Station, label: string, from: 'core' | 'agents', sessionId: string, startedAt?: number) {
  if (st.running.has(key)) return;
  const at = startedAt ?? Date.now();
  const call: Call = { key, station, label, from, sessionId, startedAt: at };
  st.running.set(key, call);
  st.counts[station] += 1;
  if (from === 'agents' && station !== 'agents') st.counts.agents += 1;
  st.route.push({ station, at, from });
  if (st.route.length > 14) st.route = st.route.slice(-14);
  pulse(st, station, from, 'out');
  feedRow(st, { station, label, status: 'running', at, agent: from === 'agents' });
}

type ToolPart = {
  type?: string;
  id?: string;
  name?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    title?: string;
    metadata?: { title?: string } | Record<string, unknown>;
    time?: { created?: number; completed?: number };
  };
};

function processContent(sessionID: string, messageID: string, content: unknown) {
  ensureSession(sessionID, { lastAt: Date.now() });
  const top = topOf(sessionID);
  if (!top) return;
  const st = stateFor(top.id);
  const isSub = top.id !== sessionID;

  if (inboxSeen.has(messageID)) {
    // The user's message, written out. You already pulsed at delivery.
    return;
  }

  const parts = Array.isArray(content) ? (content as ToolPart[]) : [];
  if (fineGrained.has(sessionID)) {
    // This host emits session.tool.* events; content.updated only mirrors them.
    return;
  }
  if (!messageSeen.has(messageID)) {
    messageSeen.add(messageID);
    if (messageSeen.size > 400) {
      const drop = [...messageSeen].slice(0, 200);
      for (const d of drop) messageSeen.delete(d);
    }
    if (!isSub) {
      pulse(st, 'model', 'core', 'out');
      feedRow(st, { station: 'model', label: st.model ?? 'model', status: 'model', at: Date.now() });
    }
  }
  for (const p of parts) {
    if (p.type !== 'tool') continue;
    const status = p.state?.status ?? '';
    const key = p.id ?? `${messageID}#tool`;
    const tool = p.name ?? p.tool ?? 'tool';
    if (status === 'running' || status === 'pending') {
      if (st.running.has(key)) continue;
      const title = typeof p.state?.title === 'string' ? p.state.title
        : typeof (p.state?.metadata as { title?: string } | undefined)?.title === 'string' ? (p.state!.metadata as { title: string }).title
        : undefined;
      const { station, label } = classifyPart(tool, p.state?.input, title);
      const created = p.state?.time?.created;
      startCall(st, key, station, label, isSub ? 'agents' : 'core', sessionID, typeof created === 'number' ? created : undefined);
    } else if (status === 'completed' || status === 'error') {
      if (st.running.has(key)) {
        endCall(st, key, status === 'error', p.state?.time?.completed);
      } else if (!settledCalls.has(key)) {
        // A call that started and settled before we saw a `running` state.
        settledCalls.add(key);
        if (settledCalls.size > 400) for (const k of [...settledCalls].slice(0, 200)) settledCalls.delete(k);
        const title = typeof p.state?.title === 'string' ? p.state.title : undefined;
        const { station, label } = classifyPart(tool, p.state?.input, title);
        const created = p.state?.time?.created;
        const completed = p.state?.time?.completed;
        startCall(st, key, station, label, isSub ? 'agents' : 'core', sessionID, typeof created === 'number' ? created : undefined);
        endCall(st, key, status === 'error', typeof completed === 'number' ? completed : undefined);
      }
    }
    // `streaming` carries partial args only; wait for `running` to classify.
  }
  st.lastAt = Date.now();
  markDirty();
}

function sessionIdle(sessionID: string) {
  const info = sessions.get(sessionID);
  if (info) info.busy = false;
  const top = topOf(sessionID);
  if (!top) { markDirty(); return; }
  const st = stateFor(top.id);
  // Calls of this session (or its subs) still marked running are over.
  for (const [key, call] of [...st.running]) {
    if (call.sessionId === sessionID) endCall(st, key, false);
  }
  if (top.id === sessionID && !st.running.size) st.answerAt = Date.now();
  markDirty();
}

function handleEvent(evt: unknown) {
  const e = (evt ?? {}) as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type : '';
  const d = (e.data ?? e.properties ?? e.payload ?? {}) as Record<string, unknown>;
  if (typeof e.id === 'string') {
    if (seenEvents.has(e.id)) return;
    seenEvents.add(e.id);
    if (seenEvents.size > 600) for (const k of [...seenEvents].slice(0, 300)) seenEvents.delete(k);
  }
  eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

  const sid = typeof d.sessionID === 'string' ? d.sessionID
    : (typeof (d.session as { id?: string } | undefined)?.id === 'string' ? (d.session as { id: string }).id : '');
  const createdAt = typeof e.created === 'number' ? e.created : undefined;

  if (sid) tickBySession.set(sid, (tickBySession.get(sid) ?? 0) + 1);

  // Any event about a session teaches us the session (and its directory).
  if (sid && !sessions.has(sid)) {
    const loc = (e.location ?? {}) as { directory?: string };
    ensureSession(sid, {
      directory: typeof loc.directory === 'string' ? loc.directory : undefined,
      lastAt: createdAt ?? Date.now(),
    });
  }

  const endToolCall = (callId: unknown, error: boolean) => {
    if (!sid || typeof callId !== 'string') return;
    const top = topOf(sid);
    if (top) endCall(stateFor(top.id), `t:${callId}`, error, createdAt);
  };
  const titleOf = (v: unknown): string | undefined => {
    const rec = (v ?? {}) as { title?: unknown; name?: unknown };
    return typeof rec.title === 'string' ? rec.title : undefined;
  };

  switch (type) {
    case 'session.tool.input.started': {
      if (sid && typeof d.id === 'string' && typeof d.name === 'string') {
        fineGrained.add(sid);
        callTools.set(d.id, d.name);
        if (callTools.size > 400) for (const k of [...callTools.keys()].slice(0, 200)) callTools.delete(k);
      }
      break;
    }
    case 'session.tool.called': {
      if (!sid || typeof d.id !== 'string') break;
      const top = topOf(sid);
      if (!top) break;
      const st = stateFor(top.id);
      const key = `t:${d.id}`;
      if (st.running.has(key)) break;
      const name = callTools.get(d.id) ?? (d.native as { name?: string } | undefined)?.name ?? 'tool';
      const { station, label } = classifyPart(name, d.input, titleOf(d.native) ?? titleOf(d.metadata));
      startCall(st, key, station, label, top.id !== sid ? 'agents' : 'core', sid, createdAt);
      break;
    }
    case 'session.tool.success':
      endToolCall(d.id, false);
      break;
    case 'session.tool.failed':
      endToolCall(d.id, true);
      break;
    case 'session.usage.updated':
    case 'session.usage.recorded': {
      const tokens = (d.tokens ?? {}) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
      if (!sid) break;
      const top = topOf(sid);
      if (!top) break;
      const st = stateFor(top.id);
      const nums = [tokens.input, tokens.cache?.read, tokens.cache?.write].filter((v): v is number => typeof v === 'number');
      if (nums.length) st.usage = { used: nums.reduce((a, b) => a + b, 0), window: windowFor(st.model) };
      break;
    }
    case 'shell.created': {
      const info = (d.info ?? {}) as { id?: string; status?: string; command?: string; time?: { started?: number } };
      if (typeof info.id !== 'string' || info.status !== 'running') break;
      const owner = shellSession(d, e);
      if (!owner) break;
      ensureSession(owner, { lastAt: Date.now() });
      const { station, name } = classifyShell(typeof info.command === 'string' ? info.command : '');
      bgShells.set(info.id, { sessionId: owner, station, label: name, at: info.time?.started ?? Date.now() });
      break;
    }
    case 'shell.exited':
    case 'shell.deleted': {
      const info = (d.info ?? {}) as { id?: string; command?: string; status?: string; time?: { started?: number; completed?: number } };
      if (typeof info.id !== 'string') break;
      const shell = bgShells.get(info.id);
      bgShells.delete(info.id);
      if (!shell) break;
      const top = topOf(shell.sessionId);
      if (!top) break;
      const st = stateFor(top.id);
      const wasBackground = !sessions.get(shell.sessionId)?.busy && Date.now() - shell.at > 3000;
      if (wasBackground) {
        // The turn moved on and the command kept running: worth a row.
        pulse(st, shell.station, 'core', 'out');
        feedRow(st, { station: shell.station, label: `${shell.label} (bg)`, status: 'done', at: Date.now(), ms: Date.now() - shell.at });
      }
      break;
    }
    case 'session.step.started': {
      if (!sid) break;
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        pulse(st, 'model', 'core', 'out');
        st.lastAt = Date.now();
      }
      break;
    }
    case 'permission.asked': {
      if (!sid) break;
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        st.counts.you += 1;
        pulse(st, 'you', 'core', 'out');
        feedRow(st, { station: 'you', label: 'asked to approve', status: 'you', at: createdAt ?? Date.now() });
      }
      break;
    }
    case 'session.created': {
      if (!sid) break;
      const loc = (d.location ?? {}) as { directory?: string };
      const model = (d.model ?? {}) as { id?: string; providerID?: string };
      ensureSession(sid, {
        title: typeof d.title === 'string' ? d.title : typeof d.slug === 'string' ? d.slug : undefined,
        directory: typeof loc.directory === 'string' ? loc.directory : undefined,
        parentId: d.parentID === null || d.parentID === undefined ? undefined : String(d.parentID),
        lastAt: Date.now(),
      });
      const st = stateFor(topOf(sid)!.id);
      if (model.id && !st.model) st.model = model.id;
      break;
    }
    case 'session.inbox.delivered': {
      if (!sid) break;
      const inboxID = typeof d.inboxID === 'string' ? d.inboxID : '';
      if (inboxID) {
        inboxSeen.add(inboxID);
        if (inboxSeen.size > 300) for (const k of [...inboxSeen].slice(0, 150)) inboxSeen.delete(k);
      }
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        st.errors = zeroRecord();
        st.counts.you += 1;
        pulse(st, 'you', 'core', 'out');
        feedRow(st, { station: 'you', label: 'message', status: 'you', at: Date.now() });
        st.lastAt = Date.now();
        ensureSession(sid, { busy: true, lastAt: Date.now() });
      }
      break;
    }
    case 'session.message.content.updated': {
      const messageID = typeof d.messageID === 'string' ? d.messageID : '';
      if (sid && messageID) processContent(sid, messageID, d.content);
      break;
    }
    case 'session.status': {
      const status = (d.status ?? {}) as { type?: string };
      const t = status.type ?? '';
      if (!sid) break;
      if (t === 'busy' || t === 'retry') {
        ensureSession(sid, { busy: true, lastAt: Date.now() });
      } else if (t === 'idle') {
        sessionIdle(sid);
      }
      break;
    }
    case 'session.idle':
    case 'session.busy': {
      if (!sid) break;
      if (type === 'session.busy') ensureSession(sid, { busy: true, lastAt: Date.now() });
      else sessionIdle(sid);
      break;
    }
    case 'session.model.selected': {
      const model = (d.model ?? {}) as { id?: string };
      if (sid && model.id) {
        const top = topOf(sid);
        if (top) {
          const st = stateFor(top.id);
          if (st.model && st.model !== model.id) {
            st.modelFlashAt = Date.now();
            feedRow(st, { station: 'model', label: `${st.model} → ${model.id}`, status: 'change', at: Date.now() });
          }
          st.model = model.id;
        }
      }
      break;
    }
    case 'session.renamed': {
      if (sid && typeof d.title === 'string') ensureSession(sid, { title: d.title });
      break;
    }
    case 'session.deleted': {
      if (sid) sessions.delete(sid);
      break;
    }
    case 'session.execution.started': {
      if (sid) ensureSession(sid, { busy: true, lastAt: Date.now() });
      break;
    }
    case 'session.execution.succeeded': {
      if (sid) sessionIdle(sid);
      break;
    }
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      if (!sid) break;
      const top = topOf(sid);
      if (top && top.id === sid) {
        const st = stateFor(top.id);
        for (const key of [...st.running.keys()]) endCall(st, key, true);
        feedRow(st, { station: 'model', label: type === 'session.execution.failed' ? 'turn failed' : 'turn stopped', status: 'error', at: Date.now() });
      }
      sessionIdle(sid);
      break;
    }
    default:
      break;
  }
  markDirty();
}

let tickBySession = new Map<string, number>();

setInterval(() => {
  const watched = watchedSession();
  const children = [...sessions.values()].filter((s) => s.parentId);
  const busyChildren = children.filter((s) => s.busy);
  const bySession = [...tickBySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, n]) => `${id.slice(-8)}:${n}${sessions.get(id)?.title ? `(${sessions.get(id)!.title!.slice(0, 24)})` : ''}`)
    .join(' ');
  tickBySession = new Map();
  log('tick', { events: Object.fromEntries(eventCounts), sessions: sessions.size, watched: watched?.id ?? null, watchedTitle: watched?.title ?? null, subs: children.length, subsBusy: busyChildren.length, bySession, ocError: lastOcError });
  eventCounts.clear();
}, 10_000).unref?.();

// ---------------------------------------------------------------- opencode

async function ocGet(pathName: string): Promise<unknown | null> {
  if (!ocBase) return null;
  try {
    const res = await fetch(ocBase + pathName, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      ocError(`${pathName} → ${res.status} ${bodyText.slice(0, 120)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    ocError(`${pathName} → ${(err as Error).message}`);
    return null;
  }
}

function listOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const b = (body ?? {}) as Record<string, unknown>;
  for (const key of ['sessions', 'items', 'list', 'messages', 'data']) {
    if (Array.isArray(b[key])) return b[key] as unknown[];
  }
  return [];
}

async function refreshSessions() {
  const body = await ocGet('/api/session?limit=200');
  if (!body) return;
  const arr = listOf(body);
  const shape = Array.isArray(body) ? 'array' : Object.keys(body ?? {}).join(',');
  const first = arr[0] as Record<string, unknown> | undefined;
  log('sessions-read', { shape, count: arr.length, first: first ? Object.keys(first).slice(0, 12).join(',') : null });
  for (const raw of arr) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.id !== 'string') continue;
    const time = (s.time ?? s.updatedAt ?? {}) as { updated?: number; created?: number };
    const loc = (s.location ?? {}) as { directory?: string };
    ensureSession(s.id, {
      title: typeof s.title === 'string' ? s.title : undefined,
      directory: typeof s.directory === 'string' ? s.directory : typeof loc.directory === 'string' ? loc.directory : undefined,
      parentId: s.parentID === null || s.parentID === undefined ? undefined : String(s.parentID),
      lastAt: typeof time.updated === 'number' ? time.updated : undefined,
    });
  }
  markDirty();
}

async function reconcile() {
  await refreshSessions();
  const watched = watchedSession();
  if (!watched) return;
  const st = states.get(watched.id);
  if (!st || st.running.size === 0) return;
  const body = await ocGet(`/api/session/${encodeURIComponent(watched.id)}/message`);
  const liveKeys = new Set<string>();
  for (const raw of listOf(body)) {
    const m = (raw ?? {}) as { content?: ToolPart[]; type?: string };
    if (m.type !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p?.type === 'tool' && p.id) liveKeys.add(p.id);
    }
  }
  for (const key of [...st.running.keys()]) {
    if (!liveKeys.has(key)) endCall(st, key, false);
  }
}

let sseAbort: AbortController | null = null;
let sseRunning = false;

async function streamLoop() {
  if (sseRunning || !ocBase) return;
  sseRunning = true;
  log('sse-start');
  while (sseRunning) {
    sseAbort = new AbortController();
    try {
      const res = await fetch(`${ocBase}/api/event`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: sseAbort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
      log('sse-open');
      await refreshSessions();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const text = line.slice(5).trim();
            if (!text || text === '[DONE]') continue;
            try {
              handleEvent(JSON.parse(text));
            } catch {
              /* skip malformed frame */
            }
          }
        }
      }
      log('sse-end');
    } catch (err) {
      log('sse-error', { msg: (err as Error).message });
      ocError(`event stream: ${(err as Error).message}`);
    }
    if (!sseRunning) break;
    await new Promise((r) => setTimeout(r, 800));
    await reconcile().catch(() => {});
  }
}

setInterval(() => { void pruneState(); void refreshSessions().catch(() => {}); }, 30_000).unref?.();

// ---------------------------------------------------------------- snapshot

function foldFeed(feed: FeedRow[]): FeedRow[] {
  const rows = feed.slice(-16);
  const out: FeedRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (
      last && row.status === 'done' && last.status === 'done'
      && last.station === row.station && last.folded === undefined
      && last.label === row.label
    ) {
      out[out.length - 1] = { ...last, folded: (last.folded ?? 0) + 1 };
      continue;
    }
    out.push(row);
  }
  const running = out.filter((r) => r.status === 'running');
  if (running.length === 0) return out;
  const limit = Math.max(8, 16 - running.length);
  const shown = out.filter((r, i) => r.status === 'running' || i >= out.length - limit);
  return shown.slice(-16);
}

function snapshot() {
  const watched = watchedSession();
  pruneState();
  const st = watched ? stateFor(watched.id) : null;
  const subagents = watched ? [...sessions.values()].filter((s) => s.busy && topOf(s.id)?.id === watched.id && s.id !== watched.id) : [];
  const runningByStation: Partial<Record<Station, number>> = {};
  if (st) for (const c of st.running.values()) runningByStation[c.station] = (runningByStation[c.station] ?? 0) + 1;
  // Background shells: still running after their session's turn ended.
  const bg = watched
    ? [...bgShells.values()].filter((b) => topOf(b.sessionId)?.id === watched.id && !sessions.get(b.sessionId)?.busy)
    : [];
  for (const b of bg) runningByStation[b.station] = (runningByStation[b.station] ?? 0) + 1;
  const tops = [...sessions.values()].filter((s) => !s.parentId).sort((a, b) => b.lastAt - a.lastAt).slice(0, 12);
  let feed = st ? foldFeed(st.feed) : [];
  if (st && bg.length > 0) {
    const earliest = Math.min(...bg.map((b) => b.at));
    feed = [...feed, {
      id: -1,
      station: bg[0].station,
      label: bg.length > 1 ? `${bg.length} background tasks` : `${bg[0].label} (bg)`,
      status: 'running',
      at: earliest,
    }].slice(-16);
  }
  return {
    ok: true,
    opencode: Boolean(ocBase),
    debug: lastOcError,
    watch: watched
      ? { sessionId: watched.id, title: (watched.title ?? watched.id).slice(0, 60), directory: watched.directory ?? null, busy: watched.busy, model: st?.model ?? null }
      : null,
    watchMode,
    sessions: tops.map((s) => ({ id: s.id, title: (s.title ?? s.id).slice(0, 60), directory: s.directory ?? null, busy: s.busy })),
    stations: st
      ? Object.fromEntries(STATIONS.map((k) => [k, { used: st.counts[k], running: runningByStation[k] ?? 0, errors: st.errors[k] }]))
      : Object.fromEntries(STATIONS.map((k) => [k, { used: 0, running: 0, errors: 0 }])),
    feed,
    route: st ? st.route.slice(-12) : [],
    subagents: subagents.map((s) => s.id),
    bg: bg.length,
    answerAt: st?.answerAt ?? null,
    modelFlashAt: st?.modelFlashAt ?? null,
    context: st?.usage ? { used: st.usage.used, window: st.usage.window, pct: Math.min(100, Math.round((st.usage.used / st.usage.window) * 100)) } : null,
    pulses: st ? st.pulses.slice(-60) : [],
    now: Date.now(),
  };
}

function statusRows() {
  const snap = snapshot();
  if (!snap.opencode) {
    return { rows: [{ kind: 'note', id: 'oc', text: 'This host cannot provide OpenCode access yet.', tone: 'warning' }] };
  }
  if (!snap.watch) {
    const text = snap.debug
      ? `No session seen yet. OpenCode read failed: ${String(snap.debug).slice(0, 100)}`
      : 'No session yet. Work in a session and the map lights up.';
    return { rows: [{ kind: 'note', id: 'empty', text, tone: snap.debug ? 'error' : 'default' }] };
  }
  const running = Object.entries(snap.stations).filter(([, v]) => (v as { running: number }).running > 0);
  let now: string;
  if (running.length > 0) {
    now = running.map(([k, v]) => `${k} ×${(v as { running: number }).running}`).join(', ');
  } else if (snap.subagents.length > 0) {
    now = `${snap.subagents.length} agent${snap.subagents.length > 1 ? 's' : ''} at work`;
  } else if (snap.watch.busy) {
    now = 'model thinking';
  } else {
    now = 'idle';
  }
  const errors = Object.values(snap.stations).reduce((a, v) => a + (v as { errors: number }).errors, 0);
  return {
    rows: [
      { kind: 'line', id: 'watch', label: 'Session', value: snap.watch.title.slice(0, 40), dot: snap.watch.busy ? 'accent' : 'success' } as Record<string, unknown>,
      { kind: 'line', id: 'now', label: 'Now', value: now.slice(0, 80), dot: errors > 0 ? 'error' : undefined } as Record<string, unknown>,
      { kind: 'note', id: 'map', text: 'Open the Work map panel on the rail for the live map.' } as Record<string, unknown>,
    ],
  };
}

// ---------------------------------------------------------------- emit

let emitDirty = false;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let lastEmit = 0;
let lastEmitErrorLog = 0;
let emitHealthy = false;

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
  if (!emitDirty) return;
  emitDirty = false;
  lastEmit = Date.now();
  void host.emit('map', snapshot()).then(() => {
    if (!emitHealthy) {
      emitHealthy = true;
      log('emit-ok', {});
    }
  }, (err) => {
    if (Date.now() - lastEmitErrorLog > 30_000) {
      lastEmitErrorLog = Date.now();
      log('emit-error', { msg: (err as Error).message });
    }
  });
}

// ---------------------------------------------------------------- http

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function route(req: http.IncomingMessage, res: http.ServerResponse, pathName: string, query: URLSearchParams, body: string) {
  if (pathName === '/health') { json(res, 200, {}); return; }
  if (pathName === '/state' && req.method === 'GET') { void query; json(res, 200, snapshot()); return; }
  if (pathName === '/context' && req.method === 'POST') {
    try {
      const data = JSON.parse(body || '{}') as { directory?: string | null; sessionId?: string | null };
      directoryHint = data.directory ?? null;
      if (data.sessionId !== undefined) {
        focusSessionId = data.sessionId ?? null;
        focusAt = Date.now();
        // A focused session we have not met yet still wins Auto: make it known
        // so the map lands on it at once; the session list fills in the rest.
        if (focusSessionId && !sessions.has(focusSessionId)) ensureSession(focusSessionId, { lastAt: Date.now() });
      }
    } catch { /* ignore */ }
    markDirty();
    json(res, 200, snapshot());
    return;
  }
  if (pathName === '/watch' && req.method === 'POST') {
    try {
      const data = JSON.parse(body || '{}') as { sessionId?: string | null };
      if (data.sessionId) { watchMode = 'fixed'; watchFixed = data.sessionId; }
      else { watchMode = 'auto'; watchFixed = null; }
    } catch { /* ignore */ }
    markDirty();
    json(res, 200, snapshot());
    return;
  }
  if (pathName === '/status') {
    if (req.method === 'GET') {
      // The Work Status section sits in the focused project's window; a read
      // keeps that project's directory as the hint while someone looks at it.
      const dir = query.get('directory');
      if (dir) directoryHint = dir;
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
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    route(req, res, url.pathname, url.searchParams, body).catch((err) => {
      log('http-error', { msg: (err as Error).message });
      if (!res.headersSent) res.writeHead(500).end('{}');
    });
  });
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0) || 4599, '127.0.0.1', () => {
  void refreshSessions().then(() => streamLoop()).catch((err) => log('start-error', { msg: (err as Error).message }));
});
