<p align="center">
  <img src="web/public/logo.svg" width="96" alt="ysz-harness logo" />
</p>

<h1 align="center">ysz-harness</h1>

<p align="center"><b>English</b> · <a href="README.th.md">ไทย</a></p>

**ysz** picks Ready Tickets from each Project's Beads queue, runs a Claude agent on each one in an isolated Docker sandbox, has a second agent review the work, then opens a pull request for you to review. It never merges. See [GLOSSARY.md](GLOSSARY.md) for the terms used here.

## How a Run works

1. You label an open bead `ready-for-agent` in a Project's repo.
2. When a slot is free (at most one Run per Project), ysz claims the Ticket and clones the repo on `agent/<ticket-id>`.
3. The **Implement agent** works the Ticket in a sandbox; the **Review agent** then reviews and corrects it. A failed Attempt is retried once.
4. The host pushes the branch and opens a PR against the Project's `baseBranch`. The bead gets a comment with the link and the `in-review` label.
   A Ticket whose only unclosed blocker is `In review` does not wait for that merge: its Run clones the blocker's `agent/<id>` branch and opens a stacked PR onto it (`gh stack link`, needs the `gh-stack` extension). See [ADR 0005](docs/adr/0005-in-review-unblocks-dependents-as-stacked-prs.md).
   A Ticket whose parent epic is labelled `epic-branch` clones and opens its PR onto `epic/<epic-id>` (the Project's `epicBranchPrefix`) instead, so `baseBranch` gets one PR per epic. See [ADR 0006](docs/adr/0006-epic-branch-collects-an-epics-prs.md).
5. If the agent needs information, the bead is handed back with a comment and the `needs-info` label.

An epic labelled `ready-for-agent` with no children is a **Spec**. Its Run has no Review agent and no PR: a breakdown agent splits it into child Tickets, which ysz creates under the epic already labelled `ready-for-agent`. They join the queue on the next poll. See [ADR 0007](docs/adr/0007-ysz-breaks-a-childless-spec-down.md).

## Requirements

- Node.js 22+ and npm
- Docker (running)
- [`bd`](https://github.com/gastownhall/beads) (Beads) set up in each Project's repo
- [`gh`](https://cli.github.com/) logged in to every account that opens PRs (`gh auth status`)
- [`claude`](https://docs.claude.com/en/docs/claude-code) CLI on the host (writes the PR body)

## Setup

```bash
npm install
npm run images                     # build the sandbox images from images/*.Dockerfile
claude setup-token                 # copy the token it prints
echo 'CLAUDE_CODE_OAUTH_TOKEN=<token>' > .env
```

Then add or edit your Projects in [`src/projects.ts`](src/projects.ts): repo path, base branch, sandbox image, files to copy into the worktree (`.env`), install command and check hint. A Project without an `image` is never picked.

## Running

```bash
npm start          # builds the Dashboard, then starts ysz (PORT defaults to 4000)
```

Open the URL it prints (`http://localhost:4000/?token=…`). The token is kept in `data/dashboard-token`; delete that file to rotate it.

## Day-to-day use

| You want to | Do this |
| --- | --- |
| Queue a Ticket | **Mark Ready** on its row in the Dashboard's Backlog tab (or `bd update <id> --add-label ready-for-agent` in the Project's repo) |
| Keep a Ticket away from ysz | **Skip ysz** on its row in the Backlog tab (or `bd update <id> --add-label orchestrator:skip`) |
| Have ysz split a Spec into Tickets | `bd update <epic-id> --add-label ready-for-agent` on an epic with no children, once the Spec is final |
| Collect an epic's PRs on one branch | `bd update <epic-id> --add-label epic-branch`, then open `epic/<epic-id>` → `baseBranch` yourself when its children are merged |
| Stop picking from a Project | Click the Project's pill at the top of the Dashboard (click again to resume) |
| Stop a live Run | **Kill** on its card: the Ticket gets `orchestrator:skip` |
| Resume a Run stuck in a host step | **Retry host step** on its card |
| Send a failed Run's Ticket back to the Ready queue | **Retry** on its History row |
| Read what a Run did | **Log** in the History list |

After a Run ends `In review`, review and merge the PR yourself: ysz closes the bead once it sees the merge. When a stack falls behind `baseBranch`, press **Rebase stack** on the PR.

## Development

```bash
npm test           # unit tests
npm run test:contract  # the Beads gateway against the real bd
npm run typecheck
```

Code lives in `src/` (server, ysz core, sandbox, host steps) and `web/` (the Dashboard). Design decisions are in [`docs/adr`](docs/adr).
