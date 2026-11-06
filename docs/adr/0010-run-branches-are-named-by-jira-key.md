# A Run's branch starts with its Ticket's Jira key

ysz used to name a Run's branch `agent/<ticket-id>` and an epic's branch `<epicBranchPrefix><epic-id>`, so only the PR title carried the Jira key. The human wants the branch to carry the key too. The fazwaz and PopDeal teams start every branch with its Jira key (`OP-2600`, `OP-2424-conversation-access-check`), and Jira shows a branch whose name holds a key in that issue's development panel. So a Ticket with a Jira key, its own or its parent epic's (the same key the PR title gets), now gets the branch `<key>-<ticket-id>`, e.g. `OP-2424-laravel-h5q`. An epic on its own branch gets `<key>-<epic-id>` the same way. A Ticket without a key keeps `agent/<ticket-id>`, and an epic without one keeps `<epicBranchPrefix><epic-id>`. A branch's name is fixed when the branch is first made, and is read back instead of being worked out again. A Run records the branch it was cut on. An epic's branch is the one already in the Project repo or on origin under any name the epic's id could have been given. ysz never parses a Ticket id out of a branch name.

## Consequences

- An epic that gets its Jira key after its branch exists keeps the old name. Otherwise its later children would cut a new branch, and its landed children's work would be stranded on the old one. A Ticket's branch lives for one Run, so a later Run of the Ticket, after its PR was closed, is cut under the key it has by then.
- Branches and Runs made before this decision keep their `agent/` and `epic/` names, so nothing is migrated.
- A child sees only its epic's own Jira key, so an epic whose key comes from its own parent keeps `<epicBranchPrefix><epic-id>` as its branch, while its PR title, like any Ticket's, still carries that key, and Jira links the PR by it.
- Without the `agent/` prefix, a branch's name no longer says whether ysz made it. Only the bead id at its end tells it apart from a branch the team made by hand.

## Considered Options

- **The bare key, `OP-2424`**: the closest match to the team's branches. But every child of one epic shares the epic's key, so their branches would collide. A branch the team already pushed under that key would collide too, and `prepare` would take it for an epic begun under ADR 0006 and open child PRs onto someone else's branch.
- **Keep the prefix, `agent/OP-2424-laravel-h5q`**: Jira still links it, and it still tells ysz's branches apart, but it breaks the team's rule that a branch starts with its key.
- **Key as a folder, `OP-2424/laravel-h5q`**: once that exists, git refuses any branch named `OP-2424`, so the team could no longer make one.
