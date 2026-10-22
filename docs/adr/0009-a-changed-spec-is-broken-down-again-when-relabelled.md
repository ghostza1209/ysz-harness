# A changed Spec is broken down again when the human labels it again

ADR 0007 broke a Spec down only while it had no children. The human changed laravel-qfx after its breakdown, adding its `In-Reply-To` rules, and ysz could not see it: an epic with children was no longer a Spec. The human wrote the missing child by hand. For the six minutes before that, every child was closed, so the epic was ready to get its Epic PR without that work. Now `ready-for-agent` on an epic asks for a breakdown of whatever its children do not cover yet, whether it has children or not. A breakdown takes the label off in the same write that releases the Spec. That write also records a baseline as bd metadata on the epic: a hash of the description, design and acceptance criteria the agent read. After changing a Spec, the human labels it again. The breakdown agent sees every child, closed or not, with its body and close reason, and plans only what is missing. With no children, that is the whole Spec, as before. A plan with no Tickets is now a usable breakdown. It records the new baseline, and closes the Spec if all its children are closed.

## Consequences

- When a Spec's last child closes, Merged or Landed, ysz compares the Spec's text with its baseline. A Spec changed since its breakdown is neither closed nor given its Epic PR. ysz comments that it changed after its breakdown and labels it `needs-info`. The human then labels it `ready-for-agent` again, as they requeue any Ticket. A typo fix costs one breakdown that plans no Tickets.
- An epic with no baseline was never broken down by ysz, and keeps today's behaviour. The human's own `epic-branch` epic still gets its Epic PR, and a non-epic parent labelled `ready-for-agent` still closes with its last child. An epic still labelled `ready-for-agent` is waiting for a breakdown, so its last child does not close it.
- A breakdown only adds Tickets. It never edits or closes an existing child: its output crosses a trust boundary, and the child may be claimed or In review. When an open child contradicts the changed Spec, the agent answers NEEDS_INFO naming it, and the Spec goes back to the human. A change to work already merged becomes a new child that changes it.
- "No children" no longer guards against creating children twice. Before creating any, ysz checks that the Spec's children are still the ones its agent saw, so a human splitting by hand still wins the race. New children continue the `<spec>.N` numbering from the highest N, and bd still refuses a taken id. A crash after the children are created but before the release leaves the label on, so the next breakdown sees them and plans no Tickets.
- The baseline is the text the agent read when its Run began, so an edit made while the breakdown runs does not count as covered.
- Only the description, design and acceptance criteria count as the Spec's text. A change to its title, notes or comments does not, though the agent still reads its comments.
- A child the human creates with `--parent` under a broken-down Spec no longer inherits `ready-for-agent`, so the human labels it.
- A Spec whose Epic PR is open is claimed, so labelling it does nothing until that PR ends. To add work, the human closes the PR, which hands the epic back, then labels it. A closed Spec is not reopened by its label: the human runs `bd reopen` first.
- laravel-qfx was the only Spec that had children and still carried the label. The human took its label off by hand. It has no baseline, so it keeps today's behaviour.

## Considered Options

- **Break a Spec down again as soon as its text changes**: nothing to remember, but the human edits a Spec in several saves (laravel-qfx twice, 15 minutes apart), and a breakdown would start on a half-written change.
- **A separate label such as `rebreak`**: changes no current condition, but adds a second label for what `ready-for-agent` on a Spec already says, as ADR 0007 found for the first breakdown.
- **A Dashboard button**: no label to remember, but the human edits Specs through bd, not the Dashboard, and the Dashboard's Retry belongs to a Run, not a bead.
- **Only the check at the last child, with the human splitting the change by hand**: the least code, and what laravel-qfx got, but the human still writes the missing children.
- **Show the agent a diff of the Spec since its baseline**: would focus the agent, but needs the old text from `bd history`. The children and the code already say what is done.
