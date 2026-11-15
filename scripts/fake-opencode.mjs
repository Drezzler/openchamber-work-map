// Fake read-only OpenCode 2.x server for the smoke test: a session list and an
// SSE stream speaking the real wire ({ id, created, type, data } envelopes).
import http from 'node:http';

let seq = 0;
const ev = (type, data) => `data: ${JSON.stringify({ id: `evt_${seq++}`, created: Date.now(), type, data })}`;
const evLoc = (type, data, directory) => `data: ${JSON.stringify({ id: `evt_${seq++}`, created: Date.now(), type, data, location: { directory } })}`;

const events = [];
const PAUSE = (ms) => ({ __pause: ms });
// Top session appears (created), user message delivered, model answers.
events.push(ev('session.created', {
  sessionID: 'ses_top', projectID: 'p1',
  location: { directory: 'd:/prog/repo' },
  slug: 'fix-the-parser', title: 'Fix the parser',
  model: { id: 'glm-5.3', providerID: 'zai' },
}));
events.push(ev('session.inbox.delivered', { sessionID: 'ses_top', inboxID: 'msg_user' }));
events.push(ev('session.status', { sessionID: 'ses_top', status: { type: 'busy' } }));
// Assistant message: text first, then a curl call via the fine-grained tool events.
events.push(ev('session.message.content.updated', { sessionID: 'ses_top', messageID: 'msg_a1', content: [{ type: 'text', text: 'on it' }] }));
events.push(ev('session.step.started', { sessionID: 'ses_top', assistantMessageID: 'msg_a1' }));
events.push(ev('session.tool.input.started', { sessionID: 'ses_top', assistantMessageID: 'msg_a1', id: 'call-1', name: 'bash' }));
events.push(ev('session.tool.called', { sessionID: 'ses_top', assistantMessageID: 'msg_a1', id: 'call-1', input: { command: 'curl -s https://registry.example.com/health' }, executed: true }));
events.push(ev('session.tool.success', { sessionID: 'ses_top', assistantMessageID: 'msg_a1', id: 'call-1', content: [{ type: 'text', text: 'ok' }], executed: true }));
// A permission ask lights You.
events.push(ev('permission.asked', { sessionID: 'ses_top' }));
// read + edit in parallel via fine-grained events; edit fails.
events.push(ev('session.tool.input.started', { sessionID: 'ses_top', assistantMessageID: 'msg_a2', id: 'call-2', name: 'read' }));
events.push(ev('session.tool.called', { sessionID: 'ses_top', assistantMessageID: 'msg_a2', id: 'call-2', input: { file_path: 'd:/prog/repo/src/parser.ts' }, executed: true }));
events.push(ev('session.tool.input.started', { sessionID: 'ses_top', assistantMessageID: 'msg_a2', id: 'call-3', name: 'edit' }));
events.push(ev('session.tool.called', { sessionID: 'ses_top', assistantMessageID: 'msg_a2', id: 'call-3', input: { file_path: 'd:/prog/repo/src/parser.ts' }, executed: true }));
events.push(ev('session.tool.success', { sessionID: 'ses_top', assistantMessageID: 'msg_a2', id: 'call-2', content: [{ type: 'text', text: 'read' }], executed: true }));
events.push(ev('session.tool.failed', { sessionID: 'ses_top', assistantMessageID: 'msg_a2', id: 'call-3', error: { type: 'EditMismatch', message: 'old string not found' }, executed: true }));
// Model change mid-session.
events.push(ev('session.model.selected', { sessionID: 'ses_top', model: { id: 'glm-5.3-air', providerID: 'zai' } }));
// A subagent appears and works (its calls must light Agents + its station),
// through the fine-grained tool events.
events.push(ev('session.created', { sessionID: 'ses_sub2', projectID: 'p1', location: { directory: 'd:/prog/repo' }, slug: 'sub-fine', parentID: 'ses_top' }));
events.push(ev('session.status', { sessionID: 'ses_sub2', status: { type: 'busy' } }));
events.push(ev('session.tool.input.started', { sessionID: 'ses_sub2', assistantMessageID: 'msg_s2', id: 'call-9', name: 'bash' }));
events.push(ev('session.tool.called', { sessionID: 'ses_sub2', assistantMessageID: 'msg_s2', id: 'call-9', input: { command: 'kubectl get pods' }, executed: true }));
events.push(ev('session.tool.success', { sessionID: 'ses_sub2', assistantMessageID: 'msg_s2', id: 'call-9', content: [{ type: 'text', text: 'ok' }], executed: true }));
events.push(ev('session.status', { sessionID: 'ses_sub2', status: { type: 'idle' } }));
// A subagent through the content-updated fallback path.
events.push(ev('session.created', { sessionID: 'ses_sub', projectID: 'p1', location: { directory: 'd:/prog/repo' }, slug: 'sub', parentID: 'ses_top' }));
events.push(ev('session.status', { sessionID: 'ses_sub', status: { type: 'busy' } }));
events.push(ev('session.message.content.updated', { sessionID: 'ses_sub', messageID: 'msg_s1', content: [
  { id: 'p-sub', type: 'tool', name: 'bash', state: { status: 'running', input: { command: 'grep -r TODO src/' }, metadata: {}, time: { created: Date.now() } } },
] }));
events.push(ev('session.message.content.updated', { sessionID: 'ses_sub', messageID: 'msg_s1', content: [
  { id: 'p-sub', type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'grep -r TODO src/' }, metadata: {}, time: { created: Date.now(), completed: Date.now() + 600 } } },
] }));
events.push(ev('session.status', { sessionID: 'ses_sub', status: { type: 'idle' } }));
// Context usage feeds the ring around the centre.
events.push(ev('session.usage.updated', { sessionID: 'ses_top', cost: 0.01, tokens: { input: 4000, output: 500, reasoning: 100, cache: { read: 100000, write: 20000 } } }));
// A memory read lights Memory.
events.push(ev('session.tool.input.started', { sessionID: 'ses_top', assistantMessageID: 'msg_a3', id: 'call-4', name: 'read' }));
events.push(ev('session.tool.called', { sessionID: 'ses_top', assistantMessageID: 'msg_a3', id: 'call-4', input: { file_path: 'd:/prog/repo/AGENTS.md' }, executed: true }));
events.push(ev('session.tool.success', { sessionID: 'ses_top', assistantMessageID: 'msg_a3', id: 'call-4', content: [{ type: 'text', text: 'guidance' }], executed: true }));
// A shell outlives its turn: created while busy, exits after idle.
events.push(evLoc('shell.created', { info: { id: 'shl_1', status: 'running', command: 'bun dev', cwd: 'd:/prog/repo', shell: 'pwsh', file: '', metadata: {}, time: { started: Date.now() } } }, 'd:/prog/repo'));
// Turn ends while the dev server keeps running in the background.
events.push(ev('session.execution.succeeded', { sessionID: 'ses_top' }));
events.push(ev('session.status', { sessionID: 'ses_top', status: { type: 'idle' } }));
// The shell outlives the turn by a while, then exits.
events.push(PAUSE(3400));
events.push(evLoc('shell.exited', { info: { id: 'shl_1', status: 'exited', command: 'bun dev', cwd: 'd:/prog/repo', shell: 'pwsh', file: '', exit: 0, metadata: {}, time: { started: Date.now(), completed: Date.now() + 900 } } }, 'd:/prog/repo'));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/session') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessions: [
        { id: 'ses_top', title: 'Fix the parser', directory: 'd:/prog/repo', parentID: null },
        { id: 'ses_sub', title: '', directory: 'd:/prog/repo', parentID: 'ses_top' },
        { id: 'ses_sub2', title: '', directory: 'd:/prog/repo', parentID: 'ses_top' },
        { id: 'ses_other', title: 'Idle other chat', directory: 'd:/elsewhere', parentID: null },
      ],
    }));
    return;
  }
  if (url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/message')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [] }));
    return;
  }
  if (url.pathname === '/api/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(':ok\n\n');
    let closed = false;
    req.on('close', () => { closed = true; });
    void (async () => {
      for (const item of events) {
        if (closed) return;
        if (typeof item === 'string') res.write(`${item}\n\n`);
        else if (item && typeof item.__pause === 'number') await new Promise((r) => setTimeout(r, item.__pause));
        await new Promise((r) => setTimeout(r, 50));
      }
      res.end();
    })();
    return;
  }
  res.writeHead(404).end('{}');
});

server.listen(4601, '127.0.0.1', () => console.log('fake opencode on 4601'));
