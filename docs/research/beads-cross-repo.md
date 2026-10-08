# Beads across Project repos: querying and claiming from the Orchestrator

Ticket: `ysz-harness-h4u.3`. Researched 2026-10-08.

**Sources**
- `bd` installed: **1.2.2 (Homebrew)**, `/opt/homebrew/bin/bd` (`bd version`). The latest upstream release is v1.3.1 (2026-09-30), per `gh api repos/gastownhall/beads/releases/latest`.
- Source: `github.com/gastownhall/beads`, tag `v1.2.2`, cloned into the scratchpad. File paths below are relative to that checkout.
- `bd <cmd> --help` output from the installed binary.
- My own runs. Reads against the three Project repos used `bd --readonly` only. Every write went to a throwaway `bd init -p lab` in the scratchpad's `beads-lab`.

**Project repos (from `.beads/metadata.json`):** all three use `"backend": "dolt", "dolt_mode": "embedded"`. None runs a Dolt server, and `git ls-files .beads` is empty in every repo, so bead data is never in git.

| Repo | Prefix | Total beads (`bd count`) |
|---|---|---|
| `~/Desktop/projects/work/fazwaz` | `laravel` | 133 |
| `~/Desktop/projects/work/PopDeal` | `PopDeal` | 60 |
| `~/Desktop/projects/personal/app` | `app` | 37 |

---

## 1. Targeting another repo's DB from one process

All of these worked from an unrelated cwd (`/private/tmp`) against the lab DB, and each returned the same `bd count` = 4:

| Mechanism | Example |
|---|---|
| `-C <repo>` (like `git -C`) | `bd -C ~/Desktop/projects/work/fazwaz ready --json` |
| `--db <path>` | `bd --db <repo>/.beads count`. `--db <repo>/.beads/embeddeddolt` also works. |
| `BEADS_DIR` env | `BEADS_DIR=<repo>/.beads bd count`. This is also the highest-priority config override (docs/CONFIG.md:32). |
| cwd (auto-discovery, walks up) | `cd <repo>/sub && bd count` |
| `BD_DB` env | Maps to `--db` (docs/CONFIG.md:61). I did not run it. |

`bd -C <repo> where` confirms what a call resolved to. For fazwaz it prints `database: …/fazwaz/.beads/embeddeddolt`.

**Recommendation:** shell out to the CLI with `-C <repo> --json`. Talking to Dolt directly is not an option in embedded mode: `bd sql` fails with "`'bd sql' is not yet supported in embedded mode`", and there is no server to connect to. Pass `--readonly` on every pure query. It blocks writes ("`operation 'comment' is not allowed in read-only mode`") and opens the store through `OpenForReadOnlyCommand`, which skips migrations (`cmd/bd/store_factory.go:56-61`).

Every invocation prints `warning: beads.role not configured (GH#2950)` on stderr. Parse stdout only.

## 2. Ready Ticket query and JSON fields

```bash
bd --readonly -C <repo> ready \
  -l ready-for-agent --exclude-label orchestrator:skip -u -n 0 --json
```

- `bd ready` means "open issues with no active blockers". It excludes `in_progress`, `blocked`, `deferred` and `hooked` (from `bd ready --help`).
- `-l` is AND across labels. `--exclude-label` drops an issue if it has ANY of the listed labels. `-u` keeps only unassigned issues. `-n 0` removes the default cap of 100.
- Sorting defaults to `priority`. `-s oldest` and `-s hybrid` are also available.
- Verified in the lab. Of four beads (A: ready-for-agent; B: ready-for-agent + orchestrator:skip; C: ready-for-agent but blocked by open D; D: no label), only `["lab-hc2"]` (A) came back.

JSON is an array of objects with these keys: `assignee, comment_count, created_at, created_by, dependencies, dependency_count, dependent_count, description, id, issue_type, labels, owner, parent, priority, status, title, updated_at`.

| Concept | Field | Example |
|---|---|---|
| priority | `priority` (int, 0 = highest) | `2` |
| labels | `labels` (string[]) | `["OP-2507","ready-for-agent"]` |
| assignee | `assignee` (string or `null`) | `"yoss"` |
| blockers | `dependencies[]` of `{issue_id, depends_on_id, type, created_at, created_by, metadata}`. `type` is `"blocks"` or `"parent-child"`. | |
| created | `created_at` (RFC3339 UTC) | `"2026-10-08T08:21:19Z"` |

The `dependencies` array includes blockers that are already closed. laravel-twu.10 lists 4 `blocks` deps, all `closed`, and it is still ready. Trust `bd ready` for blocker state rather than recomputing it. Comments need `bd show <id> --json --include-comments`.

### Finding: the "unassigned" rule excludes every current candidate

With `-u` the query returns **0** in all three repos. Without `-u`, fazwaz returns 3 (`laravel-twu.9/.10/.11`). Each of those has `status: open` and `assignee: "yoss"`: an assignee was left on a bead that is no longer in progress. Across all fazwaz beads, 113 of 133 carry `assignee=yoss`. `bd history` didn't show where the assignee came from, and `bd sql` is unavailable in embedded mode. In the lab, `bd q`/`bd create` left `assignee: null`, so the assignee must come from an earlier claim or an explicit `-a`.

**Decision needed (ticket h4u.4):** do we keep "unassigned" strict, which needs a cleanup of these stale assignees, or treat "open + assignee ∈ {"", the user}" as claimable? The second option is how `--claim` itself behaves (§3).

## 3. Claim semantics

`bd update <id> --claim` "sets assignee to you, status to in_progress; idempotent if already claimed by you" (`bd update --help`). "You" means `--actor`, then `$BEADS_ACTOR`, then git `user.name`, then `$USER`.

The claim is atomic. It runs as one conditional UPDATE inside a transaction (`internal/storage/issueops/claim.go:49-60`):

```sql
UPDATE issues SET assignee=?, status='in_progress', ...
WHERE id=? AND status='open' AND (assignee='' OR assignee IS NULL OR assignee=?)
```

If 0 rows are affected, the result is one of these:
- success, when the same actor already holds it in progress
- `ErrAlreadyClaimed` ("issue already claimed by X")
- `ErrNotClaimable` ("status …")

**Race test (lab):** I launched `--actor orch1` and `--actor orch2` claims on the same bead at the same moment. `orch2 rc=0`, and `orch1 rc=1` with `Error claiming lab-hc2: issue already claimed by orch2`. The final state was `{"assignee":"orch2","status":"in_progress"}`. Exactly one winner. Use the exit code to detect a lost race.

**Gotcha:** an open bead whose assignee equals the actor is claimable. If the Orchestrator claims as the default actor `yoss`, it will claim the stale-assigned fazwaz beads. If it claims as a distinct actor (e.g. `--actor orchestrator`, which gives a clean audit trail), those same beads fail with "already claimed by yoss".

- **Claim and pick in one step:** `bd ready --claim -l ready-for-agent --exclude-label orchestrator:skip -u --json` atomically claims the first match. The lab returned `{"id":"lab-hc2","assignee":"orch1","status":"in_progress"}`, and a second call returned `[]`. This only works within a single repo.
- **Release:** there is no `unclaim` command (`bd unclaim` gives "unknown command"). This works: `bd update <id> --assignee "" --status open`, which produced `{"assignee":null,"status":"open"}` in the lab.
- **Other writes, all verified in the lab:**
  - `bd update <id> --add-label needs-info --remove-label ready-for-agent`
  - `bd comment <id> "…"` (the author is the actor)
  - `bd close <id> -r "…"`
- **Atomic multi-write:** `bd batch` runs "multiple write operations in a single database transaction". Use it when a state transition needs label + comment + status to land together. I did not test this.

## 4. Concurrency with the user's own `bd`

**What the docs say:** embedded mode is "Single-writer (one process at a time)" (docs/DOLT.md:65). They also say "Embedded mode is single-writer (enforced via file lock). If you need concurrent access, switch to server mode" (docs/DOLT.md:411). Server mode (`dolt sql-server`) is the documented "Multi-Writer / Orchestrator" mode (docs/DOLT.md:70).

**What the code does:**
- The `embeddeddolt/.lock` flock is only taken during `bd init` (`cmd/bd/store_factory.go:73-93`, called only from `init.go:952`).
- Each store call opens a short-lived connection in an explicit transaction (`internal/storage/embeddeddolt/store.go:33-40`).
- The embedded driver is configured to **retry with exponential backoff and no deadline**, with a 5s max interval and "wait until ctx cancellation" (`internal/storage/embeddeddolt/open.go:40-43`).

**Measured (lab):**
- 10 parallel writes and 5 parallel reads: all 15 had exit code 0, and all 10 comments landed (11 total = 1 + 10). No "database is locked" errors.
- One write took 0.30s. 10 parallel writes took 5.33s, so they serialize.
- One read took 0.27s. 10 parallel reads of the same DB took 3.13s. **Reads serialize too.** Access is exclusive per process, not reader/writer.

**Conclusion:** concurrent `bd` processes on one embedded DB queue up rather than fail or corrupt anything. The Orchestrator and the user can both run `bd` against the same repo. The costs:
- (a) each waits behind the other, about 0.3s per op plus backoff.
- (b) a stuck `bd` process would block everyone else indefinitely, because the backoff has no max elapsed time.

So the Orchestrator should wrap every `bd` call in its own timeout (e.g. 30s) and treat a timeout as "retry next tick". It should not run long-lived bd processes such as `bd list --watch` against a Project repo. **No daemon or server is involved.** The repos' `.gitignore` still lists `daemon.*`, `bd.sock` and `dolt-server.*`, but those are legacy or server-mode entries. None of the three repos uses them.

Switching to server mode would give true multi-writer access. It would also change how the user runs bd in all three repos, so I don't recommend it for the MVP. Revisit if timeouts show up in practice.

## 5. Bead writes from inside the sandbox

**Recommendation: all bead reads and writes happen host-side, in the Orchestrator. The sandboxed agent never runs `bd` against a Project repo.** Reasons:

- **Git clone or copy in the sandbox:** `.beads` isn't tracked in any of the three repos, so a clone has no bead DB. `bd` there either finds nothing or, after a `bd init`/bootstrap, creates a **divergent, disconnected DB**. Writes to it silently never reach the host queue.
- **Bind-mounted working tree, or a git worktree whose `.git` points at the host repo:** worktrees share the main repo's `.beads` (docs/WORKTREES.md:7). The container's `bd` would then write the host's embedded Dolt files over the Docker Desktop file-sharing layer. That means a second writer outside the host's process space. Docs/FAQ.md:475 lists "Multiple processes writing to the database simultaneously" as a corruption cause. The container may also run a different `bd` version, and `bd` performs schema migrations on open (`--ignore-schema-skew` exists for "forward schema drift"). A newer bd in the container could migrate the user's DB.
- **What bd provides for sandboxes:**
  - `--readonly` ("block write operations (for worker sandboxes)").
  - `--sandbox` (embedded mode, no auto-push; docs/TROUBLESHOOTING.md:910-986). This targets network-restricted agents. It does nothing to address the shared-file problem.
- **If the agent needs ticket context:** have the Orchestrator inject `bd show <id> --json --include-comments` output into the sandbox as a file or prompt. The agent then reports outcomes (needs-info, done, comment text) back to the Orchestrator, which writes them host-side. Also make sure `.beads/` is not mounted read-write into the container.

## 6. Events or polling

There is no push, event or hook API for issue changes. `bd list --watch` is itself a 2-second poll. A comment in `cmd/bd/list.go:156-158` explains why: "Uses polling instead of fsnotify because Dolt stores data in a server-side database, not files — file watchers never fire." **The Orchestrator must poll.**

**Cost, measured:** one `ready` query takes about 0.20-0.28s wall and about 0.1s user CPU per repo. The three repos queried in parallel take 0.36-0.44s wall, since they are separate DBs and don't contend. At a 30-60s interval that is negligible. The real cost is that each poll briefly holds the repo's DB (§4), so a user's `bd` call may wait up to about 0.3s behind it. Keep the interval at 30s or more, and run the three repos concurrently.

## 7. Priority distribution

None of the three repos has a Ready Ticket right now.

| Repo | Open + ready-for-agent + not blocked (no `-u`) | With `-u` | ready-for-agent beads, any status | All open beads |
|---|---|---|---|---|
| fazwaz | 3: P2=3 (all assignee `yoss`) | 0 | 103: P1=14, P2=88, P3=1 (closed 98, in_progress 2, open 3) | P2=4, P3=2 (6 open) |
| PopDeal | 0 | 0 | 46: P2=46 (all closed) | none (0 open) |
| app | 0 (`app-aqw`, `app-o4t` are open but blocked) | 0 | 9: P2=9 (closed 5, in_progress 2, open 2) | P0=1, P1=1, P2=15, P3=2 |

Priority is the same 0-4 integer scale everywhere, but in practice it carries almost no signal. 143 of 158 ready-for-agent beads ever created are P2, and only fazwaz has used P1 for agent work. Cross-repo selection by priority alone will be essentially a tie. Use `created_at` (oldest first) as the tiebreaker, or round-robin across repos.

---

## Summary for the design (h4u.4)

- Query with `bd --readonly -C <repo> ready -l ready-for-agent --exclude-label orchestrator:skip -u -n 0 --json`, polled every 30s or more, with the three repos in parallel.
- Claim with `bd -C <repo> --actor <name> update <id> --claim`. It's atomic. Exit code 1 means someone else won.
- Release with `update <id> --assignee "" --status open`.
- Every `bd` call needs a timeout. Embedded Dolt serializes all access and waits indefinitely.
- Only the host writes beads. The sandbox never sees `.beads`.
- Open decision: the actor identity, and the stale `assignee=yoss` on open beads, which currently hides every candidate from `-u`.
