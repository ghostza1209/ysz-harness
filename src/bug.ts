// npm run bug [ticket-id]. Must work while ysz is down or broken: import only bugCli and bugReport, never main, openStore or (statically) projects.
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { bugCommand, probePort } from './bugCli';
import { gatherFacts } from './bugReport';

const root = fileURLToPath(new URL('..', import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const closed = new Promise<undefined>((resolve) => rl.once('close', () => resolve(undefined)));
// On a terminal readline holds stdin in raw mode from here on, so Ctrl+C reaches it, not the process: without this it
// only closes the input and the command carries on to write the file and open the browser.
rl.on('SIGINT', () => process.exit(130));

const code = await bugCommand(process.argv[2], {
  root,
  now: Date.now(),
  facts: () => gatherFacts(root),
  loadProjects: async () => (await import('./projects')).projects,
  yszUp: () => probePort(Number(process.env.PORT ?? 4000)),
  // A failure to open is not an error: the path and link are printed.
  open: (target, reveal) => {
    if (reveal && process.platform !== 'darwin') return;
    const [cmd, args] = process.platform === 'darwin' ? ['open', reveal ? ['-R', target] : [target]] as const : ['xdg-open', [target]] as const;
    execFile(cmd, args, () => {});
  },
  interactive: Boolean(process.stdin.isTTY),
  // `closed` first: once input has ended question() rejects, and the already settled close must win the race.
  ask: (prompt) => Promise.race([closed, rl.question(prompt)]),
  out: console.log,
  err: console.error,
});
rl.close();
process.exitCode = code;
