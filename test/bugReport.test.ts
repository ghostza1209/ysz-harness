import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FIELD_IDS, bugLink, gatherFacts, generalReportLink, type Exec } from '../src/bugReport';

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

describe('bug form and link', () => {
  it('every field the link can fill is an input or textarea in bug.yml, and the template is that file', () => {
    const ids = [...form.matchAll(/- type: (?:input|textarea)\n\s+id: ([\w-]+)/g)].map((m) => m[1]);
    const link = new URL(bugLink(Object.fromEntries(FIELD_IDS.map((id) => [id, 'x'])), 'a title'));
    const keys = [...link.searchParams.keys()].filter((k) => k !== 'template' && k !== 'title');
    assert.deepEqual(keys.sort(), [...FIELD_IDS].sort());
    for (const key of keys) assert.ok(ids.includes(key), `${key} is not an input or textarea id in bug.yml`);
    assert.equal(link.searchParams.get('template'), 'bug.yml');
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
