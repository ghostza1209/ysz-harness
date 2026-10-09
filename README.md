<p align="center">
  <img src="web/public/logo.svg" width="96" alt="ysz-harness logo" />
</p>

<h1 align="center">ysz-harness</h1>

<p align="center"><b>English</b> · <a href="README.th.md">ไทย</a></p>

An **Orchestrator** that picks Ready Tickets from each Project's Beads queue, runs a Claude agent on each one in an isolated Docker sandbox, has a second agent review the work, then opens a pull request for you to review. It never merges. See [GLOSSARY.md](GLOSSARY.md) for the terms used here.

## How a Run works

1. You label an open bead `ready-for-agent` in a Project's repo.
2. When a slot is free (at most one Run per Project), the Orchestrator claims the Ticket and clones the repo on `agent/<ticket-id>`.
3. The **Implement agent** works the Ticket in a sandbox; the **Review agent** then reviews and corrects it. A failed Attempt is retried once.
4. The host pushes the branch and opens a PR against the Project's `baseBranch`. The bead gets a comment with the link and the `in-review` label.
5. If the agent needs information, the bead is handed back with a comment and the `needs-info` label.

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
npm start          # builds the Dashboard, then starts the Orchestrator (PORT defaults to 4000)
```

Open the URL it prints (`http://localhost:4000/?token=…`). The token is kept in `data/dashboard-token`; delete that file to rotate it.

## Day-to-day use

| You want to | Do this |
| --- | --- |
| Queue a Ticket | `bd update <id> --add-label ready-for-agent` in the Project's repo |
| Keep a Ticket away from the Orchestrator | `bd update <id> --add-label orchestrator:skip` |
| Stop picking from a Project | Click the Project's pill at the top of the Dashboard (click again to resume) |
| Stop a live Run | **Kill** on its card: the Ticket gets `orchestrator:skip` |
| Resume a Run stuck in a host step | **Retry host step** on its card |
| Read what a Run did | **Log** in the History list |

After a Run ends `In review`, review and merge the PR yourself, then close the bead.

## Development

```bash
npm test           # unit tests
npm run typecheck
```

Code lives in `src/` (server, Orchestrator core, sandbox, host steps) and `web/` (the Dashboard). Design decisions are in [`docs/adr`](docs/adr).
