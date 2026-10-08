import { fileURLToPath } from 'node:url';
import { createBeadsGateway } from './beads';
import { createOrchestrator } from './core';
import { projects } from './projects';
import { createHttpServer } from './server';
import { openStore } from './store';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 4000);
/** bd serializes all access to a Project's DB, so every poll briefly blocks the user's own bd calls. */
const POLL_INTERVAL_MS = 30_000;

const orchestrator = createOrchestrator({
  projects,
  beads: createBeadsGateway(),
  store: openStore(`${root}data/orchestrator.db`),
  clock: Date,
});

// Sequential, so a slow poll can never overlap the next one.
void (async () => {
  for (;;) {
    await orchestrator.poll();
    for (const p of orchestrator.projectStatuses()) if (p.error) console.error(`[poll] ${p.name}: ${p.error}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
})();

createHttpServer(orchestrator, `${root}dist`).listen(port, '127.0.0.1', () => {
  console.log(`Orchestrator on http://localhost:${port}`);
});
