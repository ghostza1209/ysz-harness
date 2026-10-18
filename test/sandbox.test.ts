import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { agentResult, imageExists, removeLeftoverSandboxes, stopSandbox, teeCommand, usageTracker } from '../src/sandbox';

const COMPLETE = '<promise>COMPLETE</promise>';
const NEEDS_INFO = '<promise>NEEDS_INFO</promise>';
const execFileAsync = promisify(execFile);

it('has neither agent prompt ask for a Follow-ups: heading in commit messages, and both ask for <follow-up> tags', () => {
  for (const role of ['implement', 'review']) {
    const prompt = readFileSync(join(import.meta.dirname, `../prompts/${role}.md`), 'utf8');
    assert.doesNotMatch(prompt, /Follow-ups:/, role);
    assert.match(prompt, /<follow-up>\n[^\n]*\n[^\n]*\n<\/follow-up>/, role);
  }
});

it('keeps the agent prompts free of !`…`, which sandcastle runs as a shell command', () => {
  for (const role of ['implement', 'review']) {
    const prompt = readFileSync(join(import.meta.dirname, `../prompts/${role}.md`), 'utf8');
    assert.deepEqual(prompt.match(/!`[^`]+`/g), null, role);
  }
});

it('reports usage once per message, keeps a subagent out of the context, and ends on the results\' modelUsage total', () => {
  // Shaped like a real `claude -p --output-format stream-json --verbose` run: one message per content block repeats its usage.
  const usage = (i: number, cc: number, cr: number, o: number) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o });
  const assistant = (id: string, u: object, parent: string | null = null) =>
    JSON.stringify({ type: 'assistant', message: { id, type: 'message', content: [], usage: u }, parent_tool_use_id: parent });
  const seen: object[] = [];
  const track = usageTracker((u) => seen.push(u));
  for (const line of [
    '{"type":"system","subtype":"init"}',
    assistant('msg_1', usage(2, 24431, 11091, 4)),
    assistant('msg_1', usage(2, 24431, 11091, 4)),
    '{"type":"user","message":{"content":[{"type":"tool_result","content":"{\\"usage\\":1}"}]}}',
    assistant('msg_sub', usage(3, 1000, 0, 7), 'toolu_1'),
    assistant('msg_2', usage(2, 2499, 35522, 6)),
    'Agent stopped',
    // Claude Code ends on several results: each has the session's modelUsage, the last one a usage of 0.
    ...[usage(4, 26930, 46613, 197), usage(0, 0, 0, 0)].map((u) =>
      JSON.stringify({ duration_api_ms: 3994, usage: u, modelUsage: { haiku: { inputTokens: 7, outputTokens: 214, cacheReadInputTokens: 46613, cacheCreationInputTokens: 27930 } }, type: 'result' }),
    ),
  ]) track(line);
  assert.deepEqual(seen, [
    { context: 35524, tokens: 35528 },
    { context: 35524, tokens: 36538 },
    { context: 38023, tokens: 74567 },
    { context: 38023, tokens: 74764 },
  ]);
});

it('reads COMPLETE as complete', () => {
  assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout: 'done' }), { outcome: 'complete', reports: { followUps: [], friction: [] } });
});

it('takes the last <question> of the output as the question for NEEDS_INFO', () => {
  const stdout = 'I may ask <question>first?</question> later.\n<question>\n  Which of the two APIs?\nBoth fit.\n</question>\n' + NEEDS_INFO;
  assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout }), { outcome: 'needs-info', question: 'Which of the two APIs?\nBoth fit.', reports: { followUps: [], friction: [] } });
});

it('goes by the signal the agent ended on, not the one sandcastle matched first', () => {
  const stdout = `I will print ${COMPLETE} once done, but first: <question>Which API?</question>\n${NEEDS_INFO}`;
  assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout }), { outcome: 'needs-info', question: 'Which API?', reports: { followUps: [], friction: [] } });
});

it('still ends needs-info, with a stand-in question, when the agent forgot the <question>', () => {
  assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout: NEEDS_INFO }), {
    outcome: 'needs-info',
    question: 'the agent signalled NEEDS_INFO without a <question>',
    reports: { followUps: [], friction: [] },
  });
});

it('reads no signal as stopped and keeps only the last 500 characters of what the agent said', () => {
  const result = agentResult({ stdout: `${'a'.repeat(1000)}\nblocked: no database \n` });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.outcome === 'stopped' && result.tail.length, 500);
  assert.ok(result.outcome === 'stopped' && result.tail.endsWith('blocked: no database'));
});

describe('the <friction> reports', () => {
  const friction = (stdout: string) => agentResult({ completionSignal: COMPLETE, stdout }).reports.friction;

  it('takes the title from the first non-empty line and the rest as the body', () => {
    assert.deepEqual(friction('<friction>\n\n  No php in the sandbox \nphpunit exited 127.\nI skipped it.\n</friction>'), [
      { title: 'No php in the sandbox', body: 'phpunit exited 127.\nI skipped it.' },
    ]);
    assert.deepEqual(friction('<friction>Title only</friction>'), [{ title: 'Title only', body: '' }]);
  });

  it('reads every tag in the output, not just the last, and keeps the first 3', () => {
    const stdout = ['one', 'two', 'three', 'four'].map((t) => `<friction>${t}</friction>`).join('\ntext between\n');
    assert.deepEqual(friction(stdout).map((f) => f.title), ['one', 'two', 'three']);
  });

  it('drops tags with an empty title, before counting to 3', () => {
    const stdout = '<friction>  \n </friction><friction></friction><friction>a</friction><friction>b</friction><friction>c</friction><friction>d</friction>';
    assert.deepEqual(friction(stdout).map((f) => f.title), ['a', 'b', 'c']);
  });

  it('drops a tag that never closes, and a tag opened inside another', () => {
    assert.deepEqual(friction('<friction>never closed\nand more text'), []);
    assert.deepEqual(friction('<friction>outer <friction>inner</friction>').map((f) => f.title), ['inner']);
  });

  it('bounds the title to 200 characters and the body to 2000', () => {
    const [found] = friction(`<friction>${'t'.repeat(300)}\n${'b'.repeat(3000)}</friction>`);
    assert.deepEqual([found.title.length, found.body.length], [200, 2000]);
  });

  it('reads ref as the id of an open Friction, and leaves it off a tag without one', () => {
    const stdout = '<friction ref="ysz-12">\nphpunit exited 127 again\nskipped it\n</friction><friction>new one</friction>';
    assert.deepEqual(friction(stdout), [
      { title: 'phpunit exited 127 again', body: 'skipped it', ref: 'ysz-12' },
      { title: 'new one', body: '' },
    ]);
  });

  it('counts references towards the cap of 3', () => {
    const stdout = ['<friction ref="ysz-1">a</friction>', '<friction>b</friction>', '<friction ref="ysz-2">c</friction>', '<friction ref="ysz-3">d</friction>', '<friction>e</friction>'].join('\n');
    assert.deepEqual(friction(stdout).map((f) => [f.title, f.ref]), [['a', 'ysz-1'], ['b', undefined], ['c', 'ysz-2']]);
  });

  it('drops a reference with no text, and a tag opened inside a reference', () => {
    assert.deepEqual(friction('<friction ref="ysz-1">  </friction>'), []);
    assert.deepEqual(friction('<friction ref="ysz-1">outer <friction>inner</friction>').map((f) => f.title), ['inner']);
  });

  it('is reported on needs-info and stopped as well as complete', () => {
    const tag = '<friction>check hint is wrong</friction>';
    const expected = [{ title: 'check hint is wrong', body: '' }];
    assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout: `${tag}<question>q?</question>${NEEDS_INFO}` }).reports.friction, expected);
    assert.deepEqual(agentResult({ stdout: `blocked ${tag}` }).reports.friction, expected);
    assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout: tag }).reports.friction, expected);
  });
});

describe('the <follow-up> reports', () => {
  const followUps = (stdout: string) => agentResult({ completionSignal: COMPLETE, stdout }).reports.followUps;

  it('takes the title from the first non-empty line and the rest as the body', () => {
    assert.deepEqual(followUps('<follow-up>\n\n  Drop the old export \nNothing imports it.\nIt can go.\n</follow-up>'), [
      { title: 'Drop the old export', body: 'Nothing imports it.\nIt can go.' },
    ]);
    assert.deepEqual(followUps('<follow-up>Title only</follow-up>'), [{ title: 'Title only', body: '' }]);
  });

  it('reads every tag of the message and keeps the first 3', () => {
    const stdout = ['one', 'two', 'three', 'four'].map((t) => `<follow-up>${t}</follow-up>`).join('\ntext between\n');
    assert.deepEqual(followUps(stdout).map((f) => f.title), ['one', 'two', 'three']);
  });

  it('drops empty titles before counting, and a tag that is never closed or opened inside another', () => {
    const stdout = '<follow-up>  \n </follow-up><follow-up></follow-up><follow-up>a</follow-up><follow-up>b</follow-up><follow-up>c</follow-up><follow-up>d</follow-up>';
    assert.deepEqual(followUps(stdout).map((f) => f.title), ['a', 'b', 'c']);
    assert.deepEqual(followUps('<follow-up>never closed\nand more text'), []);
    assert.deepEqual(followUps('<follow-up>outer <follow-up>inner</follow-up>').map((f) => f.title), ['inner']);
  });

  it('bounds the title to 200 characters and the body to 2000', () => {
    const [found] = followUps(`<follow-up>${'t'.repeat(300)}\n${'b'.repeat(3000)}</follow-up>`);
    assert.deepEqual([found.title.length, found.body.length], [200, 2000]);
  });

  it('counts apart from Friction, and is reported on needs-info and stopped as well as complete', () => {
    const tag = '<follow-up>drop it</follow-up>';
    const expected = [{ title: 'drop it', body: '' }];
    const frictions = '<friction>a</friction><friction>b</friction><friction>c</friction>';
    assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout: frictions + tag }).reports.followUps, expected);
    assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout: `${tag}<question>q?</question>${NEEDS_INFO}` }).reports.followUps, expected);
    assert.deepEqual(agentResult({ stdout: `blocked ${tag}` }).reports.followUps, expected);
  });
});

/** teeCommand on a fake sandbox handle: its exec streams one stdout line, then fails with stderr, as a broken pnpm install does. */
describe('teeCommand', () => {
  let root: string;
  let log: string;
  const handle = {
    worktreePath: '/home/agent/workspace',
    exec: async (_command: string, opts?: { onLine?: (line: string) => void }) => {
      opts?.onLine?.('Progress: resolved 12, reused 12');
      return { stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE lockfile is out of date\n', exitCode: 1 };
    },
    close: async () => {},
    copyFileIn: async () => {},
    copyFileOut: async () => {},
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tee-'));
    log = join(root, 'agent.log');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('appends the command stdout and stderr to the log, indented under the setup step, even when it fails', async () => {
    const result = await teeCommand(handle, 'pnpm install', log).exec('pnpm install');
    assert.equal(result.exitCode, 1);
    assert.equal(readFileSync(log, 'utf8'), '  Progress: resolved 12, reused 12\n  ERR_PNPM_OUTDATED_LOCKFILE lockfile is out of date\n');
  });

  it('passes any other command straight through and writes nothing', async () => {
    assert.equal((await teeCommand(handle, 'pnpm install', log).exec('git rev-parse HEAD')).exitCode, 1);
    assert.throws(() => readFileSync(log), /ENOENT/);
  });
});

/** stopSandbox against a fake `docker`: containers live in a file, every call is logged. */
describe('stopSandbox', () => {
  let root: string;
  let docker: string;
  const logOf = () => readFileSync(join(root, 'log'), 'utf8').trim().split('\n');
  const setContainers = (...ids: string[]) => writeFileSync(join(root, 'containers'), ids.map((id) => `${id}\n`).join(''));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fake-docker-'));
    docker = join(root, 'docker');
    writeFileSync(join(root, 'log'), '');
    setContainers();
    writeFileSync(
      docker,
      `#!/bin/sh
echo "$@" >> ${root}/log
case "$1" in
  ps) cat ${root}/containers ;;
  rm)
    if [ -f ${root}/rm-fails ]; then echo 'permission denied' >&2; exit 1; fi
    : > ${root}/containers
    if [ -f ${root}/rm-races ]; then echo 'No such container' >&2; exit 1; fi ;;
esac
`,
    );
    chmodSync(docker, 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes the containers that mount this Run\'s clone, and no others', async () => {
    setContainers('aaa', 'bbb');
    await stopSandbox({ dir: '/clones/tv1-1' }, docker);
    assert.deepEqual(logOf(), [
      'ps -aq --no-trunc --filter volume=/clones/tv1-1/repo',
      'rm -f aaa bbb',
      'ps -aq --no-trunc --filter volume=/clones/tv1-1/repo',
    ]);
  });

  it('does nothing when no container is left', async () => {
    await stopSandbox({ dir: '/clones/tv1-1' }, docker);
    assert.equal(logOf().length, 1);
  });

  it('throws, naming docker\'s error, when the container is still there after docker rm failed', async () => {
    setContainers('aaa');
    writeFileSync(join(root, 'rm-fails'), '');
    await assert.rejects(stopSandbox({ dir: '/clones/tv1-1' }, docker), /container aaa is still there[\s\S]*permission denied/);
  });

  it('succeeds when docker rm lost the race to sandcastle but the container is gone', async () => {
    setContainers('aaa');
    writeFileSync(join(root, 'rm-races'), '');
    await stopSandbox({ dir: '/clones/tv1-1' }, docker);
  });

  it('removes every sandcastle container, whichever Run it served', async () => {
    setContainers('aaa', 'bbb');
    await removeLeftoverSandboxes(docker);
    assert.deepEqual(logOf(), ['ps -aq --no-trunc --filter name=sandcastle-', 'rm -f aaa bbb', 'ps -aq --no-trunc --filter name=sandcastle-']);
  });

  it('throws when docker cannot be asked', async () => {
    await assert.rejects(stopSandbox({ dir: '/clones/tv1-1' }, join(root, 'no-such-docker')), /ENOENT/);
  });
});

/** imageExists against a fake `docker` that knows one image. */
describe('imageExists', () => {
  let root: string;
  let docker: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fake-docker-'));
    docker = join(root, 'docker');
    writeFileSync(docker, '#!/bin/sh\n[ "$1 $2 $3" = "image inspect ysz-harness/app" ] || { echo "No such image: $3" >&2; exit 1; }\n');
    chmodSync(docker, 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is true for an image docker knows and false for one it does not', async () => {
    assert.equal(await imageExists('ysz-harness/app', docker), true);
    assert.equal(await imageExists('ysz-harness/gone', docker), false);
  });

  it('is false, not a throw, when docker cannot be run', async () => {
    assert.equal(await imageExists('ysz-harness/app', join(root, 'no-such-docker')), false);
  });
});

/**
 * sandcastle (patches/) against a fake `claude` that prints a line after the Run is aborted. Unpatched, that line restarts
 * the idle warnings in a fiber nobody stops: they append "Agent idle for N minutes" to the killed Run's log for good, and
 * their timers keep the process from exiting.
 */
it('stops writing to the log of an aborted agent, even when the agent prints after the abort', async () => {
  const root = mkdtempSync(join(tmpdir(), 'abort-late-line-'));
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/claude'), `#!/bin/sh\ncat >/dev/null\necho '{"type":"system","subtype":"init","session_id":"s"}'\nsleep 1\necho '{"type":"system","subtype":"init","session_id":"s"}'\n`);
    chmodSync(join(root, 'bin/claude'), 0o755);
    execFileSync('git', ['init', '--quiet', join(root, 'repo')]);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 't'], { cwd: join(root, 'repo') });
    writeFileSync(join(root, 'prompt.md'), 'go');
    const script = `
      import { claudeCode, run } from '@ai-hero/sandcastle';
      import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(new Error('killed')), 500);
      await run({ cwd: ${JSON.stringify(join(root, 'repo'))}, agent: claudeCode('m'), sandbox: noSandbox(), branchStrategy: { type: 'head' },
        promptFile: ${JSON.stringify(join(root, 'prompt.md'))}, signal: ctl.signal, logging: { type: 'file', path: ${JSON.stringify(join(root, 'agent.log'))} } })
        .catch(() => {});`;
    // Exits by itself in ~1s once nothing is left running; a leaked warning fiber holds it until the timeout kills it.
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      timeout: 10_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
