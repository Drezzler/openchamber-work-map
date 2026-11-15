// Work map panel: draws the map (centre + stations) from service snapshots.
import { connectHost } from '@openchamber/sdk';
import type { HostRequestError } from '@openchamber/sdk';
import { applyHostReady, mountSelect, mountEmpty, mountBanner, mountTextField } from '@openchamber/sdk/ui';

type Station = 'you' | 'model' | 'memory' | 'files' | 'shell' | 'network' | 'browser' | 'agents' | 'skills';

const RING: Station[] = ['you', 'skills', 'agents', 'browser', 'network', 'shell', 'files', 'memory', 'model'];
const LABEL: Record<Station, string> = {
  you: 'You', model: 'Model', memory: 'Memory', files: 'Files', shell: 'Shell',
  network: 'Network', browser: 'Browser', agents: 'Agents', skills: 'Skills',
};

type Options = { layout: 'you-top' | 'you-bottom'; motion: 'full' | 'reduced'; accent: string; memory: string };
let options: Options = { layout: 'you-top', motion: 'full', accent: '', memory: '' };

type Snapshot = {
  ok: boolean;
  opencode: boolean;
  watch: { sessionId: string; title: string; directory: string | null; busy: boolean; model: string | null } | null;
  watchMode: 'auto' | 'fixed';
  sessions: { id: string; title: string; directory: string | null; busy: boolean }[];
  stations: Record<Station, { used: number; running: number; errors: number }>;
  feed: { id: number; station: Station; label: string; status: string; at: number; ms?: number; agent?: boolean; folded?: number }[];
  route: { station: Station; at: number; from: string }[];
  subagents: string[];
  bg: number;
  answerAt: number | null;
  modelFlashAt: number | null;
  context: { used: number; window: number; pct: number } | null;
  pulses: { id: number; station: Station; from: string; dir: 'out' | 'in'; error: boolean; at: number }[];
  now: number;
};

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let snap: Snapshot | null = null;
let lastPulseId = 0;
let lastWatchId: string | null = null;
let gotEmit = false;
const anims: { id: number; station: Station; from: string; dir: 'out' | 'in'; error: boolean; born: number }[] = [];

// --- palette (recomputed on theme change) ---
let palette = { accent: '#7aa2f7', fg: '#e6edf3', muted: '#8b949e', error: '#f85149', ok: '#3fb950', card: '#161b22', memory: '#b58bf5', warn: '#d29922' };
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (names: string[], fallback: string) => {
    for (const n of names) {
      const v = cs.getPropertyValue(n).trim();
      if (v) return v;
    }
    return fallback;
  };
  palette = {
    accent: options.accent || pick(['--oc-primary', '--primary'], palette.accent),
    fg: pick(['--oc-foreground', '--foreground'], palette.fg),
    muted: pick(['--oc-muted-foreground', '--muted-foreground'], palette.muted),
    error: pick(['--oc-destructive', '--destructive', '--oc-error'], palette.error),
    ok: pick(['--oc-success', '--success'], palette.ok),
    card: pick(['--oc-card', '--card'], palette.card),
    memory: options.memory || pick(['--oc-info'], palette.memory),
    warn: pick(['--oc-warning', '--warning'], palette.warn),
  };
}

// --- layout ---
let mounted = false;
let currentDirectory: string | null = null;
let currentSessionId: string | null = null;

function sendContext() {
  void request('/context', 'POST', JSON.stringify({ directory: currentDirectory, sessionId: currentSessionId })).then((next) => {
    if (next) apply(next);
  });
}
let header!: HTMLElement;
let mapWrap!: HTMLElement;
let canvas!: HTMLCanvasElement;
let nowLine!: HTMLElement;
let feedEl!: HTMLElement;
let messageEl!: HTMLElement;
let optionsEl!: HTMLElement;
let selectHandle: { update: (p: Record<string, unknown>) => void } | null = null;
let emptyHandle: { dispose: () => void } | null = null;
let feedSig = '';

function build() {
  header = document.createElement('div');
  header.className = 'map-header';
  mapWrap = document.createElement('div');
  mapWrap.className = 'map-wrap';
  canvas = document.createElement('canvas');
  mapWrap.appendChild(canvas);
  nowLine = document.createElement('div');
  nowLine.className = 'now-line';
  feedEl = document.createElement('div');
  feedEl.className = 'feed';
  messageEl = document.createElement('div');
  optionsEl = document.createElement('div');
  optionsEl.className = 'map-options';
  root.append(header, mapWrap, nowLine, feedEl, optionsEl, messageEl);
  const ro = new ResizeObserver(() => sizeCanvas());
  ro.observe(mapWrap);
  sizeCanvas();
  requestAnimationFrame(draw);
  setInterval(renderFeed, 1000);
}

function sizeCanvas() {
  const w = Math.max(220, Math.min(mapWrap.clientWidth || 320, 400));
  const h = Math.round(w * 0.86);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

// --- geometry ---
function geom() {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const cx = w / 2;
  const cy = h * 0.52;
  const r = Math.min(w, h) * 0.38;
  const flip = options.layout === 'you-bottom' ? Math.PI : 0;
  const pos = new Map<Station, { x: number; y: number; a: number }>();
  RING.forEach((s, i) => {
    const a = -Math.PI / 2 + flip + (i * 2 * Math.PI) / RING.length;
    pos.set(s, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), a });
  });
  return { w, h, cx, cy, r, pos };
}

function draw(ts: number) {
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (snap?.watch) drawMap(ctx, ts ?? performance.now());
  }
  requestAnimationFrame(draw);
}

function drawMap(ctx: CanvasRenderingContext2D, now: number) {
  const g = geom();
  const st = snap!.stations;
  const nowMs = Date.now();

  // spokes (worn with use); the memory spoke has a colour of its own
  for (const s of RING) {
    const p = g.pos.get(s)!;
    const used = st[s]?.used ?? 0;
    const width = Math.min(1 + used * 0.12, 3.5);
    const alpha = 0.22 + Math.min(used, 20) / 20 * 0.45;
    const color = s === 'memory' ? palette.memory : palette.fg;
    ctx.strokeStyle = withAlpha(s === 'agents' && (snap!.subagents.length || st.agents.running) ? palette.accent : color, alpha);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(g.cx, g.cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // route: the last legs the work went through, fading
  const route = snap!.route.filter((r) => nowMs - r.at < 60_000);
  if (route.length > 1) {
    ctx.lineWidth = 1;
    for (let i = 1; i < route.length; i += 1) {
      const a = g.pos.get(route[i - 1].station);
      const b = g.pos.get(route[i].station);
      if (!a || !b || route[i - 1].station === 'model' || route[i].station === 'model') continue;
      const age = nowMs - route[i].at;
      const alpha = age < 40_000 ? 0.55 : Math.max(0, 0.55 * (1 - (age - 40_000) / 20_000));
      if (alpha <= 0.02) continue;
      ctx.strokeStyle = withAlpha(palette.accent, alpha);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // pulses
  for (let i = anims.length - 1; i >= 0; i -= 1) {
    const a = anims[i];
    const t = (now - a.born) / 650;
    if (t >= 1) { anims.splice(i, 1); continue; }
    const p = g.pos.get(a.station);
    if (!p) continue;
    const origin = a.from === 'agents' ? g.pos.get('agents')! : { x: g.cx, y: g.cy };
    const k = a.dir === 'out' ? t : 1 - t;
    const x = origin.x + (p.x - origin.x) * k;
    const y = origin.y + (p.y - origin.y) * k;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = a.error ? palette.error : palette.accent;
    ctx.fill();
  }

  // answer ring
  if (snap!.answerAt && nowMs - snap!.answerAt < 1400) {
    const t = (nowMs - snap!.answerAt) / 1400;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, 16 + t * g.r * 0.9, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(palette.ok, 0.6 * (1 - t));
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // stations
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const s of RING) {
    const p = g.pos.get(s)!;
    const d = st[s] ?? { used: 0, running: 0, errors: 0 };
    const active = d.running > 0;
    // clock hands while running (they stay in reduced motion, slowed like a clock's)
    if (active) {
      const slow = options.motion === 'reduced' ? 0.35 : 1;
      const t = (nowMs / 1000) * slow;
      for (const [len, period] of [[9, 60], [13, 600]] as [number, number][]) {
        const ang = ((t % period) / period) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = withAlpha(s === 'memory' ? palette.memory : palette.accent, 0.85);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + len * Math.cos(ang), p.y + len * Math.sin(ang));
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = palette.card;
    ctx.fill();
    ctx.strokeStyle = d.errors > 0 ? palette.error : active ? (s === 'memory' ? palette.memory : palette.accent) : withAlpha(palette.fg, 0.5);
    ctx.lineWidth = active ? 2 : 1.2;
    ctx.stroke();
    if (active) {
      const breath = options.motion === 'reduced' ? 3 : 2 + Math.sin(nowMs / 300) * 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 15 + breath, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(s === 'memory' ? palette.memory : palette.accent, 0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // label (+ concurrent, + error count)
    let text = LABEL[s];
    if (d.running > 1) text += ` ×${d.running}`;
    if (d.errors > 0) text += ` !${d.errors}`;
    ctx.fillStyle = d.errors > 0 ? palette.error : active ? palette.fg : palette.muted;
    const ly = p.a >= -Math.PI / 2 - 0.1 && p.a <= Math.PI / 2 + 0.1 ? p.y + 24 : p.y - 17;
    ctx.fillText(text, p.x, ly);

    // subagent dots circle the Agents station (stand beside it in reduced motion)
    if (s === 'agents' && snap!.subagents.length > 0) {
      snap!.subagents.forEach((_, i) => {
        const ang = options.motion === 'reduced'
          ? -0.5 + (i * Math.PI) / Math.max(1, snap!.subagents.length - 1 || 1)
          : nowMs / 4000 + (i * Math.PI * 2) / snap!.subagents.length;
        ctx.beginPath();
        ctx.arc(p.x + 20 * Math.cos(ang), p.y + 20 * Math.sin(ang), 2.2, 0, Math.PI * 2);
        ctx.fillStyle = palette.accent;
        ctx.fill();
      });
    }
  }

  // a change of model rings the centre and the Model station for a moment
  if (snap!.modelFlashAt && nowMs - snap!.modelFlashAt < 3000) {
    const alpha = 0.7 * (1 - (nowMs - snap!.modelFlashAt) / 3000);
    const mp = g.pos.get('model')!;
    for (const [x, y, r] of [[g.cx, g.cy, 26], [mp.x, mp.y, 16]] as [number, number, number][]) {
      ctx.beginPath();
      ctx.arc(x, y, r + 2, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(palette.accent, alpha);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // centre: the context window fills a ring around it
  const model = snap!.watch?.model;
  const core = model ? model.split('/').pop()!.slice(0, 10) : 'AGENT';
  const busy = snap!.watch?.busy;
  const ctxRing = snap!.context;
  if (ctxRing && ctxRing.pct > 0) {
    const ringColor = ctxRing.pct >= 90 ? palette.error : ctxRing.pct >= 70 ? palette.warn : withAlpha(palette.fg, 0.55);
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, 22, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, ctxRing.pct) / 100) * Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = ctxRing.pct >= 70 ? ringColor : palette.muted;
    ctx.fillText(`${ctxRing.pct}%`, g.cx, g.cy - 27);
  }
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, 17 + (busy && options.motion !== 'reduced' ? Math.sin(nowMs / 700) * 1.5 : 0), 0, Math.PI * 2);
  ctx.fillStyle = palette.card;
  ctx.fill();
  ctx.strokeStyle = busy ? palette.accent : withAlpha(palette.fg, 0.6);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = palette.fg;
  ctx.font = 'bold 9px ui-monospace, monospace';
  ctx.fillText(core.toUpperCase(), g.cx, g.cy + 3);
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    let r = 0; let g = 0; let b = 0;
    if (color.length === 7) {
      r = parseInt(color.slice(1, 3), 16);
      g = parseInt(color.slice(3, 5), 16);
      b = parseInt(color.slice(5, 7), 16);
    } else {
      r = parseInt(color[1] + color[1], 16);
      g = parseInt(color[2] + color[2], 16);
      b = parseInt(color[3] + color[3], 16);
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

// --- feed ---
function fmtMs(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 150) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}`;
}

const SYM: Record<string, string> = { running: '●', done: '·', error: '✕', you: '›', change: '◆' };

let openRowId: number | null = null;

function renderFeed() {
  if (!snap || !snap.watch) { feedEl.replaceChildren(); feedSig = ''; return; }
  const rows = snap.feed;
  const sig = JSON.stringify([rows.map((r) => [r.id, r.status, r.ms, r.folded]), openRowId]);
  const liveRunning = rows.some((r) => r.status === 'running');
  if (sig === feedSig && !liveRunning) return;
  feedSig = sig;
  feedEl.replaceChildren(...rows.map((r) => {
    const row = document.createElement('div');
    row.className = `feed-row ${r.status}${r.id === openRowId ? ' open' : ''}`;
    const expandable = r.label.length > 34;
    if (expandable || r.id === openRowId) {
      row.classList.add('expandable');
      row.addEventListener('click', () => {
        openRowId = openRowId === r.id ? null : r.id; // one row open at a time
        feedSig = '';
        renderFeed();
      });
    }
    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.textContent = SYM[r.status] ?? '·';
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = r.agent ? `⌘ ${r.label}` : r.label;
    const time = document.createElement('span');
    time.className = 'time';
    const marker = expandable || r.id === openRowId ? (r.id === openRowId ? '▾ ' : '▸ ') : '';
    time.textContent = marker + (r.status === 'running' ? fmtMs(Date.now() - r.at) : fmtMs(r.ms));
    row.append(sym, label, time);
    if (r.folded) {
      const fold = document.createElement('span');
      fold.className = 'fold';
      fold.textContent = `+${r.folded}`;
      row.append(fold);
    }
    row.title = `${LABEL[r.station]}${r.agent ? ' · subagent' : ''}`;
    return row;
  }));
  renderNow(rows);
}

function renderNow(rows: Snapshot['feed']) {
  const running = rows.filter((r) => r.status === 'running');
  let text: string;
  if (running.length) text = running.map((r) => r.label).join(' · ');
  else if (snap!.subagents.length) text = `${snap!.subagents.length} agent${snap!.subagents.length > 1 ? 's' : ''} at work`;
  else if (snap!.watch?.busy) text = 'model thinking';
  else text = 'idle';
  if (snap!.bg > 0) text += ` · bg ×${snap!.bg}`;
  nowLine.textContent = text;
  nowLine.className = `now-line${running.length || snap!.watch?.busy ? ' live' : ''}`;
}

// --- state application ---
function apply(next: Snapshot) {
  const watchChanged = next.watch?.sessionId !== lastWatchId;
  lastWatchId = next.watch?.sessionId ?? null;
  if (watchChanged) lastPulseId = 0; // pulses are per-session; don't gate a new map by the old one's ids
  snap = next;
  for (const p of next.pulses) {
    if (options.motion !== 'reduced' && p.id > lastPulseId && Date.now() - p.at < 2500) {
      anims.push({ id: p.id, station: p.station, from: p.from, dir: p.dir, error: p.error, born: performance.now() });
    }
    if (p.id > lastPulseId) lastPulseId = p.id;
  }
  if (selectHandle) {
    const value = next.watchMode === 'fixed' && next.watch ? next.watch.sessionId : 'auto';
    selectHandle.update({
      value,
      options: [
        { id: 'auto', label: 'Auto · follows the session in focus' },
        ...next.sessions.map((s) => ({ id: s.id, label: `${s.title}${s.busy ? ' ·' : ''}`, hint: s.directory ?? undefined })),
      ],
    });
  }
  renderFeed();
  renderEmpty();
}

function renderEmpty() {
  const has = Boolean(snap?.watch);
  const oc = snap?.opencode ?? true;
  mapWrap.style.display = has ? '' : 'none';
  nowLine.style.display = has ? '' : 'none';
  feedEl.style.display = has ? '' : 'none';
  if (has) {
    emptyHandle?.dispose();
    emptyHandle = null;
    return;
  }
  if (emptyHandle) return;
  const holder = document.createElement('div');
  messageEl.appendChild(holder);
  emptyHandle = mountEmpty(holder, oc
    ? { title: 'The map is quiet', body: 'Work in a session and the map lights up here.' }
    : { title: 'No OpenCode access', body: 'This host cannot provide the read-only OpenCode connection the map needs.' });
}

async function request(path: string, method = 'GET', body?: string): Promise<Snapshot | null> {
  try {
    const res = await host.serviceRequest({ method, path, body });
    if (res.status !== 200) return null;
    return JSON.parse(res.body || '{}') as Snapshot;
  } catch (err) {
    const code = (err as HostRequestError)?.code ?? '';
    if (code) {
      messageEl.replaceChildren();
      const holder = document.createElement('div');
      messageEl.appendChild(holder);
      mountBanner(holder, {
        tone: 'warning',
        title: 'The Work map service is not allowed yet',
        body: 'Open Settings → Extensions, allow this extension, then reopen the panel.',
      });
    }
    return null;
  }
}

function persistOptions() {
  void host.storage.set('map-options', options as unknown as Record<string, unknown>).catch(() => {});
  readPalette();
}

function mountOptions() {
  const wrap1 = document.createElement('div');
  const wrap2 = document.createElement('div');
  const wrap3 = document.createElement('div');
  const wrap4 = document.createElement('div');
  optionsEl.append(wrap1, wrap2, wrap3, wrap4);
  const layoutSel = mountSelect(wrap1, {
    value: options.layout,
    options: [{ id: 'you-top', label: 'You at top' }, { id: 'you-bottom', label: 'You at bottom' }],
    onChange: (id) => { options.layout = id as Options['layout']; layoutSel.update({ value: id }); persistOptions(); },
  });
  const motionSel = mountSelect(wrap2, {
    value: options.motion,
    options: [{ id: 'full', label: 'Full motion' }, { id: 'reduced', label: 'Reduced motion' }],
    onChange: (id) => { options.motion = id as Options['motion']; motionSel.update({ value: id }); anims.length = 0; persistOptions(); },
  });
  mountTextField(wrap3, {
    value: options.accent,
    placeholder: '#7aa2f7',
    label: 'Accent',
    mono: true,
    onChange: (v) => { options.accent = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : ''; persistOptions(); },
  });
  mountTextField(wrap4, {
    value: options.memory,
    placeholder: '#b58bf5',
    label: 'Memory',
    mono: true,
    onChange: (v) => { options.memory = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : ''; persistOptions(); },
  });
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  readPalette();
  if (mounted) return;
  mounted = true;
  build();
  void host.storage.get('map-options').then((saved) => {
    if (saved && typeof saved === 'object') {
      const s = saved as Partial<Options>;
      if (s.layout === 'you-bottom' || s.layout === 'you-top') options.layout = s.layout;
      if (s.motion === 'reduced' || s.motion === 'full') options.motion = s.motion;
      if (typeof s.accent === 'string') options.accent = s.accent;
      if (typeof s.memory === 'string') options.memory = s.memory;
    }
    readPalette();
    mountOptions();
  }).catch(() => mountOptions());
  selectHandle = mountSelect(header, {
    value: 'auto',
    options: [{ id: 'auto', label: 'Auto · follows the session in focus' }],
    onChange: (id) => {
      void request('/watch', 'POST', JSON.stringify({ sessionId: id === 'auto' ? null : id })).then((next) => {
        if (next) apply(next);
      });
    },
  });
  // Auto follows focus: tell the service which chat this window is on.
  host.onSession((session) => {
    const id = (session as { id?: string } | null)?.id ?? null;
    if (id !== currentSessionId) {
      currentSessionId = id;
      sendContext();
    }
  });
  host.onDirectory((directory) => {
    if (directory !== currentDirectory) {
      currentDirectory = directory;
      sendContext();
    }
  });
  void (async () => {
    currentDirectory = ctx.directory ?? null;
    currentSessionId = (ctx.session as { id?: string } | null | undefined)?.id ?? null;
    sendContext();
    const first = await request('/state');
    if (first) apply(first);
  })();
  host.onServiceEvent((event) => {
    if (event.topic === 'map' && event.data) {
      gotEmit = true;
      apply(event.data as Snapshot);
    }
  });
  // Until the first push arrives, fall back to a quiet poll; stops for good
  // once the service's emits reach this frame.
  const poll = setInterval(() => {
    if (gotEmit) { clearInterval(poll); return; }
    if (document.hidden) return;
    void request('/state').then((next) => { if (next) apply(next); });
  }, 1500);
  // Keep the service's focus fresh: it restarts on rebuilds and forgets, and
  // the focus grant lapses after ten minutes without a heartbeat.
  setInterval(() => { if (!document.hidden) sendContext(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendContext(); });
});
