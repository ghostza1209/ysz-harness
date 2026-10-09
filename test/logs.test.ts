import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createRunLogs } from '../src/logs';

it("reads one Run's log files as a single stream, oldest Attempt first, ignoring other Runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runlogs-'));
  const put = (name: string, text: string) => writeFileSync(join(dir, name), text);
  put('7-attempt2-implement.log', 'D');
  put('7-attempt1-review.log', 'BC');
  put('7-attempt1-implement.log', 'A');
  put('17-attempt1-implement.log', 'other run');
  put('70-attempt1-implement.log', 'other run');
  put('7-attempt1-implement.log.bak', 'junk');
  const logs = createRunLogs(dir);

  assert.equal(await logs.size(7), 4);
  assert.equal((await logs.slice(7, 0, 4)).toString(), 'ABCD');
  assert.equal((await logs.slice(7, 1, 3)).toString(), 'BC'); // across a file boundary
  assert.equal((await logs.slice(7, 2, 99)).toString(), 'CD'); // past the end
});

it('treats a Run with no log yet, or no log directory, as empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runlogs-'));
  assert.equal(await createRunLogs(dir).size(3), 0);
  assert.equal(await createRunLogs(join(dir, 'missing')).size(3), 0);
  assert.equal((await createRunLogs(dir).slice(3, 0, 10)).length, 0);
});
