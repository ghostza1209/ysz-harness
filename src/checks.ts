import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/** A command line, not a payload: anything bigger is not a PHP check. */
const MAX_BODY = 64 * 1024;

export interface CheckServer {
  /** Where the sandbox reaches this server: Docker Desktop routes host.docker.internal to host loopback. */
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * ADR 0002: one agent's way to run PHP checks without the Docker socket. The agent POSTs only the argv of a command;
 * the host runs it in a throwaway container of the compose service's image, on `clone`.
 */
export async function startCheckServer({
  composeProject,
  service,
  clone,
  dockerBin = 'docker',
  timeoutMs = 600_000,
}: { composeProject: string; service: string; clone: string; dockerBin?: string; timeoutMs?: number }): Promise<CheckServer> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (header = '') => {
    const got = Buffer.from(header);
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  /** The name of the container now running, if any. */
  let running: string | undefined;
  const remove = (name: string) => execFileAsync(dockerBin, ['rm', '-f', name], { timeout: 60_000 }).catch(() => {});
  const fail = (res: ServerResponse, status: number, message = '') => {
    res.statusCode = status;
    res.end(message);
  };

  const server = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization)) return fail(res, 401);
    if (req.method !== 'POST') return fail(res, 405);

    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY) return fail(res, 413);
      }
    } catch {
      return; // the agent hung up mid-request
    }
    let argv: unknown;
    try {
      argv = JSON.parse(body);
    } catch {}
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) return fail(res, 400, 'php-check: give a command to run\n');

    if (running) return fail(res, 409, 'php-check: another command is still running; run one at a time\n');
    const name = `php-check-${randomBytes(8).toString('hex')}`;
    running = name;
    let started = false;
    // The agent gave up on it, or close() cut it.
    res.on('close', () => void (started && remove(name)));
    try {
      // Looked up per command, so a restarted compose stack is picked up.
      const php = (
        await execFileAsync(dockerBin, ['ps', '-q', '--filter', `label=com.docker.compose.project=${composeProject}`, '--filter', `label=com.docker.compose.service=${service}`], { timeout: 30_000 })
      ).stdout.split('\n')[0];
      if (!php) return fail(res, 503, `php-check: the ${composeProject} compose stack is down, so PHP checks are unavailable; CI covers them\n`);
      const [image, repo] = (
        await execFileAsync(dockerBin, ['inspect', php, '--format', '{{.Config.Image}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}'], { timeout: 30_000 })
      ).stdout.trim().split('\t');
      // An empty repo would mount the host's /vendor.
      if (!image || !repo) return fail(res, 503, `php-check: cannot tell the image or checkout of the ${composeProject} ${service} container\n`);
      if (res.destroyed) return;

      // Every flag is ours: the agent's argv goes after the image, so docker reads it only as the container's command.
      const child = spawn(dockerBin, ['run', '--rm', '--name', name, '-v', `${clone}:/var/www`, '-v', `${repo}/vendor:/var/www/vendor:ro`, '-w', '/var/www', '--network', `${composeProject}_default`, image, ...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      started = true;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', trailer: 'x-exit-code' });
      child.stdout.pipe(res, { end: false });
      child.stderr.pipe(res, { end: false });
      // Killing the docker CLI alone would leave the container running: remove the container, then the CLI if it still hangs.
      const timer = setTimeout(() => {
        res.write(`\nphp-check: timed out after ${timeoutMs / 1000}s\n`);
        void remove(name).then(() => child.kill());
      }, timeoutMs);
      const code = await new Promise<number | null>((resolve) => {
        child.on('error', (err) => {
          res.write(`php-check: ${err.message}\n`);
          resolve(null);
        });
        child.on('close', resolve);
      });
      clearTimeout(timer);
      res.addTrailers({ 'x-exit-code': String(code ?? 1) });
      res.end();
    } catch (err) {
      if (res.headersSent) res.destroy();
      else fail(res, 500, `php-check: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      running = undefined;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://host.docker.internal:${(server.address() as AddressInfo).port}/`,
    token,
    // Cuts the connections too, so a stuck request cannot hold close() up.
    close: async () => {
      const left = running;
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      if (left) await remove(left);
    },
  };
}
