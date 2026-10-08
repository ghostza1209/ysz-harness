import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Orchestrator } from './core';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** JSON state at /api/state; everything else is the built SPA from `staticDir`. */
export function createHttpServer(orchestrator: Orchestrator, staticDir: string): Server {
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
          projects: orchestrator.projectStatuses(),
        }),
      );
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
