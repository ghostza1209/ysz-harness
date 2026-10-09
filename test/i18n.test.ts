import assert from 'node:assert/strict';
import { it } from 'node:test';
import { en, th } from '../web/i18n';

/** Every leaf of a dict as [path, text], calling each function with sample arguments. */
function leaves(d: object, path = ''): [string, string][] {
  return Object.entries(d).flatMap(([k, v]): [string, string][] => {
    const at = `${path}${k}`;
    if (typeof v === 'string') return [[at, v]];
    if (typeof v === 'function') return [[at, String((v as (...a: unknown[]) => unknown)('x', 2))]];
    return leaves(v as object, `${at}.`);
  });
}

it('gives Thai every English string, none of them empty', () => {
  const thai = new Map(leaves(th));
  for (const [path] of leaves(en)) assert.ok(thai.get(path)?.trim(), `th.${path} is missing or empty`);
});

it('picks singular or plural English by count', () => {
  assert.equal(en.attempts(1), '1 attempt');
  assert.equal(en.allPausedRest(1), "Nothing will start, though 1 Ticket is ready. Flip a Project's switch to resume it.");
  assert.equal(en.attempts(2), '2 attempts');
});
