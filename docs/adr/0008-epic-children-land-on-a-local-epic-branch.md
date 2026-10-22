# Children of an epic on its own branch land on it, and ysz opens the epic's PR

ADR 0006 gave each child of an epic labelled `epic-branch` its own PR onto `origin/<prefix><epic-id>`, for the human to merge one at a time, and left the epic's own PR to the human. The human wants no child PRs at all, only one review: the epic's PR, once the epic is done. So a child's Run now lands instead of publishing. After its Review agent, ysz fast-forwards the epic branch in the Project repo onto the Run's commits, under the same commit checks as a push. Then it closes the bead, giving the branch and tip as the reason, and the Run ends `landed`. That branch belongs to the Project repo: the first child cuts it from `origin/<baseBranch>`, and it stays off origin until the epic's PR. Once every child of an open, unassigned `epic-branch` epic is closed, ysz picks the epic like a Ready Ticket. Its Run has no Attempt. It pushes the epic branch, opens its PR onto `baseBranch` titled with the epic's Jira key, and marks the epic In review. That PR then ends the way any Run's PR does. Merged closes the epic. PR closed hands the epic back with `needs-info`.

## Consequences

- No human sees a child's work before the epic's PR. The Review agent is the only review each child gets. If a child's review was skipped, the top of the epic's PR body says so.
- A child closes when it lands. Its dependents then become Ready and start from an epic branch that already holds its code.
- A child of such an epic never stacks on an In review blocker (ADR 0005). The epic branch cannot hold the blocker's unmerged code, so the child waits for that blocker to merge.
- Only one Run per Project runs at a time, so no other Run moves the epic branch while a child runs. The human still can. Landing only fast-forwards, so if the branch moved elsewhere, or a worktree has it checked out, the Run parks in needs-attention.
- An epic whose branch is already on origin began under ADR 0006 and finishes under it. Its children keep opening PRs onto that branch, and ysz opens only the epic's own PR, from origin's branch. If the human already opened that PR, ysz takes it, even once it has merged. Mixing the two flows would fork the branch between origin and the Project repo, and a dependent would start without a blocker merged on GitHub. One rule does change for these epics: their children no longer stack either. Each one waits until its In review sibling has merged.
- Until the epic's PR opens, its children's work exists only in one Project repo, on one machine.
- No child's work runs through CI before the epic's PR, because CI runs only on PRs. A child that breaks the build still lands, and its dependents build on top of it. The agents' own checks in the sandbox are the only gate until then.
- `epic-branch` alone opts the epic in, as in ADR 0006, so the epic does not need `ready-for-agent`. `orchestrator:skip` or `needs-info` on the epic keeps ysz from opening its PR.
- `landed` is a new end state. Like `broken-down`, it is left out of the Merge rate. The epic's own PR Run counts in the Merge rate but not in First-Attempt passes. While claude writes its PR body, it holds a slot.
- ysz still never rebases the epic branch. If `baseBranch` has moved on, the human brings the epic's PR up to date.

## Considered Options

- **Keep child PRs onto the epic branch and only open the epic's PR**: the human reviews each child, but needs a merge click per child and then reviews the same code again at the end.
- **Push each child straight to origin's epic branch, with no PR**: the work is backed up and visible on GitHub, but the human asked that nothing be pushed before the epic's PR.
- **Open the epic's PR from the poll in which its last child closes**: no new kind of Run, but a failed `gh pr create` or a restart would lose the PR, and nothing would retry it. As a Run, it gets Retry, Kill and recovery after a restart for free.
