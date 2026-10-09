import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Project {
  name: string;
  repoPath: string;
  baseBranch: string;
  /** Sandbox image (built by `npm run images`). A Project without one is not onboarded: its Tickets are never claimed. */
  image?: string;
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

const STORE_IN_SANDBOX = '/home/agent/.pnpm-store';

/**
 * The host pnpm store, so a sandbox install copies packages from disk instead of downloading them.
 * Checked 2026-10-09: the image's pnpm (corepack, pinned by the repo's packageManager) and the host's are
 * both 10.33.2, and an install against the mounted store reused all 2134 packages. If a pnpm upgrade makes
 * the stores incompatible and the install fails, delete this mount.
 */
function pnpmStoreMount(repoPath: string): NonNullable<Project['mounts']> {
  try {
    return [{ hostPath: execFileSync('pnpm', ['store', 'path'], { cwd: repoPath, encoding: 'utf8' }).trim(), sandboxPath: STORE_IN_SANDBOX }];
  } catch {
    return []; // no pnpm on the host: the install downloads instead
  }
}

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
    mounts: pnpmStoreMount(appRepo),
    copyToWorktree: ['.env', 'apps/backend/.env', 'apps/web/.env', 'apps/web-andalay/.env'],
    installCommand: `CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX}`,
    checkHint:
      'Run `pnpm run check-types`, then the unit tests of the packages you changed (`pnpm -F <package> test -- --changed`). ' +
      'Backend tests that need a database cannot run here; CI covers them.',
  },
];
