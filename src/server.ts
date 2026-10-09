import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { Orchestrator } from './core';
import type { RunLogs } from './logs';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The most of a Run's log a live tail sends at once, on connect and per poll. Agent output is untrusted and unbounded. */
const TAIL_BYTES = 16 * 1024;
/** The most of a Run's log the full-log route holds in memory at once. */
const FULL_CHUNK_BYTES = 1024 * 1024;

/**
 * Server-sent events for one Run's log: a `tail` event with the log's last TAIL_BYTES, then `log` events with
 * what was appended, then `end` once the Run is no longer live. Stops polling the moment the client leaves.
 */
async function streamLog(res: ServerResponse, orchestrator: Orchestrator, logs: RunLogs, runId: number, pollMs: number) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let wake = () => {};
  res.on('close', () => {
    closed = true;
    clearTimeout(timer);
    wake();
  });
  const send = (event: string, text: string) => res.write(`event: ${event}\ndata: ${JSON.stringify(text)}\n\n`);
  let decoder = new StringDecoder('utf8');
  let sent: number | null = null;
  try {
    while (!closed) {
      // Read liveness first: once the Run is over its log is complete, so a read after this check is the last one.
      const live = orchestrator.runs().live.some((r) => r.id === runId);
      const total = await logs.size(runId);
      if (sent === null || total > sent) {
        const from = Math.max(sent ?? 0, total - TAIL_BYTES);
        if (from > (sent ?? 0)) decoder = new StringDecoder('utf8'); // skipped a gap, so a character may be cut
        const text = decoder.write(await logs.slice(runId, from, total));
        if (closed) return;
        if (sent === null || text) send(sent === null ? 'tail' : 'log', text);
        sent = total;
      }
      if (!live) {
        send('end', '');
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, pollMs);
      });
    }
    res.end();
  } catch {
    res.destroy();
  }
}

/** A year: the token lives in data/ across restarts, so the cookie can too. */
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** JSON state at /api/state; a Run's log at /api/runs/:id/log (full) and /api/runs/:id/log/stream (SSE tail); POST /api/runs/:id/{kill,retry,cleanup}, /api/projects/:name/{pause,resume} and /api/projects/:name/run-now/:ticketId; everything else is the built SPA from `staticDir`. Every /api route needs the cookie that `/?token=<token>` sets. */
export function createHttpServer(orchestrator: Orchestrator, staticDir: string, logs: RunLogs, token: string, pollMs = 1000): Server {
  // An empty token would match a missing cookie.
  if (!token) throw new Error('the Dashboard needs a token');
  const expected = Buffer.from(token);
  const isToken = (got = '') => Buffer.byteLength(got) === expected.length && timingSafeEqual(Buffer.from(got), expected);
  return createServer(async (req, res) => {
    // Block DNS rebinding: a page on evil.com resolved to 127.0.0.1 still sends Host: evil.com.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1') {
      res.statusCode = 403;
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    const given = url.searchParams.get('token');
    if (path === '/' && given !== null) {
      if (!isToken(given)) {
        res.statusCode = 403;
        res.end('wrong token\n');
        return;
      }
      // Redirect so the token leaves the address bar and history.
      res.writeHead(302, { location: '/', 'set-cookie': `dashboard=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}` });
      res.end();
      return;
    }

    // Sandboxes reach this 127.0.0.1 listener through host.docker.internal and can forge Host and Origin, but never see
    // the token: only the human's browser holds the cookie.
    if (path.startsWith('/api/') && !isToken(/(?:^|;\s*)dashboard=([^;]*)/.exec(req.headers.cookie ?? '')?.[1])) {
      res.statusCode = 401;
      res.end();
      return;
    }

    if (path === '/api/state') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          slots: orchestrator.slots(),
          ready: orchestrator.readyQueue(),
          runs: orchestrator.runs(),
          projects: orchestrator.projectStatuses(),
        }),
      );
      return;
    }

    const post = ((): (() => unknown) | undefined => {
      const run = /^\/api\/runs\/(\d+)\/(kill|retry|cleanup)$/.exec(path);
      if (run) {
        const runId = Number(run[1]);
        return { kill: () => orchestrator.kill(runId), retry: () => orchestrator.retryHostStep(runId), cleanup: () => orchestrator.cleanUp(runId) }[run[2] as 'kill'];
      }
      const pause = /^\/api\/projects\/([^/]+)\/(pause|resume)$/.exec(path);
      if (pause) return () => orchestrator.setPaused(decodeURIComponent(pause[1]), pause[2] === 'pause');
      const runNow = /^\/api\/projects\/([^/]+)\/run-now\/([^/]+)$/.exec(path);
      if (runNow) return () => orchestrator.runNow(decodeURIComponent(runNow[1]), decodeURIComponent(runNow[2]));
    })();
    if (post) {
      // The Host check above lets a form posted from any web page through, so only this page's own Origin may act.
      if (req.method !== 'POST' || req.headers.origin !== `http://${req.headers.host}`) {
        res.statusCode = req.method === 'POST' ? 403 : 405;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      try {
        await post();
        res.end('{}');
      } catch (err) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    const logRoute = /^\/api\/runs\/(\d+)\/log(\/stream)?$/.exec(path);
    if (logRoute) {
      const runId = Number(logRoute[1]);
      if (logRoute[2]) return streamLog(res, orchestrator, logs, runId, pollMs);
      try {
        const total = await logs.size(runId);
        // Agent output: plain text that the browser must not sniff into HTML.
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
        // Unbounded, so streamed in chunks rather than held in memory whole.
        await pipeline(async function* () {
          for (let at = 0; at < total; at += FULL_CHUNK_BYTES) yield await logs.slice(runId, at, Math.min(total, at + FULL_CHUNK_BYTES));
        }, res);
      } catch {
        if (res.headersSent) res.destroy();
        else {
          res.statusCode = 500;
          res.end();
        }
      }
      return;
    }

    // normalize() resolves any `..`, so a request can't climb out of staticDir.
    const file = join(staticDir, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(staticDir)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
}
