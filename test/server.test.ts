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
} as unknown as Orchestrator;
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

const get = (path: string, host = `localhost:${port}`) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    request({ port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject).end();
  });

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
