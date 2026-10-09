import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
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

/**
 * Server-sent events for one Run's log: a `tail` event with the log's last TAIL_BYTES, then `log` events with
 * what was appended, then `end` once the Run no longer holds a slot. Stops polling the moment the client leaves.
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

/** JSON state at /api/state; a Run's log at /api/runs/:id/log (full) and /api/runs/:id/log/stream (SSE tail); everything else is the built SPA from `staticDir`. */
export function createHttpServer(orchestrator: Orchestrator, staticDir: string, logs: RunLogs, pollMs = 1000): Server {
  return createServer(async (req, res) => {
    // Block DNS rebinding: a page on evil.com resolved to 127.0.0.1 still sends Host: evil.com.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== 'localhost' && host !== '127.0.0.1') {
      res.statusCode = 403;
      res.end();
      return;
    }

    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

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

    const logRoute = /^\/api\/runs\/(\d+)\/log(\/stream)?$/.exec(path);
    if (logRoute) {
      const runId = Number(logRoute[1]);
      if (logRoute[2]) return streamLog(res, orchestrator, logs, runId, pollMs);
      try {
        const body = await logs.slice(runId, 0, await logs.size(runId));
        // Agent output: plain text that the browser must not sniff into HTML.
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end(body);
      } catch {
        res.statusCode = 500;
        res.end();
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
