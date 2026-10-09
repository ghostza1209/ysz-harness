import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Project {
  name: string;
  repoPath: string;
  baseBranch: string;
  /** Sandbox image (built by `npm run images`). A Project without one is not onboarded: its Tickets are never claimed. */
  image?: string;
  /** Host command (argv) run in the repo before each claim; a non-zero exit means infrastructure is down (e.g. a compose service) and nothing is claimed. */
  preflight?: string[];
  /** Extra bind mounts for the sandbox. */
  mounts?: { hostPath: string; sandboxPath: string; readonly?: boolean }[];
  /** Gitignored files copied from the repo into each Run's worktree; missing ones are skipped. */
  copyToWorktree?: string[];
  /** Runs inside the sandbox before the agent starts, to install dependencies. */
  installCommand?: string;
  /** Tells the agent which checks to run. Best-effort: the sandbox may lack a database. */
  checkHint?: string;
}

const projectsDir = join(homedir(), 'Desktop/projects');

// No host pnpm store mount: mounted read-write, the agent could poison packages that host installs then run.
const STORE_IN_SANDBOX = '/home/agent/.pnpm-store';

const appRepo = join(projectsDir, 'personal/app');

// Edit and restart to add or change a Project.
export const projects: readonly Project[] = [
  { name: 'fazwaz', repoPath: join(projectsDir, 'work/fazwaz'), baseBranch: 'develop' },
  { name: 'PopDeal', repoPath: join(projectsDir, 'work/PopDeal'), baseBranch: 'develop' },
  {
    name: 'thaivis',
    repoPath: appRepo,
    baseBranch: 'develop',
    image: 'ysz-harness/app',
    copyToWorktree: ['.env', 'apps/backend/.env', 'apps/web/.env', 'apps/web-andalay/.env'],
    installCommand: `CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX}`,
    checkHint:
      'Run `pnpm run check-types`, then the unit tests of the packages you changed (`pnpm -F <package> test -- --changed`). ' +
      'Backend tests that need a database cannot run here; CI covers them.',
  },
];
