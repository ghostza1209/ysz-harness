# Glossary

**Project**: A codebase the Orchestrator works on (e.g. fazwaz, PopDeal, thaivis), identified by its local repo. Each Project keeps its own Ticket queue.

**Ticket**: One unit of work in a Project's own Beads queue. Work tracked elsewhere (e.g. Jira) is not a Ticket until it is brought into that queue.
_Avoid_: issue, task, job.

**Ready Ticket**: A Ticket the human has marked as fit for an agent to finish alone, with no open blockers, not claimed, and not opted out of the Orchestrator.

**Orchestrator**: The single central service that chooses which Ready Ticket from which Project to work on next and launches agents for it.

**Run**: The Orchestrator's effort to finish one Ticket, made of one or two Attempts, ending in a pull request for human review or in handing the Ticket back to the human. A Run never merges.
_Avoid_: job, session.

**Attempt**: One pass at a Run's Ticket in fresh isolated sandboxes: an agent implements the Ticket, then a second agent reviews and corrects that work. A Run retries with a second Attempt at most once.
_Avoid_: retry run, try.
