# A Run can open its generated files as a second pull request

A PopDeal pull request that changes a GraphQL document also commits the regenerated types. In the last 40 merged PopDeal PRs, 7 touched generated files, and in some they were most of the diff (#623: 1,460 of 1,633 lines; #615: 5,359 of 8,224). The reviewer has to scroll past the generated lines to find the hand-written change.

A Project that opts in, by listing its generated paths, now gets two pull requests from a Run whose generated files changed by more than 200 lines (a constant in ysz, not a setting). The pull request keeps the agent's commits with the generated paths taken out of each, and goes to the base branch. The Generated PR holds one commit that sets those paths to their final state, and targets the branch of the pull request. The generated paths are the four `generated/` files of PopDeal; `schema.graphql` stays in the pull request because it is the API contract a reviewer should read, and so does `pnpm-lock.yaml`, which travels with `package.json`.

The Generated PR sits on top because generated code is built from the GraphQL documents in the pull request, so it cannot be its base. That leaves the pull request alone failing PopDeal's "GraphQL codegen" job, and it cannot merge on red. So the human merges the Generated PR into the pull request's branch first (the pattern ADR 0005 already allows), the pull request turns green with the whole tree, and then they merge it onto the base branch.

How the Run reads this, so it does not stall on a pull request that is red by construction:

- **Cleared** reads the Pipeline of the Generated PR while it is open, then the pull request's once it is merged (amends ADR 0012). Without this a split Run would never be Cleared before the human merges, and its dependents would wait for the whole Review wait.
- **The Run ends on the pull request alone**: Merged or PR closed, as before. ysz keeps the Generated PR's URL to read its Pipeline and to show it on the Dashboard, and never closes it.
- **A dependent** (ADR 0005) clones from the Generated PR's branch while that PR is open, since only that branch holds the generated files, and from the pull request's branch after. GitHub moves its base on its own as each branch is deleted by its merge.
- **When the split fails**, the Run does not fail: it pushes the generated commit onto the pull request's branch, as a plain push, and opens one pull request that holds everything. The Run log says why.

## Considered Options

- **A `linguist-generated` line in PopDeal's `.gitattributes`**: GitHub would fold the generated files in the diff, with no change in ysz. It does not shrink the PR, its line count, or the size checks that read it. The human chose the split anyway; the line stays a complement to it, not a replacement.
- **Two sibling pull requests, both onto the base branch**: neither can pass the codegen job alone, and each would carry the other's half.
- **The Generated PR at the bottom**: its content comes from the documents above it, so it cannot exist first.
- **The Run ends when both pull requests have ended**: closing the Generated PR alone, or merging the pull request first, leaves the Run in review for good, and Merge rate and Review wait would need a new meaning.
- **Link the pair with `gh stack link` so one action merges both**: the pull request would be in a stack, and ADR 0005 shows a second dependent cannot be linked to a blocker already in one. Its dependents would be plain PRs.
- **ysz merges the Generated PR**: a Run never merges a pull request.
- **Split by diff size alone, with no opt-in**: not every Project commits generated files, and the codegen job is PopDeal's.
- **Always split, with no size floor**: each split costs the human one more merge and a red pull request until then, for a diff nobody had trouble reading (#608: 130 of 1,150 lines).
- **A failed split fails the Run**: it throws away good work for what is only a reading aid.
- **Also split the Epic PR**: its head is the epic branch, which `publishEpic` looks up by name to avoid opening it twice, and epics begun before ADR 0008 already have PRs on origin. It needs its own Ticket.

## Consequences

- The pull request is red from the moment it opens until the human merges the Generated PR into it. A human who reads the Pipeline alone sees a failure that is expected.
- A pull request merged before its Generated PR (an admin override) reaches the base branch without the generated files, and the base branch's CI turns red. GitHub then moves the Generated PR onto the base branch, because the branch it targeted was deleted by the merge; it stays open, and merging it repairs the base branch. ysz does not follow this.
- A pull request closed unmerged leaves its Generated PR open, and ysz does not close it. The human closes both.
- A Generated PR closed by hand leaves the pull request red; the Run stays In review.
- A Project's `projects.json` entry (ADR 0004) gets one new field, the list of generated paths, and validation must accept it.
- The Epic PR is not split. A Landed child (ADR 0008) still commits its generated files on the epic branch.
- The 200-line floor is a guess from seven PRs. It is a constant in ysz, to move once more Runs have been watched.
