> **PROTOTYPE — throwaway, not a live skill.** Answers ysz-harness-q5b.6 ("What does an /onboard-project
> session look like end to end?"). Assumes two things that don't exist yet: the shared `ysz-harness/agent`
> image (ysz-harness-fzo) and `src/smoke.ts` + the `smokeCommand` field (decided in q5b.4).

---
name: onboard-project
description: Onboard a new Project into ysz — read its repo, draft its src/projects.ts entry for the human to confirm, fix safe host prerequisites, run the Smoke check. Use on /onboard-project <repo-path>.
---

# /onboard-project <repo-path>

Goal: the Project is onboarded (GLOSSARY: Onboarding) — its Ready Tickets can be claimed and its Runs can check
their own work. Never leave a half-onboarded entry loaded by ysz: the human restarts ysz only at the end.

Supported stacks: Node 22 (pnpm/npm) and PHP + compose (checkContainer). Anything else → stop, report "new stack,
out of scope".

## 1. Read (no writes)

Read in this order, strongest signal first. Show the human file and key **names**, never env values.

1. `.sandcastle/main.mts` — prior answer for baseBranch, copyToWorktree, install + post-install steps.
2. CI config (`.github/workflows/*`) — PR base branches, every step between install and the checks, `services:`
   (a DB service → DB-bound checks can't run in the sandbox).
3. `package.json`: `packageManager`, lockfile, scripts (`type-check`, `check-types`, `lint`, `*:check`, `test`),
   `engines.node`; `.nvmrc`, `.node-version`. Any Node constraint Node 22 doesn't satisfy → report "needs its own
   `<project>.Dockerfile`", stop.
4. `git ls-files -oi --exclude-standard` → env-like gitignored files (copyToWorktree candidates).
5. `docker compose config --services` (only if a compose file exists) — the signal for checkContainer is "checks
   only run inside a compose service", not "a compose file exists".
6. Git: `origin/HEAD`, which of `develop`/`main`/`master` exist on origin, any main→develop sync workflow.
   The currently checked-out branch is never the signal.

## 2. Draft and confirm (one message, one round)

Present the draft entry as a code block plus a short "why" per field, and ask only what needs a human:

- **baseBranch** — always confirm (origin/HEAD was wrong for thaivis).
- **copyToWorktree** — list candidates; human picks. Explicit names, never a glob (it is publish's secret denylist).
  Include a file only if install or smokeCommand reads it.
- **smokeCommand** — fresh-clone prep (codegen/build) + type-check (+ lint if quick), serial, no test suite.
- **checkHint** — what the agent should run; say what CI covers instead.

Never asked, never chosen: `image` is always `'ysz-harness/agent'`. `containerUid/Gid` omitted. `ghUser` comes from
the probe in step 4, not from the human. `installCommand` is mechanical from the lockfile
(`CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX}`) plus post-install steps from CI.

After the human confirms: edit `src/projects.ts` (append the entry **without `image`**). Do **not** commit.
A Project without `image` is not onboarded, so a restart of ysz mid-session never loads a half-onboarded Project.
`image` is added last, in step 6.

## 3. Host fixes (do them, then say what you did)

Only what is local, reversible, secret-free and touches no tracked file in the Project's repo:

- `docker image inspect ysz-harness/agent` fails → build it (`docker build -f images/agent.Dockerfile -t ysz-harness/agent images`), not `npm run images`.
- No `.beads/` in the repo → `bd init --stealth` there.

## 4. Smoke check

`npx tsx src/smoke.ts <project>` via Bash. Pass = install and smokeCommand both exit 0 within 10 / 15 min.

`smoke.ts` uses `project.image ?? 'ysz-harness/agent'`, so it runs before `image` is set.

On failure: read the full log at the printed path, fix `smokeCommand` in `src/projects.ts` yourself if the fix stays
in the confirmed scope (fresh-clone prep, type-check, lint); show the diff in the closing message. A fix that changes
scope (drops lint, adds tests, touches installCommand or copyToWorktree) → ask first. Rerun.
At most 3 rounds, then stop and hand the human the failing step, last lines and log path.
checkContainer Projects: smoke reports "not supported" — say so and continue; this is an open question on the map.

## 5. Probe and report (never fix)

Run each, collect results, report as a checklist with the exact command for anything the human must do:

- **Push access**: for each `gh auth status` account, `GH_TOKEN=$(gh auth token -u <a>) gh api repos/<owner>/<repo> --jq .permissions.push`.
  Active account has push → omit ghUser. Another account → set ghUser (edit projects.ts, tell the human). None → report `gh auth login`.
- **Remote**: `git ls-remote origin <baseBranch>`.
- **copyToWorktree** files: existence only. Missing → "Runs skip it; the Smoke check may fail". Never copy `.env.example`.
- **preflight** (if set): run once. Never start compose.
- **Ready Tickets**: `bd ready` in the repo (with ysz's readiness filter). None → suggest one small first Ticket
  and the exact `bd update <id> --add-label ready-for-agent` command. Never add the label yourself.
- **Own image needed** (extra CLI/apt): report that the human writes `images/<project>.Dockerfile FROM ysz-harness/agent`.

## 6. Close

Only when the Smoke check passed and nothing in step 5 is a blocker, add `image: 'ysz-harness/agent'` to the
entry (the Onboarding switch), then:

> Onboarding done. Restart ysz to load <project>. If Runs are in flight, pause from the Dashboard first.
> src/projects.ts is edited but not committed.

Otherwise: list the blockers and leave the entry without `image`; ysz ignores it until a rerun adds it.
No Ready Tickets is not a blocker: Onboarding means they *can* be claimed. Suggest a first one instead.
