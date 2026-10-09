import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { agentResult, imageExists, removeLeftoverSandboxes, stopSandbox, teeCommand } from '../src/sandbox';

const COMPLETE = '<promise>COMPLETE</promise>';
const NEEDS_INFO = '<promise>NEEDS_INFO</promise>';
const execFileAsync = promisify(execFile);

it('reads COMPLETE as complete', () => {
  assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout: 'done' }), { outcome: 'complete' });
});

it('takes the last <question> of the output as the question for NEEDS_INFO', () => {
  const stdout = 'I may ask <question>first?</question> later.\n<question>\n  Which of the two APIs?\nBoth fit.\n</question>\n' + NEEDS_INFO;
  assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout }), { outcome: 'needs-info', question: 'Which of the two APIs?\nBoth fit.' });
});

it('goes by the signal the agent ended on, not the one sandcastle matched first', () => {
  const stdout = `I will print ${COMPLETE} once done, but first: <question>Which API?</question>\n${NEEDS_INFO}`;
  assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout }), { outcome: 'needs-info', question: 'Which API?' });
});

it('still ends needs-info, with a stand-in question, when the agent forgot the <question>', () => {
  assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout: NEEDS_INFO }), {
    outcome: 'needs-info',
    question: 'the agent signalled NEEDS_INFO without a <question>',
  });
});

it('reads no signal as stopped and keeps only the last 500 characters of what the agent said', () => {
  const result = agentResult({ stdout: `${'a'.repeat(1000)}\nblocked: no database \n` });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.outcome === 'stopped' && result.tail.length, 500);
  assert.ok(result.outcome === 'stopped' && result.tail.endsWith('blocked: no database'));
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
