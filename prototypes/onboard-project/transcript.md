> **PROTOTYPE — sample transcript, partly simulated.** Repo signals for eq-alert (step 1) and the gh accounts are
> real, read 2026-10-10. Everything after the human's first reply is **illustrative**: no file was edited, no image
> built, no `bd init` run, and `src/smoke.ts` doesn't exist yet. The `next-env.d.ts` failure in the Smoke check is a
> **hypothesis**, not a measured result. Human turns are guesses for the human to react to.

# /onboard-project ~/Desktop/projects/personal/eq-alert

**Claude** — Reading eq-alert.

```
.sandcastle/main.mts     none
CI (.github/workflows)   none                          ← weakest-signal case: no prior answer, no CI steps
packageManager           pnpm@10.7.1, pnpm-lock.yaml   → standard pnpm installCommand, no post-install steps found
Node constraint          no engines.node, .nvmrc, .node-version → Node 22 is fine, shared agent image
scripts                  build, lint (next lint), test (jest) — no type-check script; tsconfig.json present
gitignored env files     .env  (keys: SUPABASE_URL, MAILTRAP_*, TRIGGER_SECRET_KEY, VERCEL_ACCESS_TOKEN, NEXT_PUBLIC_* … 19 keys)
compose services         mailpit only → dev mail catcher, checks don't run in it → no preflight / checkContainer
origin                   git@github.com:ghostza1209/earthquake-alert.git
origin/HEAD              not set; origin has main, feats/3d-globe, feats/boat, feats/draggable-pin; no develop
checked out              feats/boat (ignored: not a signal)
```

Draft entry:

```ts
{
  name: 'eq-alert',
  repoPath: join(projectsDir, 'personal/eq-alert'),
  baseBranch: 'main',                         // only long-lived branch on origin — confirm
  image: 'ysz-harness/agent',                 // always; not a choice
  copyToWorktree: ['.env'],                   // only candidate — keep or drop?
  installCommand: `CI=true pnpm install --frozen-lockfile --store-dir ${STORE_IN_SANDBOX}`,
  smokeCommand: 'pnpm exec tsc --noEmit && pnpm lint',   // no type-check script, so tsc directly; jest left out
  checkHint: 'Run `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm test -- <changed test files>`. ' +
    'Nothing here talks to Supabase or Trigger.dev; there is no CI, so these are the only checks.',
}
```

Three questions:
1. **baseBranch `main`?** No develop on origin, so PRs go to main.
2. **`.env` in copyToWorktree?** tsc and lint don't read it. Jest might (`NEXT_PUBLIC_*` flags). Listing it also
   makes publish refuse any branch that commits it. My lean: keep it.
3. **smokeCommand / checkHint OK?** Or should jest be part of the Smoke check (it's small here)?

**Human** — main yes. keep .env. leave jest out of smoke.

**Claude** — Appended the entry to `src/projects.ts` **without `image`** (not committed), so ysz ignores it if restarted now.

Host fixes:
- `ysz-harness/agent` image missing → built it (`docker build -f images/agent.Dockerfile -t ysz-harness/agent images`, 2m10s).
- eq-alert has no `.beads/` → ran `bd init --stealth` there (nothing tracked changed).

Smoke check, round 1:

```
$ npx tsx src/smoke.ts eq-alert
image      ysz-harness/agent  ok
clone      origin/main → ~/.cache/ysz-harness/clones/smoke-eq-alert  (copied: .env)
install    ok  58s
smoke      FAILED  exit 2  14s
  error TS2307: Cannot find module '…/marker.png' or its corresponding type declarations.   ← illustrative
  … (last 50 lines)
log        data/logs/smoke-eq-alert-1.log
```

Reading the log: `next-env.d.ts` is gitignored, so a fresh clone lacks the Next type references (CSS modules,
images). `next build` / `next dev` generate it; tsc alone doesn't, and Next 15.2 has no `next typegen`. Fix: write the
two reference lines first. `smokeCommand` → `'printf \'/// <reference types="next" />\\n/// <reference types="next/image-types/global" />\\n\' > next-env.d.ts && pnpm exec tsc --noEmit && pnpm lint'`,
same prefix added to checkHint. (Still in the scope you confirmed, so no re-ask; diff shown at the end.)

Smoke check, round 2: install ok 55s, smoke ok 41s. **Passed.**

Probes:
- [x] Push access: active account ghostza1209 → push `true` → ghUser omitted.
- [x] Remote: `git ls-remote origin main` ok.
- [x] copyToWorktree: `.env` exists.
- [x] preflight: none set.
- [ ] **Ready Tickets: none** (`bd init` just made an empty queue). Suggest a small first one, e.g.:
      `cd ~/Desktop/projects/personal/eq-alert && bd create --title="Remove obsolete version key from docker-compose.yml" --type=task`
      then `bd update <id> --add-label ready-for-agent` when you're happy with it. I won't add the label.
- [x] Own image: not needed.

Added `image: 'ysz-harness/agent'` to the entry. smokeCommand changed from your draft: prefixed the `next-env.d.ts` write.

Onboarding done; there's no Ready Ticket yet (ysz just has nothing to claim until then). Restart ysz to load
eq-alert; if Runs are in flight, pause from the Dashboard first. `src/projects.ts` is edited but not committed.
