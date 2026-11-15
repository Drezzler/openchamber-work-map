// Smoke test: start fake OpenCode + the service, drive requests, assert on /state.
import { spawn } from 'node:child_process';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = spawn(process.execPath, ['scripts/fake-opencode.mjs'], { stdio: 'pipe' });
let fakeDied = '';
fake.on('exit', (code) => { if (code !== null && code !== 0) fakeDied = `fake exited ${code} (port 4601 held?)`; });
const svc = spawn(process.execPath, ['service/main.js'], {
  stdio: 'pipe',
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: '4599',
    OPENCHAMBER_SERVICE_TOKEN: 't',
    OPENCHAMBER_OPENCODE_URL: 'http://127.0.0.1:4601',
  },
});
let svcDied = '';
svc.on('exit', (code) => { if (code !== null && code !== 0) svcDied = `service exited ${code} (port 4599 held by a zombie?)`; });

const failures = [];
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures.push(name);
};

const call = async (path, method = 'GET', body) => {
  const res = await fetch(`http://127.0.0.1:4599${path}`, {
    method,
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body,
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
};

try {
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i += 1) {
    await wait(250);
    if (svcDied || fakeDied) break;
    try {
      const r = await fetch('http://127.0.0.1:4599/health', { headers: { Authorization: 'Bearer t' } });
      healthy = r.status === 200;
    } catch { /* not up yet */ }
  }
  if (svcDied || fakeDied) {
    console.log(`FAIL  startup: ${svcDied || fakeDied}`);
    process.exit(1);
  }
  check('health answers 200', healthy);

  const noAuth = await fetch('http://127.0.0.1:4599/health');
  check('missing bearer rejected', noAuth.status === 401);

  await wait(1500); // service boot
  // Wait until the replay has landed and settled (Windows timers pace it variably).
  let stable = '';
  for (let i = 0; i < 24; i += 1) {
    await wait(500);
    const probe = await call('/state');
    const sig = JSON.stringify(probe.json?.feed?.map((r) => [r.label, r.status]));
    const settled = probe.json?.bg === 0 && !probe.json?.feed?.some((r) => r.status === 'running');
    if (sig === stable && probe.json?.feed?.length >= 8 && settled) break;
    stable = sig;
  }

  const state = await call('/state');
  check('state 200', state.status === 200);
  const s = state.json ?? {};
  check('watched session is ses_top', s.watch?.sessionId === 'ses_top');
  check('curl lights network', s.stations?.network?.used >= 1);
  check('read+edit light files', s.stations?.files?.used >= 2);
  check('subagent work lights agents', s.stations?.agents?.used >= 1);
  check('feed marks subagent rows', s.feed.some((r) => r.agent === true));
  check('fine-grained subagent call attributed', s.feed.some((r) => r.agent === true && r.station === 'network' && r.status === 'done'));
  check('edit error counted', (s.stations?.files?.errors ?? 0) >= 1);
  check('nothing running after idle', Object.values(s.stations ?? {}).every((v) => v.running === 0));
  check('feed has rows', Array.isArray(s.feed) && s.feed.length >= 5);
  check('feed keeps error row', s.feed.some((r) => r.status === 'error'));
  check('route recorded', Array.isArray(s.route) && s.route.length >= 3);
  check('pulses recorded', Array.isArray(s.pulses) && s.pulses.length >= 6);
  check('model captured', s.watch?.model === 'glm-5.3-air');
  check('model change row', s.feed.some((r) => r.status === 'change'));
  check('model flash recorded', typeof s.modelFlashAt === 'number');
  check('context ring computed', typeof s.context?.pct === 'number' && s.context.pct >= 50 && s.context.pct <= 100);
  check('memory read lights Memory', (s.stations?.memory?.used ?? 0) >= 1);
  check('background shell rowed on exit', s.feed.some((r) => r.label.includes('(bg)')));
  check('user message pulsed You', s.stations?.you?.used >= 1);
  check('fine-grained curl call completed', s.feed.some((r) => r.station === 'network' && r.status === 'done'));
  check('permission ask rowed', s.feed.some((r) => r.station === 'you' && r.label === 'asked to approve'));
  check('answer ring fired', typeof s.answerAt === 'number');
  check('sessions listed for picker', (s.sessions ?? []).some((x) => x.id === 'ses_top'));

  const status = await call('/status');
  check('status section 200', status.status === 200);
  const rows = status.json?.rows ?? [];
  check('status rows parse', Array.isArray(rows) && rows.length >= 2 && rows.every((r) => r.id && r.kind));

  const ctx = await call('/context', 'POST', JSON.stringify({ directory: 'd:/prog/repo', sessionId: 'ses_top' }));
  check('context accepted', ctx.status === 200 && ctx.json?.watch?.sessionId === 'ses_top');

  const focus = await call('/context', 'POST', JSON.stringify({ directory: 'd:/elsewhere', sessionId: 'ses_other' }));
  check('auto follows focus over busy', focus.json?.watch?.sessionId === 'ses_other');

  const unpin = await call('/watch', 'POST', JSON.stringify({ sessionId: null }));
  check('focus survives unpinned auto', unpin.json?.watch?.sessionId === 'ses_other');

  const watch = await call('/watch', 'POST', JSON.stringify({ sessionId: 'ses_top' }));
  check('watch accepted', watch.status === 200 && watch.json?.watchMode === 'fixed');

  const gone = await call('/nope');
  check('unknown route 404', gone.status === 404);
} finally {
  svc.kill();
  fake.kill();
  await wait(400);
}

console.log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
