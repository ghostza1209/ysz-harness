import { fileURLToPath } from 'node:url';
import { createBeadsGateway } from './beads';
import { createOrchestrator } from './core';
import { createHostSteps } from './host';
import { createRunLogs } from './logs';
import { projects } from './projects';
import { createSandboxRunner, MODEL } from './sandbox';
import { createHttpServer } from './server';
import { openStore } from './store';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 4000);
/** bd serializes all access to a Project's DB, so every poll briefly blocks the user's own bd calls. */
const POLL_INTERVAL_MS = 30_000;

const orchestrator = createOrchestrator({
  projects,
  beads: createBeadsGateway(),
  sandbox: createSandboxRunner(root),
  host: createHostSteps(MODEL),
  store: openStore(`${root}data/orchestrator.db`),
  clock: Date,
});

// Sequential, so a slow poll can never overlap the next one. A tick only starts Runs; they finish in the background.
void (async () => {
  for (;;) {
    await orchestrator.poll();
    await orchestrator.tick();
    for (const p of orchestrator.projectStatuses()) if (p.error) console.error(`[poll] ${p.name}: ${p.error}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
})();

createHttpServer(orchestrator, `${root}dist`, createRunLogs(`${root}data/logs`)).listen(port, '127.0.0.1', () => {
  console.log(`Orchestrator on http://localhost:${port}`);
});
