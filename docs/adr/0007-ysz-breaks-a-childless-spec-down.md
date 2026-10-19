# ysz breaks a childless Spec down into child Tickets

An epic labelled `ready-for-agent` with no children never became Ready: `listReady` excludes epics, so the epic stayed in the Backlog until the human split it with `/to-tickets` by hand. Now such an epic is a Spec, and ysz picks it like a Ready Ticket, by the same priority and age, within the same slots and the same one-Run-per-Project limit. A Spec's Run has no review agent and no PR. A breakdown agent reads the Spec and the code on a clone of the base, then outputs child Tickets as `<ticket key blocked-by>` tags. ysz creates them under the epic with one `bd create --graph`, each labelled `ready-for-agent` at the epic's priority, with the blocking edges the agent gave. Then it comments the new ids on the epic and releases it. The Run ends `broken-down`, and the children become Ready on the next poll.

## Consequences

- The human's `ready-for-agent` on the epic is the only review the breakdown gets. `/to-tickets` stops for the human to approve the breakdown, but the breakdown agent skips that step, and its children are Ready straight away. A bad split costs Runs and PRs, not a review step. Label a Spec `ready-for-agent` only after the human has finished writing it.
- A human who runs `/to-tickets` on an epic that is already labelled can race ysz. ysz checks for children again just before it creates any, so it creates nothing once the human's children exist. While its agent is still running, the human's children can still land alongside ysz's. Leave the label off until the split is done, or add `orchestrator:skip`.
- An epic counts as a Spec only with no children at all. An epic whose children all closed is done, not a Spec. Each poll lists the closed beads alongside the unclosed ones, and any bead that is some bead's parent, epic or not, is neither a Spec nor a Ready Ticket. That is one extra bd call per poll, run beside the other two.
- The agent's output crosses a trust boundary. ysz takes only the title, body and in-plan blockers from it, and sets the parent, label and priority itself. A plan with no tickets, more than 30, duplicate keys, unknown blockers or a cycle of blockers is an unusable Attempt, so the second Attempt is told what was wrong. bd would also refuse a cycle before writing anything. Two unusable Attempts, or a NEEDS_INFO, hand the Spec back with `needs-info`, as a Ticket's failure does.
- A Spec's Run saves no host job. After a crash, `recover()` hands the epic back. If its children were already created, it is no longer a Spec, so nothing is created twice.
- `broken-down` is a new end state. The Merge rate leaves it out, and it can be archived like a merged Run.

## Considered Options

- **Children labelled `needs-triage` for the human to approve**: keeps the meaning of a Ready Ticket, but the human asked for a Spec to flow through to PRs without a stop.
- **A separate opt-in label such as `breakdown`**: avoids the race with a human mid-split, but adds a label the human must remember for what `ready-for-agent` on an epic already says.
- **Run the `/to-tickets` skill itself in the sandbox**: it quizzes the human, needs tracker access the sandbox lacks, and cannot be invoked by a model. The breakdown prompt keeps its slicing rules and its ticket template instead.
