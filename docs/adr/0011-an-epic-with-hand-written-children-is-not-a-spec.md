# An epic with hand-written children is not a Spec

ADR 0009 made `ready-for-agent` on an epic ask for a breakdown of whatever its children do not cover yet, children or not. That also picked up an epic whose children the human had split out themselves, with `/to-tickets` or `bd create --parent`: the human had already done the breakdown, and `ready-for-agent` on the epic was only what its children inherited it from. The human does not want ysz to touch such an epic. So an epic is a Spec only when it has no children, or when ysz broke it down before, which it records as a baseline on the epic (ADR 0009). An epic with children and no baseline is not picked, and its `ready-for-agent` waits for no breakdown: it closes once every child is closed, as a non-epic parent labelled `ready-for-agent` does. If it is on its own branch (ADR 0008), the label no longer keeps ysz from opening its Epic PR once every child is closed.

## Consequences

- The human gets no breakdown for an epic they split by hand. To add work, they create the children by hand too. A later edit to such an epic is not caught either: without a baseline there is nothing to compare its text with.
- An epic ysz broke down before is unchanged. Labelling it again still breaks down what its children do not cover, and its last child still hands it back when its text changed.
- If a first breakdown crashes after `bd create --graph` but before the write that releases the epic, the epic is left with children and no baseline. It now counts as hand-written: its children still run and it closes with them, but a later edit to it is not caught. The children are all created in one `bd create --graph`, so none is missing.
- A breakdown that finds the human split the epic by hand while it ran (ADR 0009) releases it with its label and no baseline. Under this ADR ysz then leaves it alone, where before it was broken down again to plan nothing.
- The Dashboard shows such an epic as part of the Backlog but not Ready, with nothing to say why, as for any Ticket that is not Ready.

## Considered Options

- **No epic with children is a Spec (back to ADR 0007)**: the simplest rule, but it drops the breakdown of a changed Spec that ADR 0009 added after laravel-qfx.
- **A label such as `orchestrator:skip` on each epic the human splits by hand**: no code, but the human must remember it for every epic, and `ready-for-agent` on the epic is what its children inherit.
- **An opt-in for breaking down an epic the human split by hand**: not needed. The human can write the missing children themselves.
