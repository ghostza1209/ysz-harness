import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startCheckServer, type CheckServer } from '../src/checks';

/** POST argv the way the sandbox's php-check does, from the host side: the sandbox's host.docker.internal is our 127.0.0.1. */
function check(server: CheckServer, argv: unknown, token = server.token): Promise<{ status: number; body: string; exit?: string }> {
  const port = new URL(server.url).port;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body, exit: res.trailers['x-exit-code'] }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(argv));
  });
}

/** A fake `docker`: one compose php container unless `stack-down` exists; `run` prints and exits 3, or blocks until `rm` while `run-blocks` exists. */
describe('check server', () => {
  let root: string;
  let docker: string;
  let server: CheckServer | undefined;
  const logOf = () => readFileSync(join(root, 'log'), 'utf8').trim().split('\n').filter(Boolean);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fake-docker-'));
    docker = join(root, 'docker');
    writeFileSync(join(root, 'log'), '');
    writeFileSync(
      docker,
      `#!/bin/sh
echo "$@" >> ${root}/log
case "$1" in
  ps) [ -f ${root}/ps-slow ] && sleep 0.3; [ -f ${root}/stack-down ] || echo abc123 ;;
  inspect) if [ -f ${root}/no-label ]; then printf 'fazwaz-php:latest\\t\\n'; else printf 'fazwaz-php:latest\\t/Users/me/fazwaz\\n'; fi ;;
  run)
    if [ -f ${root}/run-blocks ]; then while [ ! -f ${root}/removed ] && [ -d ${root} ]; do sleep 0.05; done; exit 137; fi
    echo 'Tests: 1 passed'; echo 'a warning' >&2; exit 3 ;;
  rm) touch ${root}/removed ;;
esac
`,
    );
    chmodSync(docker, 0o755);
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const start = (timeoutMs?: number) =>
    startCheckServer({ composeProject: 'fazwaz', service: 'php', clone: '/clones/fz1-1/repo', dockerBin: docker, timeoutMs }).then((s) => (server = s));

  it('refuses a request without the token, and runs nothing', async () => {
    const s = await start();
    const res = await check(s, ['php', '-v'], 'wrong');
    assert.equal(res.status, 401);
    assert.deepEqual(logOf(), []);
  });

  it('puts docker flags the agent sends after the image, where they are only the container command', async () => {
    const s = await start();
    const res = await check(s, ['--privileged', '-v', '/:/host', 'sh']);
    assert.equal(res.status, 200);
    const run = logOf().find((l) => l.startsWith('run '))!;
    assert.match(
      run,
      /^run --rm --name php-check-\S+ -v \/clones\/fz1-1\/repo:\/var\/www -v \/Users\/me\/fazwaz\/vendor:\/var\/www\/vendor:ro -w \/var\/www --network fazwaz_default fazwaz-php:latest --privileged -v \/:\/host sh$/,
    );
  });

  it('sends back the command\'s output and its exit code', async () => {
    const s = await start();
    const res = await check(s, ['php', 'artisan', 'test']);
    assert.match(res.body, /Tests: 1 passed/);
    assert.match(res.body, /a warning/);
    assert.equal(res.exit, '3');
  });

  it('runs the next command once the previous one is done', async () => {
    const s = await start();
    assert.equal((await check(s, ['php', '-v'])).status, 200);
    assert.equal((await check(s, ['php', '-v'])).status, 200);
  });

  it('refuses anything but a non-empty list of strings, and runs nothing', async () => {
    const s = await start();
    for (const argv of [[], 'php -v', ['php', 1]]) assert.equal((await check(s, argv)).status, 400);
    assert.deepEqual(logOf(), []);
  });

  it('says the stack is down, and runs nothing, when the compose service is not running', async () => {
    writeFileSync(join(root, 'stack-down'), '');
    const s = await start();
    const res = await check(s, ['php', '-v']);
    assert.equal(res.status, 503);
    assert.match(res.body, /stack is down/);
    assert.ok(!logOf().some((l) => l.startsWith('run ')));
  });

  it('runs nothing when the container does not say where its checkout is: the vendor mount would be the host\'s /vendor', async () => {
    writeFileSync(join(root, 'no-label'), '');
    const s = await start();
    assert.equal((await check(s, ['php', '-v'])).status, 503);
    assert.ok(!logOf().some((l) => l.startsWith('run ')));
  });

  it('removes the container of a command that runs past the timeout', async () => {
    writeFileSync(join(root, 'run-blocks'), '');
    const s = await start(200);
    const res = await check(s, ['php', 'artisan', 'test']);
    const name = /--name (\S+)/.exec(logOf().find((l) => l.startsWith('run '))!)![1];
    assert.ok(logOf().includes(`rm -f ${name}`));
    assert.match(res.body, /timed out/);
    assert.notEqual(res.exit, '0');
  });

  it('runs one command at a time', async () => {
    writeFileSync(join(root, 'run-blocks'), '');
    const s = await start();
    const first = check(s, ['php', 'artisan', 'test']).catch(() => {}); // close cuts the connection
    while (!logOf().some((l) => l.startsWith('run '))) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await check(s, ['php', '-v'])).status, 409);
    await s.close();
    await first;
    assert.ok(existsSync(join(root, 'removed')), 'close removes the running container');
  });

  it('does not start a command whose caller left during the lookup', async () => {
    writeFileSync(join(root, 'ps-slow'), '');
    const s = await start();
    const first = check(s, ['php', '-v']).catch(() => {});
    while (!logOf().some((l) => l.startsWith('ps '))) await new Promise((r) => setTimeout(r, 20));
    await s.close();
    await first;
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!logOf().some((l) => l.startsWith('run ')));
  });
});
