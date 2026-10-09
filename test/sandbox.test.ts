import assert from 'node:assert/strict';
import { it } from 'node:test';
import { agentResult } from '../src/sandbox';

const COMPLETE = '<promise>COMPLETE</promise>';
const NEEDS_INFO = '<promise>NEEDS_INFO</promise>';

it('reads COMPLETE as complete', () => {
  assert.deepEqual(agentResult({ completionSignal: COMPLETE, stdout: 'done' }), { outcome: 'complete' });
});

it('takes the last <question> of the output as the question for NEEDS_INFO', () => {
  const stdout = 'I may ask <question>first?</question> later.\n<question>\n  Which of the two APIs?\nBoth fit.\n</question>\n' + NEEDS_INFO;
  assert.deepEqual(agentResult({ completionSignal: NEEDS_INFO, stdout }), { outcome: 'needs-info', question: 'Which of the two APIs?\nBoth fit.' });
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
