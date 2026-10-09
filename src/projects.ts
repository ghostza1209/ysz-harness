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
  /** Supplementary groups for the sandbox user, e.g. one that may use a mounted Docker socket. */
  groups?: (string | number)[];
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

// No Project mounts the host pnpm store: read-write, the agent could poison packages that host installs then run.
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
    // ADR 0001: root-equivalent host access, fazwaz only. Read-only is enough to connect. Group 0 owns the socket on Docker Desktop.
    mounts: [{ hostPath: '/var/run/docker.sock', sandboxPath: '/var/run/docker.sock', readonly: true }],
    groups: [0],
    copyToWorktree: ['.env'],
    checkHint:
      'Run PHP checks through the Docker CLI here. The compose `php` container sees the host checkout, not your clone, so run them in a throwaway container on your clone:\n' +
      "php=$(docker ps -q --filter label=com.docker.compose.project=fazwaz --filter label=com.docker.compose.service=php); " +
      `clone=$(docker inspect "$(hostname)" --format '{{range .Mounts}}{{if eq .Destination "/home/agent/workspace"}}{{.Source}}{{end}}{{end}}'); ` +
      `repo=$(docker inspect "$php" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'); ` +
      `image=$(docker inspect "$php" --format '{{.Config.Image}}')\n` +
      'then: docker run --rm -v "$clone:/var/www" -v "$repo/vendor:/var/www/vendor:ro" -w /var/www --network fazwaz_default "$image" <command>, ' +
      'e.g. `vendor/bin/phpcs --standard=phpcs.xml <changed files>` and `php artisan test --filter=<TestClass>`. ' +
      'Never run docker commands that touch other containers, volumes or the host checkout. Best-effort: CI covers the rest.',
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
