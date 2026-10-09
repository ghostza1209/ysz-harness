import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseLog } from '../web/logView';

it('splits an agent log into steps, tool calls and agent messages', () => {
  const text = `
--- Run started: 2026-10-09T08:51:17.997Z ---
Iteration 1/1
Setting up sandbox
  CI=true pnpm install --frozen-lockfile
Setting up sandbox done (95.1s)
Agent started
Bash(cat ticket.json)
I'm switching the enums to upper case.
Bash(python3 - <<'EOF'
import re
s=s.replace(a,b)
EOF
git diff | head -80)
Now the tests.
Read(types/sms.ts)
Agent stopped
Collecting commits
Collecting commits done (0.0s)
`;
  assert.deepEqual(parseLog(text), [
    { kind: 'rule', text: 'Run started: 2026-10-09T08:51:17.997Z' },
    { kind: 'step', text: 'Iteration 1/1', sub: [] },
    { kind: 'step', text: 'Setting up sandbox done (95.1s)', sub: ['  CI=true pnpm install --frozen-lockfile'] },
    { kind: 'step', text: 'Agent started', sub: [] },
    { kind: 'tool', name: 'Bash', text: 'Bash(cat ticket.json)' },
    { kind: 'message', text: "I'm switching the enums to upper case." },
    { kind: 'tool', name: 'Bash', text: "Bash(python3 - <<'EOF'\nimport re\ns=s.replace(a,b)\nEOF\ngit diff | head -80)" },
    { kind: 'message', text: 'Now the tests.' },
    { kind: 'tool', name: 'Read', text: 'Read(types/sms.ts)' },
    { kind: 'step', text: 'Agent stopped', sub: [] },
    { kind: 'step', text: 'Collecting commits done (0.0s)', sub: [] },
  ]);
});

it('collapses a run of idle warnings into its latest one', () => {
  const text = 'Agent idle for 1 minute\nAgent idle for 2 minutes\nAgent idle for 3 minutes\nBash(ls)\nAgent idle for 1 minute\n';
  assert.deepEqual(parseLog(text), [
    { kind: 'step', text: 'Agent idle for 3 minutes', sub: [] },
    { kind: 'tool', name: 'Bash', text: 'Bash(ls)' },
    { kind: 'step', text: 'Agent idle for 1 minute', sub: [] },
  ]);
});

it('keeps a tool call still streaming in whole, and drops the cut-off lines before the first block', () => {
  const text = "s=open(p).read()\nEOF\ngit diff)\nNow the tests.\nBash(python3 - <<'EOF'\nimport re\n";
  assert.deepEqual(parseLog(text), [{ kind: 'tool', name: 'Bash', text: "Bash(python3 - <<'EOF'\nimport re" }]);
});

it("marks an unfinished last setup step as running since its agent log's start", () => {
  const head = '--- Run started: 2026-10-09T08:51:17.997Z ---\nSetting up sandbox\n  pnpm install\n';
  assert.deepEqual(parseLog(head).at(-1), {
    kind: 'step',
    text: 'Setting up sandbox',
    sub: ['  pnpm install'],
    since: Date.UTC(2026, 9, 9, 8, 51, 17, 997),
  });
  assert.deepEqual(parseLog(`${head}Setting up sandbox done (95.1s)\n`).at(-1), {
    kind: 'step',
    text: 'Setting up sandbox done (95.1s)',
    sub: ['  pnpm install'],
  });
});

it('reads every line of the host log as a step', () => {
  const text = 'Agent stopped\n--- Push & PR started: 2026-10-09T09:10:00.000Z ---\nPushing agent/t-1 to origin\nFailed: gh exited 1\n';
  assert.deepEqual(parseLog(text), [
    { kind: 'step', text: 'Agent stopped', sub: [] },
    { kind: 'rule', text: 'Push & PR started: 2026-10-09T09:10:00.000Z' },
    { kind: 'step', text: 'Pushing agent/t-1 to origin', sub: [] },
    { kind: 'step', text: 'Failed: gh exited 1', sub: [] },
  ]);
});

it("keeps lower-case calls inside a heredoc in the tool call, and reads mcp__ tools as calls", () => {
  const text = "Bash(python3 - <<'EOF'\nopen(p,'w').write(s)\nfeat(sms): upper case\nEOF\n)\nmcp__serena__find_symbol(name)\n";
  assert.deepEqual(parseLog(text), [
    { kind: 'tool', name: 'Bash', text: "Bash(python3 - <<'EOF'\nopen(p,'w').write(s)\nfeat(sms): upper case\nEOF\n)" },
    { kind: 'tool', name: 'mcp__serena__find_symbol', text: 'mcp__serena__find_symbol(name)' },
  ]);
});

it("keeps the agent's indented lines in its message, and a finished one-line call to itself", () => {
  const text = 'Agent started\nPlan:\n  - fix enums\nDone.\nBash(ls)\nThe tests pass (all 12)\n';
  assert.deepEqual(parseLog(text), [
    { kind: 'step', text: 'Agent started', sub: [] },
    { kind: 'message', text: 'Plan:\n  - fix enums\nDone.' },
    { kind: 'tool', name: 'Bash', text: 'Bash(ls)' },
    { kind: 'message', text: 'The tests pass (all 12)' },
  ]);
});

it("keeps a done line's own indented lines", () => {
  const text = 'Setting up sandbox\n  pnpm install\nSetting up sandbox done (1.0s)\n  extra\n';
  assert.deepEqual(parseLog(text), [{ kind: 'step', text: 'Setting up sandbox done (1.0s)', sub: ['  pnpm install', '  extra'] }]);
});
