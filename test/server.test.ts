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
const orchestrator = {
  slots: () => ({}),
  readyQueue: () => [],
  runs: () => ({ live: liveIds.map((id) => ({ id })), history: [] }),
  projectStatuses: () => [],
  kill: async (id: number) => {
    if (id === 13) throw new Error('docker rm failed');
    actions.push(`kill ${id}`);
  },
  retryHostStep: async (id: number) => void actions.push(`retry ${id}`),
  cleanUp: async (id: number) => void actions.push(`cleanup ${id}`),
} as unknown as Orchestrator;
const actions: string[] = [];
const realLogs = createRunLogs(logDir);
let sizeCalls = 0;
const logs: RunLogs = { ...realLogs, size: (id) => (sizeCalls++, realLogs.size(id)) };
const server = createHttpServer(orchestrator, '/nonexistent', logs, POLL_MS);
let port: number;

before(() => new Promise<void>((done) => server.listen(0, '127.0.0.1', () => {
  port = (server.address() as AddressInfo).port;
  done();
})));
after(() => server.close());

const send = (path: string, headers: Record<string, string> = {}, method = 'GET', host = `localhost:${port}`) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    request({ port, path, method, headers: { host, ...headers } }, (res) => {
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
  state.req = request({ port, path: `/api/runs/${runId}/log/stream`, headers: { host: `localhost:${port}` } }, (res) => {
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

it('answers requests addressed to localhost or 127.0.0.1', async () => {
  assert.equal(await statusFor(`localhost:${port}`), 200);
  assert.equal(await statusFor(`127.0.0.1:${port}`), 200);
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
  for (const action of ['kill', 'retry', 'cleanup']) assert.equal((await post(`/api/runs/7/${action}`)).status, 200);
  assert.deepEqual(actions, ['kill 7', 'retry 7', 'cleanup 7']);
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
