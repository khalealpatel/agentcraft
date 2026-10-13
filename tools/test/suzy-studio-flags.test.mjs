// node --test tools/test   (or: npm test --prefix tools)
// `suzy.mjs start` on a Foreman without STUDIO-01's flags: real backends refuse, the sim warns,
// and both say exactly what is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../lib/suzy.mjs';

const gap = (...a) => {
  assert.equal(typeof lib.studioFlagGap, 'function', 'lib/suzy.mjs exports studioFlagGap');
  return lib.studioFlagGap(...a);
};

test('studio flags all supported: no refusal, no warning', () => {
  for (const backend of ['claude', 'codex', 'sim']) assert.deepEqual(gap(backend, []), { refusal: undefined, warnings: [] });
});

test('a real backend refuses when either studio flag is unsupported, and names the fix', () => {
  for (const unknown of [['setting-sources'], ['zones'], ['setting-sources', 'zones']]) {
    for (const backend of ['claude', 'codex']) {
      const r = gap(backend, unknown);
      assert.ok(r.refusal, `${backend} ${unknown}`);
      assert.deepEqual(r.warnings, []);
      for (const f of unknown) assert.match(r.refusal, new RegExp(`--${f}`));
      assert.match(r.refusal, /merge STUDIO-01/);
      assert.match(r.refusal, /update the fork/);
    }
  }
});

test('the sim keeps a warning, and it says exactly what is missing', () => {
  const r = gap('sim', ['setting-sources', 'zones']);
  assert.equal(r.refusal, undefined);
  const text = r.warnings.join('\n');
  assert.match(text, /--setting-sources/);
  assert.match(text, /--zones/);
  // upstream runs agents with settingSources: [] - they load NO settings, not your user-level ones
  assert.match(text, /no Claude Code settings at all/i);
  assert.match(text, /no CLAUDE\.md, no skills, no hooks/);
  assert.doesNotMatch(text, /load your user-level/i);
  assert.match(text, /write zones/);
  const one = gap('sim', ['zones']).warnings.join('\n');
  assert.doesNotMatch(one, /setting-sources/);
});
