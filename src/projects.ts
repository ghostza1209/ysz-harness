import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Project {
  name: string;
  repoPath: string;
  baseBranch: string;
  /** ADR 0006: the children of an epic labelled `epic-branch` open their PRs onto `<prefix><epic-id>`. Default `epic/`. */
  epicBranchPrefix?: string;
  /** Sandbox image (built by `npm run images`). A Project without one is not onboarded: its Tickets are never claimed. */
  image?: string;
  /** Host command (argv) run in the repo before each claim; a non-zero exit means infrastructure is down (e.g. a compose service) and nothing is claimed. */
  preflight?: string[];
  /** UID/GID of the image's `agent` user; sandcastle defaults to the host's, which differs from the image on macOS. */
  containerUid?: number;
  containerGid?: number;
  /** ADR 0002: the running compose service whose image the agent's `php-check` runs commands in, on its clone. */
  checkContainer?: { composeProject: string; service: string };
  /** `gh` account that opens the Project's PRs; omitted means gh's active account. Logged in accounts: `gh auth status`. */
  ghUser?: string;
  /** Gitignored files copied from the repo into each Run's worktree; missing ones are skipped. */
  copyToWorktree?: string[];
  /** Runs inside the implement sandbox before the agent starts, to install dependencies; review reuses its node_modules. */
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
    ghUser: 'yoss1209',
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
    ghUser: 'yoss1209',
    repoPath: popdealRepo,
    baseBranch: 'develop',
    image: 'ysz-harness/popdeal',
    // No host pnpm store mount (see STORE_IN_SANDBOX). Read-only does not work either: pnpm 12 writes its index.db
    // and fails with EROFS, then downloads everything anyway. A cold install takes about 1m20s.
    // Explicit, not a glob: copyToWorktree is the list of secret files publish refuses to commit.
    copyToWorktree: ['apps/web/.env', 'apps/web/.env.local', 'apps/mobile/.env', 'apps/mobile/.env.local'],
    installCommand: `CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX}`,
    checkHint:
      'For changes under apps/web, run from apps/web with paths relative to it: `pnpm exec eslint <changed files>`, ' +
      '`pnpm exec jest --findRelatedTests --passWithNoTests <changed files>`, then `pnpm web:type-check`. ' +
      'apps/mobile is the same, with `pnpm mobile:type-check`. A change under packages/ type-checks every app that imports it. ' +
      'Run `pnpm lint:duplicate-types` when you add or change a type.',
  },
  {
    name: 'thaivis',
    repoPath: appRepo,
    baseBranch: 'develop',
    image: 'ysz-harness/app',
    copyToWorktree: ['.env', 'apps/backend/.env', 'apps/web/.env', 'apps/web-andalay/.env'],
    // Apps import @repo/shared from its gitignored dist/ (2s to build). Review reuses the clone, dist/ included.
    // Prisma's client is left to the hint: generating it takes 25s, and only backend changes need it.
    installCommand: `CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX} && pnpm -F @repo/shared build`,
    // Not `test -- --changed`: it sees only uncommitted files, so it finds nothing once implement has committed.
    // Backend eslint heap: measured 2026-10-18 on booking.service.ts (12k lines) in ysz-harness/app, node's default
    // 4144MiB heap runs out at 68s; 8192MiB passes in 64s at a 5.2GiB container peak.
    checkHint:
      'Run each check from the directory of the package you changed, with paths relative to it: ' +
      '`pnpm check-types`, `pnpm exec eslint <changed files>`, then the tests related to those files: ' +
      '`pnpm exec vitest related --run <changed files>`, or in apps/mobile-internal, which uses jest, ' +
      '`pnpm exec jest --findRelatedTests --passWithNoTests <changed files>`. ' +
      'In apps/backend, run `pnpm exec prisma generate` first, run eslint as ' +
      '`NODE_OPTIONS=--max-old-space-size=8192 pnpm exec eslint <changed files>` like the backend `lint` script, ' +
      'and add `--config vitest.unit.config.ts` to vitest; ' +
      'the backend integration tests need a database, which this sandbox lacks, so CI covers them. ' +
      'Apps import packages/shared from its build: after changing it, run `pnpm build` there before checking them.',
  },
];
