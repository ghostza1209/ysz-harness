import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import type { Orchestrator } from '../src/core';
import { createRunLogs, type RunLogs } from '../src/logs';
import { createHttpServer } from '../src/server';

const POLL_MS = 20;
const logDir = mkdtempSync(join(tmpdir(), 'server-logs-'));
let liveIds: number[] = [];
// The limit each runs() call got.
const runLimits: (number | undefined)[] = [];
const orchestrator = {
  slots: () => ({}),
  readyQueue: () => [{ project: 'lab', id: 'lab-1' }],
  runs: (limit?: number) => (runLimits.push(limit), { live: liveIds.map((id) => ({ id })), history: [] }),
  projectStatuses: () => [],
  stats: () => ({ runs: [], backlog: [] }),
  backlog: () => [{ name: 'lab', rows: [{ id: 'lab-1' }], updatedAt: 1234, error: null }],
  kill: async (id: number) => {
    if (id === 13) throw new Error('docker rm failed');
    actions.push(`kill ${id}`);
  },
  retryHostStep: async (id: number) => void actions.push(`retry ${id}`),
  requeue: async (id: number) => void actions.push(`requeue ${id}`),
  cleanUp: async (id: number) => void actions.push(`cleanup ${id}`),
  deleteRun: async (id: number) => void actions.push(`delete ${id}`),
  setArchived: (id: number, archived: boolean) => void actions.push(`${archived ? 'archive' : 'unarchive'} ${id}`),
  setPaused: (project: string, paused: boolean) => void actions.push(`${paused ? 'pause' : 'resume'} ${project}`),
  ticketAction: async (project: string, id: string, action: string) => {
    if (action === 'allow') throw new Error(`${id} is not skipped`);
    actions.push(`${action} ${project}/${id}`);
  },
  ticketDetail: async (project: string, id: string) => {
    detailReads.push(`${project}/${id}`);
    if (id === 'lab-1' && detailFails) throw new Error('bd timed out');
    return { description: 'line one\nline two', comments: [{ author: 'yoss', text: 'a note', createdAt: '2026-10-22T10:00:00Z' }] };
  },
  runNow: (project: string, id: string) => {
    if (id === 'gone') throw new Error('gone is not in the Ready queue');
    actions.push(`run-now ${project}/${id}`);
  },
} as unknown as Orchestrator;
const actions: string[] = [];
const detailReads: string[] = [];
let detailFails = false;
const realLogs = createRunLogs(logDir);
let sizeCalls = 0;
const logs: RunLogs = { ...realLogs, size: (id) => (sizeCalls++, realLogs.size(id)) };
const TOKEN = 'a'.repeat(64);
const server = createHttpServer(orchestrator, '/nonexistent', logs, TOKEN, POLL_MS);
let port: number;

before(() => new Promise<void>((done) => server.listen(0, '127.0.0.1', () => {
  port = (server.address() as AddressInfo).port;
  done();
})));
after(() => server.close());

/** Sends the Dashboard's cookie unless `headers` overrides it. */
const send = (path: string, headers: Record<string, string> = {}, method = 'GET', host = `localhost:${port}`) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    request({ port, path, method, headers: { host, cookie: `dashboard=${TOKEN}`, ...headers } }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject).end();
  });
const get = (path: string, host = `localhost:${port}`) => send(path, {}, 'GET', host);
/** A POST as the dashboard's own page sends it. */
const post = (path: string, origin = `http://localhost:${port}`) => send(path, { origin }, 'POST');

const statusFor = async (host: string) => (await get('/api/state', host)).status;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(POLL_MS);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Opens a log stream; `events` fills with parsed SSE events as they arrive. */
function openStream(runId: number) {
  const events: { event: string; data: string }[] = [];
  const state = { ended: false, req: undefined as unknown as ClientRequest };
  let buffer = '';
  state.req = request({ port, path: `/api/runs/${runId}/log/stream`, headers: { host: `localhost:${port}`, cookie: `dashboard=${TOKEN}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      for (let cut; (cut = buffer.indexOf('\n\n')) >= 0; ) {
        const [event, data] = buffer.slice(0, cut).split('\n');
        events.push({ event: event.slice('event: '.length), data: JSON.parse(data.slice('data: '.length)) });
        buffer = buffer.slice(cut + 2);
      }
    });
    res.on('end', () => (state.ended = true));
  });
  state.req.end();
  return { events, state };
}

it("serves each Project's Backlog rows with the Ready queue at /api/backlog", async () => {
  const res = await get('/api/backlog');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    projects: [{ name: 'lab', rows: [{ id: 'lab-1' }], updatedAt: 1234, error: null }],
    ready: [{ project: 'lab', id: 'lab-1' }],
  });
});

it('answers requests addressed to localhost or 127.0.0.1', async () => {
  assert.equal(await statusFor(`localhost:${port}`), 200);
  assert.equal(await statusFor(`127.0.0.1:${port}`), 200);
});

it('refuses every API route without the Dashboard cookie, as a sandbox sends it, and does nothing', async () => {
  // A sandbox reaches 127.0.0.1 through host.docker.internal and can forge Host and Origin, but has no cookie.
  actions.length = 0;
  const forged = { origin: `http://localhost:${port}`, cookie: '' };
  assert.equal((await send('/api/state', forged)).status, 401);
  assert.equal((await send('/api/stats', forged)).status, 401);
  assert.equal((await send('/api/backlog', forged)).status, 401);
  assert.equal((await send('/api/projects/lab/tickets/lab-1', forged)).status, 401);
  assert.equal((await send('/api/runs/1/log', forged)).status, 401);
  assert.equal((await send('/api/runs/1/log/stream', forged)).status, 401);
  assert.equal((await send('/api/runs/7/kill', forged, 'POST')).status, 401);
  assert.equal((await send('/api/projects/fazwaz/run-now/fz-1', { ...forged, cookie: `dashboard=${'b'.repeat(64)}` }, 'POST')).status, 401);
  assert.equal((await send('/api/state', { cookie: `dashboard=${TOKEN.slice(1)}` })).status, 401);
  assert.deepEqual(actions, []);
});

it('asks for the ?limit Runs the page wants, within 1..500, else the default', async () => {
  runLimits.length = 0;
  for (const q of ['', '?limit=120', '?limit=abc', '?limit=0', '?limit=-1', '?limit=99999']) assert.equal((await get(`/api/state${q}`)).status, 200);
  assert.deepEqual(runLimits, [undefined, 120, undefined, undefined, undefined, 500]);
});

it('serves the Stats data as JSON at /api/stats', async () => {
  const res = await get('/api/stats');
  assert.deepEqual([res.status, res.headers['content-type']], [200, 'application/json']);
});

it('will not start without a token, which would let every request through', () => {
  assert.throws(() => createHttpServer(orchestrator, '/nonexistent', logs, ''));
});

it('trades the token in the URL for the cookie and drops it from the address bar', async () => {
  const res = await send(`/?token=${TOKEN}`, { cookie: '' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  const cookie = String(res.headers['set-cookie']);
  assert.match(cookie, new RegExp(`^dashboard=${TOKEN};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await send('/api/state', { cookie: cookie.split(';')[0] })).status, 200);
});

it('refuses a wrong token in the URL', async () => {
  const res = await send(`/?token=${'b'.repeat(64)}`, { cookie: '' });
  assert.equal(res.status, 403);
  assert.equal(res.headers['set-cookie'], undefined);
});

it('rejects a rebound foreign Host', async () => {
  assert.equal(await statusFor(`evil.example:${port}`), 403);
  assert.equal(await statusFor('localhost.evil.example'), 403);
  assert.equal((await get('/api/runs/1/log', 'evil.example')).status, 403);
});

it("serves a finished Run's complete log as non-sniffable plain text", async () => {
  writeFileSync(join(logDir, '5-attempt1-implement.log'), 'plan <script>alert(1)</script>\n');
  writeFileSync(join(logDir, '5-attempt1-review.log'), 'reviewed ✓\n');
  const res = await get('/api/runs/5/log');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-log-parts'], 'attempt1-implement=31,attempt1-review=13');
  assert.equal(res.body, 'plan <script>alert(1)</script>\nreviewed ✓\n');
});

it('serves a full log larger than one read chunk intact, across files', async () => {
  const first = `${'a'.repeat(1024 * 1024 - 1)}é${'b'.repeat(500_000)}`; // é straddles the 1 MiB chunk boundary
  writeFileSync(join(logDir, '4-attempt1-implement.log'), first);
  writeFileSync(join(logDir, '4-attempt2-implement.log'), 'tail\n');
  const res = await get('/api/runs/4/log');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, first.length + 5);
  assert.ok(res.body === `${first}tail\n`);
});

it('streams a live Run: the tail first, then each append, then end when the Run ends, and closes', async () => {
  writeFileSync(join(logDir, '6-attempt1-implement.log'), 'one\n');
  liveIds = [6];
  const { events, state } = openStream(6);
  await until(() => events.length === 1, 'the tail');
  assert.deepEqual(events[0], { event: 'tail', data: 'one\n' });

  appendFileSync(join(logDir, '6-attempt1-implement.log'), 'two\n');
  await until(() => events.length === 2, 'the append');
  assert.deepEqual(events[1], { event: 'log', data: 'two\n' });

  appendFileSync(join(logDir, '6-attempt1-implement.log'), 'last\n');
  liveIds = [];
  await until(() => state.ended, 'the stream to close');
  assert.deepEqual(events.slice(2), [{ event: 'log', data: 'last\n' }, { event: 'end', data: '' }]);
});

it('sends only the last 16 KiB when the log is larger', async () => {
  writeFileSync(join(logDir, '8-attempt1-implement.log'), `${'a'.repeat(100_000)}THE END`);
  liveIds = [];
  const { events, state } = openStream(8);
  await until(() => state.ended, 'the stream to close');
  assert.equal(events[0].event, 'tail');
  assert.equal(events[0].data.length, 16 * 1024);
  assert.ok(events[0].data.endsWith('aaaTHE END'));
});

it('stops reading the log once the client disconnects', async () => {
  writeFileSync(join(logDir, '9-attempt1-implement.log'), 'x');
  liveIds = [9];
  const { events, state } = openStream(9);
  await until(() => events.length === 1, 'the tail');
  state.req.destroy();
  await sleep(POLL_MS * 3); // let an in-flight poll settle
  const before = sizeCalls;
  await sleep(POLL_MS * 10);
  assert.equal(sizeCalls, before);
  liveIds = [];
});

it('runs a Run control posted from the dashboard itself', async () => {
  actions.length = 0;
  for (const action of ['kill', 'retry', 'requeue', 'cleanup', 'delete', 'archive', 'unarchive']) assert.equal((await post(`/api/runs/7/${action}`)).status, 200);
  assert.deepEqual(actions, ['kill 7', 'retry 7', 'requeue 7', 'cleanup 7', 'delete 7', 'archive 7', 'unarchive 7']);
});

it('runs pause, resume and Run now posted from the dashboard itself, decoding the names', async () => {
  actions.length = 0;
  assert.equal((await post('/api/projects/PopDeal/pause')).status, 200);
  assert.equal((await post('/api/projects/PopDeal/resume')).status, 200);
  assert.equal((await post('/api/projects/my%20app/run-now/app-9q2.7')).status, 200);
  assert.deepEqual(actions, ['pause PopDeal', 'resume PopDeal', 'run-now my app/app-9q2.7']);
  const refused = await post('/api/projects/PopDeal/run-now/gone');
  assert.equal(refused.status, 409);
  assert.deepEqual(JSON.parse(refused.body), { error: 'gone is not in the Ready queue' });
});

it('refuses pause, resume and Run now from another origin or by GET, and does nothing', async () => {
  actions.length = 0;
  for (const path of ['/api/projects/PopDeal/pause', '/api/projects/PopDeal/resume', '/api/projects/PopDeal/run-now/pd1']) {
    assert.equal((await post(path, 'http://evil.example')).status, 403);
    assert.equal((await send(path, {}, 'POST')).status, 403);
    assert.equal((await get(path)).status, 405);
  }
  assert.deepEqual(actions, []);
});

it('refuses a Run control from another origin, with no origin, or by GET, and does nothing', async () => {
  actions.length = 0;
  assert.equal((await post('/api/runs/7/kill', 'http://evil.example')).status, 403);
  assert.equal((await post('/api/runs/7/kill', `http://localhost:${port + 1}`)).status, 403);
  assert.equal((await send('/api/runs/7/kill', {}, 'POST')).status, 403);
  assert.equal((await get('/api/runs/7/kill')).status, 405);
  assert.equal((await send('/api/runs/7/kill', { origin: 'http://localhost' }, 'POST', 'evil.example')).status, 403);
  assert.deepEqual(actions, []);
});

it("answers a Run control the orchestrator refuses with 409 and the reason", async () => {
  const res = await post('/api/runs/13/kill');
  assert.equal(res.status, 409);
  assert.deepEqual(JSON.parse(res.body), { error: 'docker rm failed' });
});

it('runs a Backlog action posted from the dashboard itself, decoding the names, and answers a refusal with 409 and the reason', async () => {
  actions.length = 0;
  for (const action of ['mark-ready', 'unmark-ready', 'skip', 'unassign']) assert.equal((await post(`/api/projects/lab/tickets/lab-1/${action}`)).status, 200);
  assert.deepEqual(actions, ['mark-ready lab/lab-1', 'unmark-ready lab/lab-1', 'skip lab/lab-1', 'unassign lab/lab-1']);
  const refused = await post('/api/projects/lab/tickets/lab-1/allow');
  assert.equal(refused.status, 409);
  assert.deepEqual(JSON.parse(refused.body), { error: 'lab-1 is not skipped' });
});

it('answers 404 to a Backlog action on an id the Project does not hold, or a Project it does not know, and does nothing', async () => {
  actions.length = 0;
  const missing = await post('/api/projects/lab/tickets/lab-9/skip');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: "lab-9 is not in lab's Backlog" });
  assert.equal((await post('/api/projects/other/tickets/lab-1/skip')).status, 404);
  assert.deepEqual(actions, []);
});

it("serves a Backlog Ticket's description and comments", async () => {
  detailReads.length = 0;
  const res = await get('/api/projects/lab/tickets/lab-1');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { description: 'line one\nline two', comments: [{ author: 'yoss', text: 'a note', createdAt: '2026-10-22T10:00:00Z' }] });
  assert.deepEqual(detailReads, ['lab/lab-1']);
});

it('answers 404 to a detail of an id the Project does not hold, or a Project it does not know, without reading bd', async () => {
  detailReads.length = 0;
  assert.equal((await get('/api/projects/lab/tickets/lab-9')).status, 404);
  assert.equal((await get('/api/projects/lab/tickets/--help')).status, 404);
  assert.equal((await get('/api/projects/other/tickets/lab-1')).status, 404);
  assert.deepEqual(detailReads, []);
});

it('answers a detail whose bd read fails with 502 and the reason, a malformed escape with 400, and a POST with 405', async () => {
  detailFails = true;
  const failed = await get('/api/projects/lab/tickets/lab-1');
  detailFails = false;
  assert.equal(failed.status, 502);
  assert.deepEqual(JSON.parse(failed.body), { error: 'bd timed out' });
  assert.equal((await get('/api/projects/lab/tickets/%E0')).status, 400);
  assert.equal((await post('/api/projects/lab/tickets/lab-1')).status, 405);
});

it('answers a Backlog action on a malformed escape with 409 instead of crashing', async () => {
  assert.equal((await post('/api/projects/lab/tickets/%E0/skip')).status, 409);
});

it('refuses a Backlog action from another origin, with no origin, or by GET, and does nothing', async () => {
  actions.length = 0;
  const path = '/api/projects/lab/tickets/lab-1/mark-ready';
  assert.equal((await post(path, 'http://evil.example')).status, 403);
  assert.equal((await send(path, {}, 'POST')).status, 403);
  assert.equal((await get(path)).status, 405);
  assert.equal((await send(path, { origin: `http://localhost:${port}`, cookie: '' }, 'POST')).status, 401);
  assert.deepEqual(actions, []);
});
