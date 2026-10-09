import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { agentResult, imageExists, removeLeftoverSandboxes, stopSandbox } from '../src/sandbox';

const COMPLETE = '<promise>COMPLETE</promise>';
const NEEDS_INFO = '<promise>NEEDS_INFO</promise>';

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
