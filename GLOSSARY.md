# Glossary

**Project**: A codebase ysz works on (e.g. fazwaz, PopDeal, thaivis), known by a name that never changes, and worked in its local repo. Each Project keeps its own Ticket queue.

**Onboarding**: Making a new Project one ysz can work: from then on, its Ready Tickets can be claimed and their Runs can check their own work. A Project is onboarded or not; there is no partial state ysz picks from. Adding a Project, from the Dashboard or otherwise, does not make it onboarded: it is onboarded once its Smoke check and host checks pass, or when the human vouches for it by hand. For a Project that opted in to the QA agent, its QA accounts must also exist. Editing an onboarded Project leaves it onboarded.
_Avoid_: sandcastle setup, adding a repo.

**Smoke check**: An agent-free trial of a Project's sandbox: its install and a bounded check run on a fresh clone. ysz and the Dashboard onboard a Project only after it passes, but passing is not Onboarding by itself.
_Avoid_: dry run, test run.

**Check service**: A Project's running dev service whose image runs the agent's checks, for a stack the sandbox can't run.
_Avoid_: checkContainer (in prose), php container.

**Check hint**: A Project's note to its agents on which checks to run in the sandbox and how, for the files they changed. Advice the agent follows, not a check ysz runs itself.
_Avoid_: check command, test command.

**Ticket**: One unit of work in a Project's own Beads queue. Work tracked elsewhere (e.g. Jira) is not a Ticket until it is brought into that queue.
_Avoid_: issue, task, job.

**Jira key**: The key of the Jira issue a Ticket was brought in from (e.g. OP-2522). Not every Ticket has one.
_Avoid_: external ref, Jira id.

**Backlog**: Every Ticket of a Project that is not closed, whether Ready or not. Ready Tickets are part of it.
_Avoid_: issues, beads list.

**Ready Ticket**: A Ticket the human has marked as fit for an agent to finish alone, whose blockers are all closed, at most one of them with a pull request not merged yet, with no children, open or closed, not claimed, and not opted out of ysz.

**Spec**: An epic the human has marked as fit for an agent, which ysz breaks down into child Tickets, each Ready by construction, instead of opening a PR. ysz picks it like a Ready Ticket once every blocker is closed, and each breakdown plans only what its children, if any, do not cover yet. An epic whose children the human wrote is not a Spec, whatever it is marked with: ysz never breaks it down, and its mark waits for nothing. A breakdown takes the mark off, so after changing a Spec the human marks it again. It stays a Spec after it is broken down. Once its children are all closed, a Spec changed since its last breakdown goes back to the human instead of closing or getting its Epic PR.
_Avoid_: PRD, plan, top-up, re-break.

**ysz**: The single central service that chooses which Ready Ticket from which Project to work on next and launches agents for it.
_Avoid_: orchestrator.

**Run**: ysz's effort to finish one Ticket, made of one or two Attempts, ending once its pull request is Merged or PR closed, once it Landed, or in handing the Ticket back to the human. A Run never merges a pull request: the human does, and the Run only learns of it.
_Avoid_: job, session.

**Attempt**: One pass at a Run's Ticket in fresh isolated sandboxes: an agent implements the Ticket, a second agent reviews and corrects that work, then, in a Project that opted in, a third agent runs the app to check it. A Run retries with a second Attempt at most once.
_Avoid_: retry run, try.

**Clone**: A Run's disposable copy of its Project's repo on the host, fresh for each Attempt, that its sandboxes work in. It stays on disk only while it serves someone: the live Run, or the human inspecting a failed or killed Run until a later Run of the same Ticket reaches In review or Landed.
_Avoid_: worktree, checkout, job.

**Run log**: Everything a Run recorded, in order: each Attempt's sandbox setup and agent output, then the host steps that follow.

**Implement agent**: The agent that works the Ticket at the start of an Attempt.

**Review agent**: The agent that reviews and corrects the Implement agent's work later in the same Attempt, before any pull request exists.
_Avoid_: code review, review (alone).

**QA agent**: The agent that runs a Project's app after the Review agent, in the same Attempt, and checks the Ticket's work in it: it drives the app against the Ticket's acceptance criteria and runs the Project's own regression suite, fixing what it can. It runs only in a Project that opted in, and has nothing to do when the work changes nothing a user sees. A failure it cannot fix does not stop the Run; it is written on the Ticket, and the Run is then not Cleared. What it saw is left in the QA report.
_Avoid_: tester, QA (alone).

**QA account**: A login the QA agent uses in a Project's app, one per role the app has, made on the host during Onboarding in the local backend, never in production. An existing one is reused, never duplicated; the agent can only pick among the roles that have one.
_Avoid_: test user, automation user.

**QA report**: The one page the QA agent leaves in the Run log: for each acceptance criterion of the Ticket, whether it held, with screenshots of what the agent saw. The human may publish it as a Claude artifact; ysz never does.
_Avoid_: test report, evidence.

**Dashboard**: The web page where the human watches and steers ysz: Runs, Ready Tickets, Run logs, pausing Projects. Only the human may use it, never an agent.
_Avoid_: UI, web app.

**Stats**: The Dashboard's page of graphs about past Runs, from archived ones too, and how each Project's Backlog and Ready Tickets grew and shrank over time.
_Avoid_: statistics, analytics, report.

**In review**: A Run waiting on the human once its pull request is open. Not an end: the Run ends when the human merges or closes that pull request, and its Ticket stays unclosed until then or until the Run is Cleared. It no longer holds back the Tickets it blocks. Always the human's review, never the Review agent's.

**Pipeline**: The checks GitHub runs on a Run's pull request. It has failed once any of its checks failed or timed out; a cancelled check is not finished yet, and a skipped or neutral one passed. While a Run has an open Generated PR, its Pipeline is the Generated PR's, because the pull request alone fails the Project's generated-files check; once the Generated PR is merged, it is the pull request's again.
_Avoid_: CI, check (alone: Smoke check, Check service and Check hint are about the sandbox).

**Cleared**: An In review Run whose Pipeline has not failed: it finished without a failure, or none showed up within a short time of the pull request opening, and, in a Project that opted in to the QA agent, whose QA agent ran and left no failure unfixed. A Run whose QA agent left a failure unfixed, or could not run, is never Cleared: its Ticket stays open until the pull request is Merged or closed. Its Ticket is then closed before the human merges, and so is its parent as for Merged. The Run stays In review. A Pipeline that fails afterwards puts the Ticket back In review, with a parent it closed, and the Run is Cleared again once the Pipeline passes.
_Avoid_: passed, done.

**Merged**: A Run's end once the human merges its pull request. The Ticket is then closed, if the Run was not Cleared already, and so is its parent once every child of it is closed, if the parent is not an epic on its own branch and is either a Spec ysz has broken down, or a Ticket marked fit for an agent that is not a Spec (a non-epic one, or an epic whose children the human wrote).

**Landed**: A Run's end once ysz has put its Ticket's work on the branch of its parent epic, an epic on its own branch, with no pull request of its own. The Ticket is then closed, and the human first sees that work in the Epic PR.
_Avoid_: merged (for this)

**Epic PR**: The one pull request an epic on its own branch gets onto the base branch. Once every child of the epic is closed, ysz picks the epic like a Ready Ticket and opens it in a Run with no Attempt. The epic closes when it is Merged.

**Generated PR**: The second pull request of a Run, opened only in a Project that opted in and only when the Run's generated files changed by more than a fixed number of lines. It holds those files alone and targets the branch of the Run's pull request, which holds everything else, so the human reads the hand-written change apart from the generated one. The human merges it into that branch first, and only then can the pull request pass the Project's checks and merge. It has no say in how the Run ends: the Run ends on its pull request, and ysz never closes a Generated PR. When it cannot be made, the Run opens one pull request that holds the generated files too.
_Avoid_: second PR, codegen PR.

**PR closed**: A Run's end once the human closes its pull request without merging. The Ticket goes back to the human to rework before it can be Ready again, even if the Run was Cleared and the Ticket closed.
_Avoid_: closed, rejected.

**Review wait**: How long a Run spends In review before it is Merged or PR closed: the human's time, never the Review agent's.
_Avoid_: review time, PR age.

**Merge rate**: The share of Runs left to finish that ended Merged, against those that ended PR closed or failed (a ysz restart cutting a Run short counts as failed). Killed Runs and Runs still In review are left out.
_Avoid_: success rate.

**First-Attempt pass**: A Run that got its pull request from its first Attempt alone.
_Avoid_: first-try.

**Follow-up**: Work in a Project's code that an agent noticed during a Run but left outside its Ticket. Only a Run that reaches In review yields Follow-ups, and only from the Attempt its pull request came from. Each becomes a Ticket in that Project's queue for the human to triage, and is never Ready until the human marks it so.
_Avoid_: feedback, issue, TODO.

**Friction**: Something in ysz or a Project's sandbox that got in an agent's way during a Run: a check that cannot run, a missing tool, a misleading check hint or prompt. It is fixed in ysz, never in the Project's code, so it becomes a Ticket in ysz's own queue, marked with the Project it came from, for the human to triage.
_Avoid_: feedback, issue, harness gap.

**Bug report**: A report of a bug in ysz itself that the human files on ysz's GitHub repo, from a Run or not. Never a Ticket in any queue: unlike Friction, which an agent records during a Run into ysz's own queue, a Bug report is the human's, made by hand, upstream and public.
