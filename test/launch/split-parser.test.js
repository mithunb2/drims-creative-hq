// split-parser.test.js — proves the dual-half SPLIT parser over real .docx fixtures (built by
// scratchpad/build_dualhalf.py, extracted via the PROVEN extractor). Covers: N-agnostic fan-out,
// doc-driven editor (+blocker when absent), script/launch pairing by video_file, and VERBATIM
// preservation of both halves (reuse-not-regenerate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSplitDoc } from '../../lib/launch/parser.js';

const dir = new URL('./fixtures/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
// Registry mapping the fixtures' store to the account the doc cross-checks against (act_1234567890).
const REG = { peaceful_path: { slug: 'peaceful_path', store_name: 'Bible Made Simple', aliases: [],
  business_id: '999', business_name: 'T', accounts: ['act_1234567890'] } };
const split = (f) => parseSplitDoc(load(f), { reg: REG });

test('N-agnostic: parses however many entries the doc has (no fixed count)', () => {
  assert.equal(split('dualhalf_3.extracted.json').count, 3);
  assert.equal(split('dualhalf_12.extracted.json').count, 12);
  // and the entries array length matches the reported count exactly
  const s = split('dualhalf_12.extracted.json');
  assert.equal(s.entries.length, s.count);
});

test('editor is doc-driven: extracted when present, BLOCKER when absent (never guessed)', () => {
  const ok = split('dualhalf_3.extracted.json');
  assert.equal(ok.editor_name, 'Priya');
  assert.ok(ok.ok, 'clean doc with editor should be ok');

  const missing = split('dualhalf_noeditor.extracted.json');
  assert.equal(missing.editor_name, '');
  assert.equal(missing.ok, false);
  assert.ok(missing.blockers.some((b) => /No Editor named/i.test(b)), 'must flag missing editor as blocker');
});

test('each entry pairs its script and launch half by video_file', () => {
  const s = split('dualhalf_3.extracted.json');
  s.entries.forEach((e, i) => {
    const k = i + 1;
    assert.equal(e.video_file, `V${k}.mp4`, 'entry carries its pairing key');
    assert.equal(e.launch_half.video_file, e.video_file, 'launch half references the same video');
    assert.equal(e.ad_number, String(25 + k).padStart(3, '0'));
    assert.equal(e.launch_half.ad_set, `AS${((k - 1) % 3) + 1}`, 'ad_set resolved from quick-ref');
  });
});

test('VERBATIM: script (editor half) preserved exactly, SCRIPT: label stripped', () => {
  const e = split('dualhalf_3.extracted.json').entries[0];
  assert.ok(e.script.startsWith('Hook (0-3s): on-camera'), 'no leading SCRIPT: label');
  assert.ok(e.script.includes('Visual direction: show the product at second 1.'));
  assert.ok(e.script.includes('VO: read entry 1 in a warm, plain voice. 30 seconds.'));
  assert.ok(!/^SCRIPT:/i.test(e.script));
});

test('VERBATIM: launch half ad copy preserved exactly, NOT mixed with script or Testing label', () => {
  const e = split('dualhalf_3.extracted.json').entries[0];
  assert.ok(e.launch_half.ad_copy.includes('do not regenerate me.'), 'buyer copy kept verbatim');
  assert.ok(e.launch_half.ad_copy.includes('second line of the verbatim ad copy for entry 1.'));
  // the two halves must not bleed into each other
  assert.ok(!e.launch_half.ad_copy.includes('Visual direction'), 'script must not leak into ad copy');
  assert.ok(!e.script.includes('do not regenerate me'), 'ad copy must not leak into script');
  // Testing: label is extracted, not left in the copy
  assert.ok(!/Testing:/i.test(e.launch_half.ad_copy), 'Testing: label removed from ad copy');
  assert.equal(e.test_label, 'hook-1-vs-control');
  assert.equal(e.launch_half.test_label, 'hook-1-vs-control');
});

test('doc-level campaign_config carries the shared budget/account (held once)', () => {
  const s = split('dualhalf_3.extracted.json');
  assert.equal(s.campaign_config.Store, 'Bible Made Simple');
  assert.equal(s.campaign_config['Budget Amount (USD)'], '15.00');
  assert.equal(s.account_id, 'act_1234567890');
  assert.ok(s.budget, 'budget computed from the doc');
});

test('every entry has BOTH halves populated (nothing dropped across N)', () => {
  const s = split('dualhalf_12.extracted.json');
  for (const e of s.entries) {
    assert.ok(e.script.trim().length > 0, `entry ${e.ad_number} has a script`);
    assert.ok(e.launch_half.ad_copy.trim().length > 0, `entry ${e.ad_number} has ad copy`);
    assert.ok(e.launch_half.name_string.length > 0, `entry ${e.ad_number} has a name string`);
  }
});
