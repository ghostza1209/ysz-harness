# Issue tracker: Beads

Issues and specs for this repo live in Beads, a local issue tracker in `.beads/` driven by the `bd` CLI. Pass `--json` when you need to parse the output.

## Conventions

- **Create an issue**: `bd create "Title" -d "..." -t task|bug|feature|epic -l <labels>`. Use `--body-file -` with a heredoc for multi-line bodies. Use `bd q "Title"` to get back only the new ID.
- **Read an issue**: `bd show <id> --json --include-comments`
- **List issues**: `bd list --json`, filtered with `-l <label>`, `--all` (also shows closed), and `-n 0` (no limit)
- **Comment**: `bd comment <id> "..."`, or `--stdin` for multi-line text
- **Apply / remove labels**: `bd update <id> --add-label X --remove-label Y`
- **Close**: `bd close <id> -r "reason"`

Issue IDs look like `<prefix>-<hash>` (for example `ysz-harness-a3f8`). Pass them exactly as given.

## When a skill says "publish to the issue tracker"

Create a bead with `bd create`.

## When a skill says "fetch the relevant ticket"

Run `bd show <id> --json --include-comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an epic, and each **child** bead under it is one ticket.

- **Map**: `bd create "..." -t epic -l wayfinder:map`, with the Notes / Decisions-so-far / Fog sections as its description.
- **Child ticket**: `bd create "..." --parent <map-id> -l wayfinder:<type>`, where type is `research`, `prototype`, `grilling` or `task`.
- **Blocking**: Beads' own dependencies: `bd dep add <blocked> <blocker>`. A ticket is unblocked when every blocker is closed.
- **Frontier**: `bd ready --parent <map-id> --unassigned --json`; the first result wins.
- **Claim**: `bd update <id> --claim`, as the session's first write.
- **Resolve**: `bd comment <id> "<answer>"`, then `bd close <id>`, then add a pointer (a short gist plus the ID) to Decisions-so-far in the map.

## work-spec

- **Spec query**: `bd ready --type epic --sort oldest`; the first result wins.
- **Key**: the spec's bead id (no Jira). Worktree `.claude/worktrees/<spec-id>`, branch `<spec-id>`.
- **Base**: local `master`. No remote, so no push and no PR: a run ends with the branch ready locally.
- **Worktree setup**: `npm ci` (skip while there is no `package.json`).
- **Checks run**: on the host, in the worktree.
- **Gate**: `npm test && npx tsc --noEmit`.
- **Commit format**: `<ticket-id>: <ticket title>`.
- **Size check**: none.
- **Human tickets**: skip tickets labelled `ready-for-human`; report them as blockers.
