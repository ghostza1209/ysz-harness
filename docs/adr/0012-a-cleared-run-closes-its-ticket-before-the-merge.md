# A Cleared Run closes its Ticket before the human merges

ADR 0005 closed a Ticket's bead only when its PR was Merged, and rejected closing it when the PR opens: the bead would say "done" before anything merged, and a PR closed unmerged could no longer hand the Ticket back. The human now wants a Ticket closed once its PR is open and its Pipeline has not failed. So `watchReviews` reads the PR's checks along with its state (`gh pr view --json state,createdAt,closedAt,statusCheckRollup`, the call it already makes every 10 seconds). When no check failed or timed out, and none is still pending, it closes the bead (the Run is Cleared). A PR with no checks at all counts as having no Pipeline once it has been open for 2 minutes: GitHub registers check runs a few seconds late, so an empty rollup earlier is not "no CI". A cancelled check is not finished, and a skipped or neutral one passed. The Run stays In review until the human merges or closes the PR, so Merge rate and Review wait stay as they were.

The two things ADR 0005 feared are handled in the other direction:

- **PR closed unmerged after the Ticket closed**: the bead is reopened with `needs-info`, as for any PR closed, instead of staying closed. `prClosed` no longer requires the bead to be held.
- **Pipeline fails after the Ticket closed**: the bead goes back to In review (`in_progress`, ysz's, labelled `in-review`) and closes again by itself when the Pipeline passes, so a human fix pushed to the same PR needs no re-marking. A Pipeline that fails before the Ticket closes changes nothing: it stays In review. ysz does not try to fix a failed Pipeline itself.

## Consequences

- A closed Ticket no longer means its code is merged. `Merged` closes the bead only if the Run was not Cleared already.
- The Backlog drops a Ticket when its Run is Cleared, not when it merges. The Run is still on the Dashboard as In review.
- A parent closes when its last child is Cleared, as for Merged. When a child is reopened, a parent ysz closed with its children (its close reason starts with "Every child closed") is reopened with it, even if another child was the last to close; a parent the human closed is not touched.
- Dependents: a Ticket is Ready when its blockers are closed, at most one of them with a PR not merged yet, since a PR has one base (ADR 0005). Which branch a dependent stacks on now comes from the Run that is In review for that blocker, not from the blocker's bead status. A Ticket with two such blockers waits.
- Dependents already running or In review when a blocker is reopened are left alone, as in ADR 0005.
- The flip to closed happens on the first poll after the Pipeline finishes, at most 10 seconds late.
- A Cleared bead is told from one the human closed by its close reason (`PR open, Pipeline not failed: <pr>`) with `in-review` still on it. A bead closed by hand is left alone, as before.
- Applies to every Project: there is no per-Project switch.

## Considered Options

- **Close the moment the PR opens, with a pending Pipeline counting as not failed**: the Ticket would close, then reopen whenever the Pipeline fails a minute later, and the dependents started in between would build on a failing base.
- **Wait for a green Pipeline and never close a Project with no checks**: such a Ticket would stay open until merged, as before.
- **A per-Project setting for a Pipeline, or a probe of the repo's workflows**: more to configure and read, for a 2-minute wait that costs only a Project with no CI.
- **Reopen a failed-Pipeline Ticket for the human (`needs-info`)**: a failed check is not a rejection, and the human would have to mark the Ticket Ready again by hand for a PR that is still in use.
