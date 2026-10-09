import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, it } from 'node:test';
import type { Orchestrator } from '../src/core';
import { createHttpServer } from '../src/server';

const orchestrator = { slots: () => ({}), readyQueue: () => [], runs: () => ({ live: [], history: [] }), projectStatuses: () => [] } as unknown as Orchestrator;
const server = createHttpServer(orchestrator, '/nonexistent');
let port: number;

before(() => new Promise<void>((done) => server.listen(0, '127.0.0.1', () => {
  port = (server.address() as AddressInfo).port;
  done();
})));
after(() => server.close());

const statusFor = (host: string) =>
  new Promise<number>((resolve, reject) => {
    request({ port, path: '/api/state', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject).end();
  });

it('answers requests addressed to localhost or 127.0.0.1', async () => {
  assert.equal(await statusFor(`localhost:${port}`), 200);
  assert.equal(await statusFor(`127.0.0.1:${port}`), 200);
});

it('rejects a rebound foreign Host', async () => {
  assert.equal(await statusFor(`evil.example:${port}`), 403);
  assert.equal(await statusFor('localhost.evil.example'), 403);
});
