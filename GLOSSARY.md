# Glossary

**Project**: A codebase the Orchestrator works on (e.g. fazwaz, PopDeal, thaivis), identified by its local repo. Each Project keeps its own Ticket queue.

**Ticket**: One unit of work in a Project's own Beads queue. Work tracked elsewhere (e.g. Jira) is not a Ticket until it is brought into that queue.
_Avoid_: issue, task, job.

**Ready Ticket**: A Ticket the human has marked as fit for an agent to finish alone, with no open blockers, not claimed, and not opted out of the Orchestrator.

**Orchestrator**: The single central service that chooses which Ready Ticket from which Project to work on next and launches agents for it.

**Run**: The Orchestrator's effort to finish one Ticket, made of one or two Attempts, ending once its pull request is Merged or PR closed, or in handing the Ticket back to the human. A Run never merges: the human does, and the Run only learns of it.
_Avoid_: job, session.

**Attempt**: One pass at a Run's Ticket in fresh isolated sandboxes: an agent implements the Ticket, then a second agent reviews and corrects that work. A Run retries with a second Attempt at most once.
_Avoid_: retry run, try.

**Run log**: Everything a Run recorded, in order: each Attempt's sandbox setup and agent output, then the host steps that follow.

**Implement agent**: The agent that works the Ticket at the start of an Attempt.

**Review agent**: The agent that reviews and corrects the Implement agent's work later in the same Attempt, before any pull request exists.
_Avoid_: code review, review (alone).

**Dashboard**: The web page where the human watches and steers the Orchestrator: Runs, Ready Tickets, Run logs, pausing Projects. Only the human may use it, never an agent.
_Avoid_: UI, web app.

**In review**: A Run waiting on the human once its pull request is open. Not an end: the Run ends when the human merges or closes that pull request. Always the human's review, never the Review agent's.

**Merged**: A Run's end once the human merges its pull request. The Ticket is then closed.

**PR closed**: A Run's end once the human closes its pull request without merging. The Ticket goes back to the human to rework before it can be Ready again.
_Avoid_: closed, rejected.
