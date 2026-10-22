# A labelled epic's children open their PRs onto its epic branch

> Superseded in part by [ADR 0008](0008-epic-children-land-on-a-local-epic-branch.md): the children of an epic not yet on origin land on a local epic branch with no PRs of their own, and ysz opens the epic's PR. An epic already on origin finishes as below.

ysz opens one PR per Ticket, so an epic like thaivis app-2bl (26 agent Tickets) lands 26 PRs on `develop`. The human may want `develop` to get one PR per epic instead. So when a Ticket's parent epic is labelled `epic-branch`, its Run clones from `origin/<prefix><epic-id>` and opens its PR against that branch instead of `baseBranch`. The prefix is the Project's `epicBranchPrefix`, `epic/` by default. The first child's Run pushes the epic branch from `origin/<baseBranch>` when origin lacks it. The human merges each child PR into the epic branch, and that merge is still the child's Merged: its bead closes and its dependents become Ready, starting from an epic branch that already holds its code. The human opens the epic branch's own PR to `baseBranch` and merges it. ysz never opens or touches that PR.

## Consequences

- An epic is opted in by its label, not per Project. A small epic stays on plain PRs, which avoids an extra final PR.
- Stacking (ADR 0005) works unchanged inside an epic. A child with an In review sibling blocker clones the sibling's `agent/<id>`, and the stack's base is the sibling PR's own base, which is the epic branch. When the blocker merges meanwhile, the child replays onto the epic branch.
- A child stacked on a blocker outside its epic follows that blocker. When the blocker merges, GitHub retargets the child's PR onto the blocker's base, not the epic branch, so the human retargets it by hand.
- Merging the epic PR before every child is done ships part of the epic. If the repo deletes merged head branches, GitHub retargets the open child PRs onto `baseBranch`, and the next child's Run cuts a fresh epic branch from it.
- The epic branch is never rebased by ysz. Keeping it current with `baseBranch` stays with the human, as with a stack.
- A CI workflow that filters `pull_request` by base branch does not run on child PRs until it also matches the prefix (thaivis `ci.yml` needs `'epic/**'`). A prefix that globs well is why it is configurable per Project.
- `epicBranchPrefix` is a new Project field, so ADR 0004's `projects.json` validation must accept it.

## Considered Options

- **Children push straight to the epic branch with no PR of their own**: no merge clicks, but a bad child can only be turned back by closing the whole epic PR, and the bead would close before any human review.
- **One Ticket for the whole epic**: no change to ysz, but one Attempt cannot do 26 Tickets of work, and the Review agent cannot review it.
- **Every epic gets a branch**: no label to remember, but a two-child epic gains a third PR for nothing.
