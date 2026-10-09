import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBeadsGateway } from './beads';
import { createOrchestrator } from './core';
import { createHostSteps } from './host';
import { appendRunLog, createRunLogs } from './logs';
import { projects } from './projects';
import { createSandboxRunner, MODEL } from './sandbox';
import { createHttpServer } from './server';
import { openStore } from './store';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 4000);
/** bd serializes all access to a Project's DB, so every poll briefly blocks the user's own bd calls. */
const POLL_INTERVAL_MS = 30_000;

const beads = createBeadsGateway();
const orchestrator = createOrchestrator({
  projects,
  beads,
  sandbox: createSandboxRunner(root),
  host: createHostSteps(MODEL),
  store: openStore(`${root}data/orchestrator.db`),
  clock: Date,
  // A log write that fails must not fail the Run.
  log: (runId, line) => {
    try {
      appendRunLog(`${root}data/logs`, runId, line);
    } catch (err) {
      console.error(`[log] run ${runId}: ${(err as Error).message}`);
    }
  },
});

for (const problem of await orchestrator.recover()) console.error(`[recover] ${problem}`);

// Sequential, so a slow poll can never overlap the next one. A tick only starts Runs; they finish in the background.
void (async () => {
  for (;;) {
    // Before the poll, which can run long: a bd lease lasts 5 minutes and the loop comes round every 30 seconds.
    await Promise.all(projects.map((p) => beads.heartbeat(p).catch((err) => console.error(`[heartbeat] ${p.name}: ${err.message}`))));
    for (const problem of await orchestrator.watchReviews()) console.error(`[review-watch] ${problem}`);
    await orchestrator.poll();
    await orchestrator.tick();
    for (const p of orchestrator.projectStatuses()) if (p.error) console.error(`[poll] ${p.name}: ${p.error}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
})();

// The Dashboard's token: kept in data/, which no sandbox mounts, so the cookie survives restarts. Delete the file to rotate it.
const tokenPath = `${root}data/dashboard-token`;
let token: string;
try {
  token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('empty');
} catch {
  token = randomBytes(32).toString('hex');
  mkdirSync(`${root}data`, { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
}

createHttpServer(orchestrator, `${root}dist`, createRunLogs(`${root}data/logs`), token).listen(port, '127.0.0.1', () => {
  console.log(`Orchestrator on http://localhost:${port}/?token=${token}`);
});
