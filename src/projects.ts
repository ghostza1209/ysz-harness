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
  /** UID/GID of the image's `agent` user; sandcastle defaults to the host's, which differs from the image on macOS. */
  containerUid?: number;
  containerGid?: number;
  /** ADR 0002: the running compose service whose image the agent's `php-check` runs commands in, on its clone. */
  checkContainer?: { composeProject: string; service: string };
  /** Gitignored files copied from the repo into each Run's worktree; missing ones are skipped. */
  copyToWorktree?: string[];
  /** Runs inside the sandbox before the agent starts, to install dependencies. */
  installCommand?: string;
  /** Tells the agent which checks to run. Best-effort: the sandbox may lack a database. */
  checkHint?: string;
}

const projectsDir = join(homedir(), 'Desktop/projects');

// No Project mounts the host pnpm store: read-write, the agent could poison packages that host installs then run.
// Measured 2026-10-09 on a scratch clone of thaivis (install only, Docker, pnpm 10.33.2): no mount 113s; read-only
// mount fails (pnpm writes to the store to register the project); per-Run copy-on-write copy of the 7GB store 67s
// to copy + 133s to install. No mount wins, so there is nothing to build.
const STORE_IN_SANDBOX = '/home/agent/.pnpm-store';

const appRepo = join(projectsDir, 'personal/app');
const popdealRepo = join(projectsDir, 'work/PopDeal');

// Edit and restart to add or change a Project.
export const projects: readonly Project[] = [
  {
    name: 'fazwaz',
    repoPath: join(projectsDir, 'work/fazwaz'),
    baseBranch: 'develop',
    image: 'ysz-harness/fazwaz',
    // Not running means the compose stack is down: `exec` exits non-zero then.
    preflight: ['docker', 'compose', 'exec', '-T', 'php', 'true'],
    containerUid: 1000,
    containerGid: 1000,
    checkContainer: { composeProject: 'fazwaz', service: 'php' },
    copyToWorktree: ['.env'],
    checkHint:
      'Run PHP checks with `php-check <command>`: it runs <command> in a throwaway container of the fazwaz php image, on your clone, ' +
      'e.g. `php-check vendor/bin/phpcs --standard=phpcs.xml <changed files>` and `php-check php artisan test --filter=<TestClass>`. ' +
      'One command at a time. Best-effort: CI covers the rest.',
  },
  {
    name: 'PopDeal',
    repoPath: popdealRepo,
    baseBranch: 'develop',
    image: 'ysz-harness/popdeal',
    // No host pnpm store mount (see STORE_IN_SANDBOX). Read-only does not work either: pnpm 12 writes its index.db
    // and fails with EROFS, then downloads everything anyway. A cold install takes about 1m20s.
    // Explicit, not a glob: copyToWorktree is the list of secret files publish refuses to commit.
    copyToWorktree: ['apps/web/.env', 'apps/web/.env.local', 'apps/mobile/.env', 'apps/mobile/.env.local'],
    installCommand: `CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX}`,
    checkHint: 'Run `pnpm web:check` for changes under apps/web and `pnpm mobile:check` for changes under apps/mobile (both run type-check, lint and tests).',
  },
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
