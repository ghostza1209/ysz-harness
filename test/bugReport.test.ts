import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FIELD_IDS, bugLink, gatherFacts, generalReportLink, redactor, runExcerpt, runReportLink, runTitle, type Exec, type Facts } from '../src/bugReport';
import { createRunLogs } from '../src/logs';
import type { Project } from '../src/projects';

const form = readFileSync(new URL('../.github/ISSUE_TEMPLATE/bug.yml', import.meta.url), 'utf8');

/** A fake machine: each command line maps to its stdout, or to an error to reject with; a command it lacks does not exist. */
const fake = (answers: Record<string, string | { code?: string } | 'hang'>): Exec => (cmd, args) => {
  const answer = answers[`${cmd} ${args.join(' ')}`] ?? { code: 'ENOENT' };
  if (answer === 'hang') return new Promise(() => {});
  return typeof answer === 'string' ? Promise.resolve(answer) : Promise.reject(Object.assign(new Error('boom'), answer));
};
const healthy = {
  'git rev-parse --short HEAD': 'abc1234\n',
  'git status --porcelain': '',
  'git rev-list --count origin/master..HEAD': '0\n',
  'docker --version': 'Docker version 27.0.1, build x\nsecond line\n',
  'bd --version': 'bd 1.2.3\n',
  'gh --version': 'gh version 2.102.0\n',
  'claude --version': '2.1.0 (Claude Code)\n',
};

const facts: Facts = { 'ysz-version': 'abc1234', modified: 'no', os: 'linux x64', node: 'v22', docker: 'Docker 27', bd: 'bd 1', gh: 'gh 2', claude: '2.1' };

describe('bug form and link', () => {
  it('every field the link can fill is an input or textarea in bug.yml, and the template is that file', () => {
    const ids = [...form.matchAll(/- type: (?:input|textarea)\n\s+id: ([\w-]+)/g)].map((m) => m[1]);
    const link = new URL(bugLink(Object.fromEntries(FIELD_IDS.map((id) => [id, 'x'])), 'a title'));
    const keys = [...link.searchParams.keys()].filter((k) => k !== 'template' && k !== 'title');
    assert.deepEqual(keys.sort(), [...FIELD_IDS].sort());
    for (const key of keys) assert.ok(ids.includes(key), `${key} is not an input or textarea id in bug.yml`);
    assert.equal(link.searchParams.get('template'), 'bug.yml');
  });

  it('a per-Run link fills only ids that bug.yml has, run-state and note among them', () => {
    const ids = [...form.matchAll(/- type: (?:input|textarea)\n\s+id: ([\w-]+)/g)].map((m) => m[1]);
    const url = new URL(runReportLink({ state: 'failed', note: 'Attempt 1 failed: the agent made no commits' }, facts, (t) => t));
    const keys = [...url.searchParams.keys()].filter((k) => k !== 'template' && k !== 'title');
    assert.ok(keys.includes('run-state') && keys.includes('note'));
    for (const key of keys) assert.ok(ids.includes(key), `${key} is not an input or textarea id in bug.yml`);
  });

  it('the general link has every fact and no title, run-state or note', async () => {
    const facts = await gatherFacts('/ysz', fake(healthy));
    const url = new URL(generalReportLink(facts));
    assert.equal(url.origin + url.pathname, 'https://github.com/ghostza1209/ysz-harness/issues/new');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      template: 'bug.yml',
      'ysz-version': 'abc1234',
      modified: 'no',
      os: `${process.platform} ${process.arch}`,
      node: process.version,
      docker: 'Docker version 27.0.1, build x',
      bd: 'bd 1.2.3',
      gh: 'gh version 2.102.0',
      claude: '2.1.0 (Claude Code)',
    });
    assert.ok(url.href.length <= 2000);
  });

  it('encodes a newline as %0A and a space as +', () => {
    assert.match(bugLink({ note: 'a b\nc' }), /note=a\+b%0Ac$/);
  });
});

describe('gatherFacts', () => {
  it('reads a missing tool as not found, a failing or hanging one as failed, and still returns the rest', async () => {
    const { 'bd --version': _bd, ...rest } = healthy;
    const facts = await gatherFacts('/ysz', fake({ ...rest, 'gh --version': { code: '1' }, 'claude --version': 'hang' }), 50);
    assert.equal(facts.bd, 'not found');
    assert.equal(facts.gh, 'failed');
    assert.equal(facts.claude, 'failed');
    assert.equal(facts.docker, 'Docker version 27.0.1, build x');
    assert.equal(facts['ysz-version'], 'abc1234');
  });

  it('several hanging probes cost one timeout, not one each', async () => {
    const started = Date.now();
    const facts = await gatherFacts('/ysz', fake({ ...healthy, 'docker --version': 'hang', 'bd --version': 'hang', 'gh --version': 'hang', 'claude --version': 'hang' }), 300);
    assert.deepEqual([facts.docker, facts.bd, facts.gh, facts.claude], ['failed', 'failed', 'failed', 'failed']);
    assert.ok(Date.now() - started < 600, `took ${Date.now() - started}ms`);
  });

  it('modified: yes for a dirty tree or unpushed commits, unknown when either probe fails', async () => {
    const modified = async (answers: Record<string, string | { code?: string }>) => (await gatherFacts('/ysz', fake({ ...healthy, ...answers }))).modified;
    assert.equal(await modified({}), 'no');
    assert.equal(await modified({ 'git status --porcelain': ' M src/a.ts\n' }), 'yes');
    assert.equal(await modified({ 'git rev-list --count origin/master..HEAD': '3\n' }), 'yes');
    assert.equal(await modified({ 'git rev-list --count origin/master..HEAD': { code: '128' } }), 'unknown');
    assert.equal(await modified({ 'git status --porcelain': { code: '128' }, 'git rev-list --count origin/master..HEAD': '3\n' }), 'unknown');
  });
});

describe('redactor', () => {
  const setup = (yszEnv: string, files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'ysz-redact-'));
    const ysz = join(root, 'ysz');
    const repoPath = join(root, 'repo');
    mkdirSync(ysz);
    mkdirSync(repoPath);
    writeFileSync(join(ysz, '.env'), yszEnv);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(repoPath, name), body);
    const project: Project = { name: 'p', repoPath, baseBranch: 'main', copyToWorktree: ['.env', 'missing.env', 'app.env'] };
    return redactor(ysz, [project], '/home/fake');
  };

  it('redacts values from ysz .env and a Project copyToWorktree file, keeps a 7-char value but not an 8-char one, skips a missing file, shows the home path as ~', () => {
    const redact = setup('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oauth-1234\nSHORT=abcdefg\nEIGHT=12345678\n', { '.env': 'DB_PASSWORD=hunter2hunter2\n', 'app.env': 'API_KEY="key with spaces"\n' });
    assert.equal(
      redact('tok sk-ant-oauth-1234 pw hunter2hunter2 k key with spaces short abcdefg eight 12345678 at /home/fake/proj'),
      'tok [redacted:CLAUDE_CODE_OAUTH_TOKEN] pw [redacted:DB_PASSWORD] k [redacted:API_KEY] short abcdefg eight [redacted:EIGHT] at ~/proj',
    );
  });

  it('of two values where one contains the other, nothing of the longer is left', () => {
    const redact = setup('SHORT_ONE=secret-abc\nLONG_ONE=secret-abcdef-tail\n', {});
    assert.equal(redact('x secret-abcdef-tail y secret-abc z'), 'x [redacted:LONG_ONE] y [redacted:SHORT_ONE] z');
  });

  it('reads the files per call, so a new secret is redacted without a restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'ysz-redact-'));
    const redact = redactor(root, [], '/home/fake');
    assert.equal(redact('later-secret-value'), 'later-secret-value');
    writeFileSync(join(root, '.env'), 'LATER=later-secret-value\n');
    assert.equal(redact('later-secret-value'), '[redacted:LATER]');
  });
});

describe('runExcerpt', () => {
  const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';
  const logsDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ysz-logs-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return createRunLogs(dir);
  };
  const run = { id: 7, ticketId: 'abc-1', state: 'failed' as const, note: 'line one\nline two' };

  it('holds the header, the full note, the whole host log first, then the last 50 lines of each agent part', async () => {
    const logs = logsDir({ '7-attempt1-implement.log': lines('impl', 60), '7-attempt1-review.log': lines('rev', 3), '7-host.log': 'h1\nh2\n', '8-host.log': 'other run' });
    const { name, text } = await runExcerpt(run, logs, (t) => t);
    assert.equal(name, 'abc-1-run7.log');
    const expected = [
      'ysz Bug report: abc-1, Run 7\nState: failed\nNote:\nline one\nline two',
      '--- host ---\nh1\nh2',
      `--- attempt1-implement (last 50 lines) ---\n${lines('impl', 60).split('\n').slice(10, 60).join('\n')}`,
      '--- attempt1-review (last 50 lines) ---\nrev1\nrev2\nrev3',
    ].join('\n\n') + '\n';
    assert.equal(text, expected);
  });

  it('a Run with no host log has no host section, and no note reads (none)', async () => {
    const logs = logsDir({ '7-attempt1-implement.log': 'only\n' });
    const { text } = await runExcerpt({ ...run, note: null }, logs, (t) => t);
    assert.equal(text, 'ysz Bug report: abc-1, Run 7\nState: failed\nNote:\n(none)\n\n--- attempt1-implement (last 50 lines) ---\nonly\n');
  });

  it('redacts the whole file, note and every log part included', async () => {
    const ysz = mkdtempSync(join(tmpdir(), 'ysz-redact-'));
    writeFileSync(join(ysz, '.env'), 'TOKEN=s3cr3tvalue\n');
    const logs = logsDir({ '7-host.log': 'host s3cr3tvalue\n', '7-attempt1-implement.log': 'agent s3cr3tvalue\n' });
    const { text } = await runExcerpt({ ...run, note: 'token is s3cr3tvalue' }, logs, redactor(ysz, [], '/home/fake'));
    assert.equal(
      text,
      'ysz Bug report: abc-1, Run 7\nState: failed\nNote:\ntoken is [redacted:TOKEN]\n\n--- host ---\nhost [redacted:TOKEN]\n\n--- attempt1-implement (last 50 lines) ---\nagent [redacted:TOKEN]\n',
    );
  });
});

describe('runTitle', () => {
  const same = (t: string) => t;
  const hook = "Hook 'CI=true pnpm install --frozen-lockfile --store-dir /home/agent/.pnpm-store' timed out after 600000ms";
  const cases: [string, string, string | undefined][] = [
    ['two Attempts: the first reason, inner prefix dropped', `Attempt 1 failed: the implement agent failed: ${hook}\nAttempt 2 failed: the implement agent failed: ${hook}`, hook],
    ['stopped without COMPLETE: the tail dropped', 'Attempt 1 failed: the implement agent stopped without signalling COMPLETE: the ticket asks for', 'The implement agent stopped without signalling COMPLETE'],
    ['a stock reason stays whole', 'Attempt 1 failed: the agent made no commits', 'The agent made no commits'],
    ['unusable plan stays whole', "Attempt 1 failed: the breakdown agent's plan is unusable: it output no <ticket> tags", "The breakdown agent's plan is unusable: it output no <ticket> tags"],
    ['needs information: the question, first line only', 'The implement agent needs information:\nWhich branch holds the login API?\n\nMore detail', 'Which branch holds the login API?'],
    ['interrupted', 'Interrupted by a ysz restart while agent; not counted as an Attempt.', 'Interrupted by a ysz restart while agent'],
    ['interrupted with a release failure: the suffix is the title', 'Interrupted by a ysz restart while agent-review; not counted as an Attempt.; releasing the Ticket failed: bd exited 1', 'Releasing the Ticket failed: bd exited 1'],
    ['killed with a PR: no title', 'Killed from the dashboard while agent. (PR https://github.com/o/r/pull/3 was opened)', undefined],
    ['killed with a release failure: the suffix is the title', 'Killed from the dashboard while host.; releasing the Ticket failed: bd exited 1', 'Releasing the Ticket failed: bd exited 1'],
    ['both suffixes dropped when the rest has a cause', 'Attempt 1 failed: the implement agent failed: boom\nhanding the Ticket back failed: bd exited 1; releasing the Ticket failed: bd exited 1', 'Boom'],
    ['an unexpected error is taken whole', 'spawn docker ENOENT; releasing the Ticket failed: bd exited 1', 'Spawn docker ENOENT'],
    ['a needs-attention host error', 'git push failed: rejected', 'Git push failed: rejected'],
    ['nothing', '', undefined],
  ];
  for (const [name, note, title] of cases) it(name, () => assert.equal(runTitle(note, same), title));

  it('a Thai question is cut to its first 120 code points, then …', () => {
    assert.equal(runTitle(`The implement agent needs information:\n${'ก'.repeat(200)}`, same), `${'ก'.repeat(120)}…`);
  });

  it('cuts by code points, not UTF-16 units', () => {
    assert.equal(runTitle('😀'.repeat(121), same), `${'😀'.repeat(120)}…`);
    assert.equal(runTitle('😀'.repeat(120), same), '😀'.repeat(120));
  });

  it('a secret shows as [redacted:KEY] in the title and the note, also when it would straddle the 120 cut', () => {
    const ysz = mkdtempSync(join(tmpdir(), 'ysz-redact-'));
    writeFileSync(join(ysz, '.env'), 'KEY=s3cr3t-value-x\n');
    const redact = redactor(ysz, [], '/home/fake');
    // the secret starts at code point 110 of the title, so a cut at 120 would land inside the marker
    const note = `Attempt 1 failed: the implement agent failed: ${'x'.repeat(109)}s3cr3t-value-x tail`;
    const url = new URL(runReportLink({ state: 'failed', note }, facts, redact));
    assert.equal(url.searchParams.get('title'), `X${'x'.repeat(108)}[redacted:KEY]…`);
    assert.equal(url.searchParams.get('note'), `Attempt 1 failed: the implement agent failed: ${'x'.repeat(109)}[redacted:KEY] tail`);
    assert.ok(!url.href.includes('s3cr3t'));
  });
});

describe('runReportLink', () => {
  const same = (t: string) => t;

  it('a short note goes whole, with the state and the facts', () => {
    const note = 'Attempt 1 failed: the agent made no commits';
    const url = new URL(runReportLink({ state: 'failed', note }, facts, same));
    assert.deepEqual(Object.fromEntries(url.searchParams), { template: 'bug.yml', title: 'The agent made no commits', ...facts, 'run-state': 'failed', note });
  });

  it('a kill has no title but keeps its note', () => {
    const url = new URL(runReportLink({ state: 'killed', note: 'Killed from the dashboard while agent.' }, facts, same));
    assert.equal(url.searchParams.has('title'), false);
    assert.equal(url.searchParams.get('note'), 'Killed from the dashboard while agent.');
  });

  it('a Run with no note has no note or title', () => {
    const url = new URL(runReportLink({ state: 'interrupted', note: null }, facts, same));
    assert.equal(url.searchParams.has('note') || url.searchParams.has('title'), false);
    assert.equal(url.searchParams.get('run-state'), 'interrupted');
  });

  it('a 1,470-char Thai note gives a link of at most 2,000 chars whose note ends with …', () => {
    const note = `The implement agent needs information:\n${'ก'.repeat(1430)}`;
    const link = runReportLink({ state: 'needs-attention', note }, facts, same);
    assert.ok(link.length <= 2000, `${link.length}`);
    assert.ok(link.length > 2000 - 9, `the cut leaves less than one Thai letter of room, got ${link.length}`);
    const kept = new URL(link).searchParams.get('note')!;
    assert.ok(kept.endsWith('…') && kept.length > 10 && kept.length < note.length);
    assert.ok(note.startsWith(kept.slice(0, -1)));
  });

  it('when the budget leaves nothing for the note, there is no note=', () => {
    const link = runReportLink({ state: 'failed', note: `The implement agent needs information:\n${'ก'.repeat(220)}` }, { ...facts, docker: 'd'.repeat(716) }, same);
    assert.equal(new URL(link).searchParams.has('note'), false);
    assert.ok(link.length <= 2000);
  });
});
