# A QA agent never blocks a Run, but a failure it cannot fix withholds Cleared

The Implement and Review agents only run lint and tests on the files they changed, so a Run can open a pull request for a feature that never worked in the running app. A Project that opts in now gets a third agent in each Attempt, the QA agent, after the Review agent. It drives the Project's web app in a headless browser against the Ticket's acceptance criteria, runs the Project's own regression suite, and fixes what it can. A failure it cannot fix does not fail the Attempt or hand the Ticket back: the Run opens its pull request as usual and the failure is written as a comment on the Ticket. But the Run is then never Cleared (this amends ADR 0012 for opted-in Projects): its Ticket stays open until the human merges or closes the pull request, because a Ticket closed as "done" while its QA says the feature does not work would be a lie, and its dependents would start on a broken base. The same holds when QA could not run, for example when the local fazwaz backend is not up: a skipped QA proves nothing.

The first Project is PopDeal web, against the fazwaz stack on the host (`fazwaz.test/graphql`), with one QA account per role made during Onboarding on the host and kept in the Project's gitignored `.env.local`. The sandbox never reaches the database, and holds no Claude account credential: the QA agent leaves a QA report in the Run log, and the human publishes it as a Claude artifact when they want to share it. Mobile apps are out of scope: an Android emulator or iOS Simulator cannot run inside Docker on macOS, so they need a host-side decision of their own.

## Considered Options

- **An unfixed QA failure fails the Attempt, and the Run retries once**: a headless browser against a shared dev backend is flaky, and a QA mistake would then kill good work and lower Merge rate with no one noticing. Revisit once QA results have been watched for a while.
- **An unfixed QA failure hands the Ticket back with no pull request**: the same flakiness, and the human loses the code to look at.
- **A failure in the pull request description only**: the pull request would stay Cleared, and its Ticket closed.
- **The Review agent drives the app too**: reading a diff and driving an app need different context, and QA could not be switched off per Project without touching review.
- **The QA agent publishes its own artifact, or creates its own accounts**: both put account credentials or database access inside a sandbox that ADR 0001 to 0003 treat as untrusted.
- **A lock so one Run at a time uses the backend**: no evidence yet that Runs collide, and it adds state and waiting. QA data is named after its Ticket and left in the developer's database, with no automatic cleanup.

## Consequences

- A Run of an opted-in Project can stay In review with its Ticket open, where ADR 0012 would have closed it, so its dependents wait until the pull request is merged.
- QA only works while the fazwaz stack is running on the host; a Run that reaches QA with the stack down is not Cleared, and says so on its Ticket.
- Test data from QA stays in the developer's local database. The five QA accounts are fixed in number and reused.
