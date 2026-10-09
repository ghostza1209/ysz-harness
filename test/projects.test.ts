import assert from 'node:assert/strict';
import { it } from 'node:test';
import { projects } from '../src/projects';

it('mounts nothing into a sandbox read-write: the host would later read what the agent wrote there', () => {
  for (const p of projects) {
    for (const m of p.mounts ?? []) assert.equal(m.readonly, true, `${p.name} mounts ${m.hostPath} read-write`);
  }
});
