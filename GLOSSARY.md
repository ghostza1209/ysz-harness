# Glossary

**Project**: A codebase ysz works on (e.g. fazwaz, PopDeal, thaivis), known by a name that never changes, and worked in its local repo. Each Project keeps its own Ticket queue.

**Onboarding**: Making a new Project one ysz can work: from then on, its Ready Tickets can be claimed and their Runs can check their own work. A Project is onboarded or not; there is no partial state ysz picks from. Adding a Project, from the Dashboard or otherwise, does not make it onboarded: it is onboarded once its Smoke check and host checks pass, or when the human vouches for it by hand. Editing an onboarded Project leaves it onboarded.
_Avoid_: sandcastle setup, adding a repo.

**Smoke check**: An agent-free trial of a Project's sandbox: its install and a bounded check run on a fresh clone. ysz and the Dashboard onboard a Project only after it passes, but passing is not Onboarding by itself.
_Avoid_: dry run, test run.

**Check service**: A Project's running dev service whose image runs the agent's checks, for a stack the sandbox can't run.
_Avoid_: checkContainer (in prose), php container.

**Ticket**: One unit of work in a Project's own Beads queue. Work tracked elsewhere (e.g. Jira) is not a Ticket until it is brought into that queue.
_Avoid_: issue, task, job.

**Jira key**: The key of the Jira issue a Ticket was brought in from (e.g. OP-2522). Not every Ticket has one.
_Avoid_: external ref, Jira id.

**Backlog**: Every Ticket of a Project that is not closed, whether Ready or not. Ready Tickets are part of it.
_Avoid_: issues, beads list.

**Ready Ticket**: A Ticket the human has marked as fit for an agent to finish alone, whose blockers are all closed except at most one In review, with no children left open, not claimed, and not opted out of ysz.

**ysz**: The single central service that chooses which Ready Ticket from which Project to work on next and launches agents for it.
_Avoid_: orchestrator.

**Run**: ysz's effort to finish one Ticket, made of one or two Attempts, ending once its pull request is Merged or PR closed, or in handing the Ticket back to the human. A Run never merges: the human does, and the Run only learns of it.
_Avoid_: job, session.

**Attempt**: One pass at a Run's Ticket in fresh isolated sandboxes: an agent implements the Ticket, then a second agent reviews and corrects that work. A Run retries with a second Attempt at most once.
_Avoid_: retry run, try.

**Run log**: Everything a Run recorded, in order: each Attempt's sandbox setup and agent output, then the host steps that follow.

**Implement agent**: The agent that works the Ticket at the start of an Attempt.

**Review agent**: The agent that reviews and corrects the Implement agent's work later in the same Attempt, before any pull request exists.
_Avoid_: code review, review (alone).

**Dashboard**: The web page where the human watches and steers ysz: Runs, Ready Tickets, Run logs, pausing Projects. Only the human may use it, never an agent.
_Avoid_: UI, web app.

**Stats**: The Dashboard's page of graphs about past Runs, from archived ones too, and how each Project's Backlog and Ready Tickets grew and shrank over time.
_Avoid_: statistics, analytics, report.

**In review**: A Run waiting on the human once its pull request is open. Not an end: the Run ends when the human merges or closes that pull request, and its Ticket stays unclosed until then. It no longer holds back the Tickets it blocks. Always the human's review, never the Review agent's.

**Merged**: A Run's end once the human merges its pull request. The Ticket is then closed.

**PR closed**: A Run's end once the human closes its pull request without merging. The Ticket goes back to the human to rework before it can be Ready again.
_Avoid_: closed, rejected.

**Review wait**: How long a Run spends In review before it is Merged or PR closed: the human's time, never the Review agent's.
_Avoid_: review time, PR age.

**Merge rate**: The share of Runs left to finish that ended Merged, against those that ended PR closed or failed (a ysz restart cutting a Run short counts as failed). Killed Runs and Runs still In review are left out.
_Avoid_: success rate.

**First-Attempt pass**: A Run that got its pull request from its first Attempt alone.
_Avoid_: first-try.
