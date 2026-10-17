# An In review Ticket unblocks its dependents, which open stacked PRs on its branch

A Ticket's bead closes only when its PR is Merged. Until then it blocks every Ticket that depends on it, and a chain like PopDeal-41f (22 Tickets behind `.1` and `.2`) stalls for as long as the human takes to merge each PR. So a Ticket now counts as Ready when at most one of its blockers is In review and the rest are closed. The In review blocker's bead still stays `in_progress` until its PR is Merged or PR closed, so `watchReviews` closes it or hands it back as before.

A dependent's clone starts at the blocker's `agent/<id>` branch rather than `origin/<baseBranch>`. Its PR targets that branch, and ysz links the two PRs with `gh stack link` into a GitHub stacked PR (GA 2026-10-06), so each PR's diff shows only its own Ticket. Merging and keeping the stack current stay with the human. When the blocker merges, GitHub retargets the dependent's PR onto the base. When the stack falls behind the base, the human presses Rebase stack.

## Consequences

- A Ticket with two or more In review blockers waits: a PR has one base.
- The host needs the `gh-stack` extension. If `gh stack link` fails, the PR still opens unstacked and the Run log says so.
- GitHub stacks are linear, so only the first dependent of a blocker joins its stack. A probe on 2026-10-16 showed that linking a second PR onto a blocker that is already in a stack fails with "this would remove #N from the stack", and changes nothing. Later dependents stay plain PRs onto the blocker's branch, and GitHub retargets them when that branch is deleted after the merge. FazWaz/PopDeal deletes merged head branches.
- `gh stack link` retargets the bottom PR onto its `--base`, which defaults to the repository's default branch. ysz therefore passes the blocker PR's own base.
- A blocker branch cut before another blocker merged lacks that blocker's code until the human rebases the stack. ysz never force-pushes a branch whose PR the human is reviewing.
- A blocker can merge while its dependent's Run is still going, and then its branch is gone. ysz reads the blocker PR's state before pushing, and if it merged, `git replay`s only the agent's commits onto the blocker's base and opens a plain PR there. A conflict fails the Run.
- When a blocker ends PR closed, its unclaimed dependents stop being Ready on their own, because the blocker is open again. Dependents that are already running or In review are left alone. The human finds the broken stack while reviewing.
- Parents still wait for their children to close: an In review child does not unblock its parent.

## Considered Options

- **Close the bead when the PR opens**: it unblocks dependents, but the bead says "done" before anything is merged. A closed-unmerged PR could no longer hand the Ticket back, and dependents would start from a base that lacks the blocker's code.
- **Clone from the base and merge the blocker branches in, PR against the base**: it allows several blockers, but every dependent's diff carries its blockers' work until they merge, and a squash-merging Project gets duplicate commits.
- **Clone dependents from the base branch alone**: simpler, but in PopDeal-41f `.2` and `.3` edit the same file, so `.3` would conflict, or redo `.2`'s work.
- **ysz rebases the stack before starting a dependent**: it keeps the agent current, but it force-pushes a PR the human is reviewing.
