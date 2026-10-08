# Research: can sandcastle run one Claude Code agent per Ticket in Docker?

Ticket: `ysz-harness-h4u.2` · Researched 2026-10-08

**Verdict: yes, it fits.** Sandcastle is a TypeScript library, not a service. It runs headless Claude Code (`claude --print --output-format stream-json`) in a Docker container against a git worktree that lives on the host, on a branch you name. It also already runs on this machine. `fazwaz/.sandcastle/` and `app/.sandcastle/` both use it for the same `ready-for-agent` beads loop the Orchestrator is meant to automate. In practice that means a Node/TypeScript Orchestrator that calls `run()` once per Ticket. The agent only commits. Push and `gh pr create` happen on the host.

## Where sandcastle lives

| Location | Finding |
|---|---|
| `which sandcastle`, `npm ls -g`, `~/Desktop/projects/personal/sandcastle` | Not installed globally. The `sandcastle` directory is empty. |
| `~/Desktop/projects/personal/read-sandcastle-log/README.md` | A separate TUI that reads `.sandcastle/logs/*.log`. It isn't sandcastle itself, but it shows the log files are human-readable. |
| `~/Desktop/projects/work/fazwaz/.sandcastle/` | **Real install**: `@ai-hero/sandcastle@0.12.0` in a local `node_modules`, plus a custom `Dockerfile`, `main.mts` (implement→review loop over `bd ready --label ready-for-agent`), prompts and logs. Gitignored by fazwaz (`.gitignore:44: /.sandcastle/`). |
| `~/Desktop/projects/personal/app/.sandcastle/` | Same pattern (thaivis). Committed to the repo. No `node_modules`. |
| `~/Desktop/projects/work/PopDeal/.sandcastle/` | Does not exist. |
| npm | `@ai-hero/sandcastle` latest = `0.12.0` (published 2026-06-29). Repo = `github.com/mattpocock/sandcastle`. |
| GitHub | `mattpocock/sandcastle`: latest release v0.12.0, main was pushed 2026-10-08 and is under active development, unreleased. |
| Docker | `docker info` → Docker Desktop, server 29.8.2. Available. Host Node is v22.22.3. |

Below, **README** means `fazwaz/.sandcastle/node_modules/@ai-hero/sandcastle/README.md` and **dist** means `.../@ai-hero/sandcastle/dist/` (v0.12.0, the published build). Line numbers refer to those files.

## 1. Headless Claude Code in Docker against a host repo or worktree

**Yes.**

- **Command.** `claudeCode(model)` builds `claude --print --verbose [--dangerously-skip-permissions | --permission-mode X] --output-format stream-json --model M [--effort E] -p -`, with the prompt on stdin (dist/index.js:3415-3433). Permissions are skipped by default on AFK runs (README:969).
- **Repo selection.** `run({ cwd })` picks the host repo, so one Orchestrator process can target any of the three repos (README:167-170, 838). Gotcha: `promptFile` resolves against `process.cwd()`, **not** `cwd` (README:840).
- **Branch strategies** (README:548-558, 1263-1277):
  - `head` writes straight into the host working dir. This is the default for Docker. It is unsafe for concurrent Runs.
  - `merge-to-head` uses a temp branch and merges it back into HEAD. Not what we want.
  - `{ type: "branch", branch, baseBranch? }` creates a git worktree at `<repo>/.sandcastle/worktrees/<branch>` on the host (dist/chunk-VOG34SRF.js:25267). Commits land on a real local branch in the host `.git`. **Use this one: one branch per Ticket.** Re-running with the same branch reuses the worktree (README:554, ADR 0003). Git refuses to check out the same branch in two worktrees and sandcastle errors clearly if you try (chunk-VOG34SRF.js:25304).
- **Mounts.** The worktree is bind-mounted at `/home/agent/workspace` (chunk-VOG34SRF.js:26406). The host `.git` directory, the main repo's gitdir for a worktree, is mounted at **the same absolute host path** inside the container, so the worktree's `gitdir:` pointer resolves (`resolveGitMounts`, chunk-VOG34SRF.js:26454-26470). Sandcastle also copies the host `git config user.name/email` into the container (chunk-VOG34SRF.js:25888-25913) and adds `safe.directory` (dist/index.js:1950).
- **Container.** `docker run -d --name sandcastle-<uuid> -e … -v … -w … --user uid:gid <image>` (dist/chunk-CP3TYXZA.js:71-107, 124-125). The image is per repo (`sandcastle:<repo-dir-name>` by default). You build it with `npx sandcastle docker build-image`, or use your own Dockerfile (README:798-805). The image must keep a non-root `agent` user, `git` and the Claude CLI (README:1345-1350).
- **Result.** `RunResult` has `{ commits: {sha}[], branch, completionSignal, stdout, iterations[{sessionId, usage}], logFilePath, output? }` (README:856-883).
- **Gitignored files.** `copyToWorktree: [".env"]` copies them into the worktree. fazwaz already does this (fazwaz main.mts; README:203-205).

**Concurrency (max 2 Runs).** Two `run()` calls with different `branch` values get separate worktrees and separate containers, because container names are random UUIDs. README:952 (ADR 0018) says concurrent runs are safe only with distinct `branch` strategies. One existing hazard: fazwaz's setup bind-mounts the shared `.beads` Dolt store into the sandbox. Two concurrent agents writing `bd` in the same repo is untested.

## 2. Claude subscription auth (not API key)

- **Mechanism.** Run `claude setup-token` on the host and put the result in `CLAUDE_CODE_OAUTH_TOKEN` in `<repo>/.sandcastle/.env`. Sandcastle injects it as a container env var (`-e`). This is in README:42 and in the `sandcastle init` text (dist/main.js:18364, 18529). The maintainer confirmed it as the supported path when closing upstream issue #191 on 2026-06-15: "Acquire an oauth token by using `claude setup-token`. Paste it to CLAUDE_CODE_OAUTH_TOKEN in your `.sandcastle/.env`" (https://github.com/mattpocock/sandcastle/issues/191).
- **Already in use here.** `fazwaz/.sandcastle/.env` and `app/.sandcastle/.env` both define `CLAUDE_CODE_OAUTH_TOKEN`. Only variable names were inspected, not values.
- **Env resolution gotcha.** Only keys **declared** in `.sandcastle/.env` reach the container. Each value comes from the file or, if blank there, from `process.env` (`resolveEnv`, dist/index.js:627-639). An Orchestrator can also pass env explicitly with `claudeCode(m, { env })` or `docker({ env })`. Those two must not share keys (README:1000-1022).
- **Policy.** Anthropic's article "Use the Claude Agent SDK with your Claude plan" says `claude -p`, the Agent SDK and third-party apps **still draw from subscription limits**. Since 2026-10-07, Max and Team plans also include monthly API credits covering those uses (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Two parallel AFK Runs will use subscription rate limits quickly; one #191 commenter hit "out of extra usage".

## 3. Git push and `gh pr create` credentials

- **Sandcastle doesn't forward SSH.** It doesn't mount `~/.ssh` and doesn't pass `SSH_AUTH_SOCK`; the only mounts are the worktree, `.git` and your `mounts` (dist/chunk-CP3TYXZA.js:124-128). fazwaz (`git@github.com:FazWaz/Web.git`) and PopDeal (`git@github.com:FazWaz/PopDeal.git`) use SSH remotes, so `git push` inside the container would fail. Inside the container, only `GH_TOKEN`-based HTTPS auth (via `gh`) would work, which needs an `insteadOf` rewrite. thaivis/app uses `https://github.com/thaivis/app.git`.
- **Push and PR on the host work, and are the established pattern.** The branch is a normal local branch in the host repo, and the worktree is a host directory. After `run()` resolves, the Orchestrator can run `git -C <repo> push -u origin <branch>` with the user's SSH agent, then `gh pr create --head <branch> --base <base>` with the host `gh` login. fazwaz's `main.mts` already ends this way: its prompt says "Never push to remote", and the script prints the `git push` and `gh pr create` commands (fazwaz `.sandcastle/main.mts`, end of file; `implement-prompt.md:50`).
- **Recommendation.** Keep credentials out of the container. The agent commits; the host pushes and opens the PR. Never merge. Don't put a `GH_TOKEN` in the sandbox env unless the agent needs read access to issues.

## 4. User-level `~/.claude` plugins and skills in the container

- **Not by default.** The container's `HOME` is `/home/agent` (dist/chunk-CP3TYXZA.js:137-140) and sandcastle never mounts the host `~/.claude`. Its only `~/.claude` handling is copying session JSONL **out** of `/home/agent/.claude/projects` (dist/index.js:2944; README:885-891). `claudeCode()` has no extra-args or `--plugin-dir` option (dist/index.js:3415-3433).
- **Mounting `~/.claude/plugins` wholesale is fragile.** `installed_plugins.json` stores absolute host paths, for example `"installPath": "/Users/ysz/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.1"`. Enabling a plugin also needs `enabledPlugins` in settings.
- **Workarounds**, cheapest first:
  - **A. Write the PR body on the host (recommended).** After the Run, the Orchestrator runs host `claude -p` in the worktree, where `~/.claude` plugins load natively, and asks it to write the PR body with `mattpocock-skills:pr`. Then it calls `gh pr create --body-file`. This fits the host-side push/PR flow from §3. Cost: one extra small Claude call per Ticket.
  - **B. Mount the one skill into the container.** `pr` is a single self-contained `SKILL.md` (`~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.1/skills/engineering/pr/`). Use `docker({ mounts: [{ hostPath: "<that dir>", sandboxPath: "/home/agent/.claude/skills/pr", readonly: true }] })`. User-level skills load from `~/.claude/skills`, and inside the container it is named `pr`, not `mattpocock-skills:pr`. Pre-create `/home/agent/.claude` in the Dockerfile as the `agent` user, otherwise Docker may create the mount parent root-owned and Claude can't write `~/.claude`. The agent can hand the body back with `output: Output.string({ tag: "pr_body" })` (README:685-711; requires `maxIterations: 1`). **Untested.**
  - **C. Wrap the provider.** Spread `claudeCode()` and override `buildPrintCommand` to inject `--plugin-dir <mounted path>`, since `AgentProvider` is a plain object. **Untested.** It relies on internal shape, so it's more brittle than A or B.

## 5. Run status, logs, exit result, kill

Everything is **in-process**. There is no daemon, HTTP API or CLI `run` command.

- **Status and exit.** `await run(...)` resolves to `RunResult` (§1) or throws. Errors include `AgentError`, `AgentIdleTimeoutError` after 600 s without output by default, and `StructuredOutputError`. Error paths carry `preservedWorktreePath` (dist/chunk-VOG34SRF.js:26430-26450; README:240, 713). `completionSignal` (an array is allowed) lets the prompt report outcomes such as `COMPLETE` or `NO_WORK`; the fazwaz loop uses both.
- **Logs.** By default they go to a human-readable file at `<repo>/.sandcastle/logs/<branch…>-<name>.log` (dist/index.js:1066-1074). The format looks like "Run started / Setting up sandbox / Agent started / Bash(...)", as in the fazwaz logs. `logging: { type: "file", path, verbose, onAgentStreamEvent }` gives a **live callback** for each text chunk, tool call or raw line; callback errors are swallowed (README:216-234). An Orchestrator UI can stream these events. `usage` per iteration gives token counts (README:868-883).
- **Kill.** `run({ signal: AbortSignal })` kills the in-flight agent subprocess, cancels hooks and preserves the worktree (README:852; dist/index.d.ts:560-570). Container cleanup is registered on process shutdown and does `docker rm -f` (dist/chunk-CP3TYXZA.js:197-205). Containers carry no labels, so cleaning up orphans after a hard crash means matching the name prefix `sandcastle-`.

## 6. Language and API, and what that means for the stack

- It is a **TypeScript ESM library**: `import { run, claudeCode, createSandbox, createWorktree } from "@ai-hero/sandcastle"` plus `@ai-hero/sandcastle/sandboxes/docker` (package.json `exports`; dist/index.d.ts:1051). It uses Effect internally, but the public API is Promise-based.
- The CLI (`bin: sandcastle`) only scaffolds and manages images: `init`, `docker build-image`, `docker remove-image` (README:764-831). **There is no CLI for running an agent.**
- **What this means:** build the Orchestrator in Node/TypeScript (run with `tsx`, the way the existing `main.mts` files are) and call `run()` directly. Concurrency is plain promise management, for example a two-slot semaphore. A Python or Go Orchestrator would have to shell out to a TS script per Run and parse its stdout or log file, which loses `onAgentStreamEvent`, `AbortSignal` and the typed results.
- **Per-Project config** maps onto `run({ cwd, sandbox: docker({ imageName, mounts, env, containerUid… }), hooks, copyToWorktree, promptFile })`. Existing per-repo setups, such as fazwaz's host docker-compose check, Docker-socket mount and `bd` version pin, are worth reusing as each Project's config (fazwaz `.sandcastle/main.mts`).

## 7. Blockers, risks, alternatives

- **No hard blocker.**
- **Pre-1.0 churn.** v0.12.0. Main is moving and the API has changed before, e.g. "Branch strategy is now configured on `run()`, not on the provider" (README:1279). Pin the exact version.
- **Subscription limits** with two parallel AFK Runs (§2).
- **PopDeal has no `.sandcastle/`.** It needs a Dockerfile/image and an `.env` with `CLAUDE_CODE_OAUTH_TOKEN`.
- **Repos that need host services.** fazwaz's agent runs PHP through the host's `docker compose` via a mounted Docker socket. That is effectively host-root access from the sandbox; accept it knowingly.
- **Shared `.beads` mount plus concurrency** (§1) is untested.
- **Alternatives if it doesn't fit:**
  - Use sandcastle's `createWorktree` and `createSandbox` primitives for finer control (README:261-546).
  - Write a custom provider with `createBindMountSandboxProvider` (README:1024-1155).
  - Skip sandcastle: `git worktree add` + `docker run … claude -p --output-format stream-json` directly. That is a small amount of code, but you would rebuild the gitdir mounts, session capture, idle timeouts and cleanup that sandcastle already does.

## Sources

- `@ai-hero/sandcastle@0.12.0` package as installed: `~/Desktop/projects/work/fazwaz/.sandcastle/node_modules/@ai-hero/sandcastle/{README.md,package.json,dist/*}`
- https://github.com/mattpocock/sandcastle (release v0.12.0; commit log as of 2026-10-08)
- https://github.com/mattpocock/sandcastle/issues/191 (subscription auth)
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Local usage: `~/Desktop/projects/work/fazwaz/.sandcastle/{main.mts,Dockerfile,implement-prompt.md,.env.example}`, `~/Desktop/projects/personal/app/.sandcastle/`
- `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/cache/mattpocock/mattpocock-skills/1.3.1/skills/engineering/pr/SKILL.md`
