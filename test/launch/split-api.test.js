// split-api.test.js — the editor resolver (pure) + the /api/launch/split handler (mock req/res,
// mocked ClickUp /team). Proves: editor resolves by username/first-name/email; ambiguity + not-found
// become blockers; missing token → blocker; a clean doc + resolvable editor → ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchEditor, membersFromTeamResponse } from '../../lib/launch/editor.js';
import splitHandler from '../../api/launch/split.js';

const extracted = JSON.parse(readFileSync(new URL('./fixtures/dualhalf_3.extracted.json', import.meta.url), 'utf8'));
const noeditor = JSON.parse(readFileSync(new URL('./fixtures/dualhalf_noeditor.extracted.json', import.meta.url), 'utf8'));

function mockRes() {
  return { _status: 0, _json: null, setHeader() {}, status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; }, end() { return this; } };
}
const SERVER_TOKEN = 'pk_SERVER_SIDE_RESOLVER_TOKEN_never_in_browser';
// Set the SERVER-SIDE resolver token + a fake ClickUp /team, run fn, then restore both.
function withServerResolver(members, fn) {
  const realFetch = globalThis.fetch;
  const prev = process.env.CLICKUP_LAUNCH_TOKEN;
  process.env.CLICKUP_LAUNCH_TOKEN = SERVER_TOKEN;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ teams: [{ members: members.map((u) => ({ user: u })) }] }) });
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env.CLICKUP_LAUNCH_TOKEN; else process.env.CLICKUP_LAUNCH_TOKEN = prev;
  });
}

test('matchEditor: exact username / first-name / email; ambiguous; not-found', () => {
  const M = [{ id: '1', username: 'Priya Sharma', email: 'priya@x.com' },
    { id: '2', username: 'Ravi', email: 'ravi@x.com' }];
  assert.equal(matchEditor('Priya Sharma', M).assignee_id, '1');       // exact username
  assert.equal(matchEditor('Priya', M).assignee_id, '1');              // first-name
  assert.equal(matchEditor('ravi', M).assignee_id, '2');               // ci username
  assert.equal(matchEditor('priya', [{ id: '9', username: 'x', email: 'priya@x.com' }]).assignee_id, '9'); // email local
  const amb = matchEditor('Sam', [{ id: 'a', username: 'Sam Lee' }, { id: 'b', username: 'Sam Fox' }]);
  assert.equal(amb.resolved, false); assert.equal(amb.candidates.length, 2);
  const none = matchEditor('Nobody', M);
  assert.equal(none.resolved, false); assert.match(none.reason, /not found/);
});

test('membersFromTeamResponse flattens teams and de-dups by id', () => {
  const json = { teams: [{ members: [{ user: { id: 1, username: 'A' } }, { user: { id: 2, username: 'B' } }] },
    { members: [{ user: { id: 1, username: 'A' } }] }] };
  const m = membersFromTeamResponse(json);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.id).sort(), ['1', '2']);
});

test('split handler: server resolver present + resolvable editor → resolved, assignee attached', async () => {
  const res = mockRes();
  await withServerResolver([{ id: '77', username: 'Priya Sharma', email: 'priya@x.com' }], () =>
    splitHandler({ method: 'POST', headers: {}, body: extracted }, res));
  assert.equal(res._status, 200);
  const s = res._json.split;
  assert.equal(s.count, 3);
  assert.equal(s.editor.resolved, true);
  assert.equal(s.editor_assignee_id, '77');
  assert.ok(!s.blockers.some((b) => /Editor/i.test(b)), 'no editor blocker when resolved');
});

test('split handler: server resolver present + unresolvable editor → BLOCKER', async () => {
  const res = mockRes();
  await withServerResolver([{ id: '5', username: 'Someone Else' }], () =>
    splitHandler({ method: 'POST', headers: {}, body: extracted }, res));
  const s = res._json.split;
  assert.equal(s.editor.resolved, false);
  assert.equal(s.editor_assignee_id, null);
  assert.ok(s.blockers.some((b) => /Editor not assignable/i.test(b)));
});

test('split handler: NO server token → editor DEFERRED to intake, NOT a blocker', async () => {
  const prev = process.env.CLICKUP_LAUNCH_TOKEN;
  delete process.env.CLICKUP_LAUNCH_TOKEN;
  const res = mockRes();
  await splitHandler({ method: 'POST', headers: {}, body: extracted }, res);
  const s = res._json.split;
  assert.equal(s.editor.resolved, false);
  assert.equal(s.editor.deferred, true);
  assert.ok(!s.blockers.some((b) => /Editor/i.test(b)), 'deferral is not a blocker');
  if (prev !== undefined) process.env.CLICKUP_LAUNCH_TOKEN = prev;
});

test('split handler: doc with no Editor field → blocker regardless of resolver', async () => {
  const res = mockRes();
  await splitHandler({ method: 'POST', headers: {}, body: noeditor }, res);
  const s = res._json.split;
  assert.ok(s.blockers.some((b) => /No Editor named/i.test(b)));
  assert.equal(s.ok, false);
});

test('TOKEN NEVER LEAKS: server resolver token absent from the response', async () => {
  const res = mockRes();
  await withServerResolver([{ id: '1', username: 'Priya' }], () =>
    splitHandler({ method: 'POST', headers: {}, body: extracted }, res));
  assert.ok(!JSON.stringify(res._json).includes(SERVER_TOKEN), 'resolver token must never appear in the response');
});
