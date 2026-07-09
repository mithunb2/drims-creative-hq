// api.test.js — exercises the serverless handlers directly with mock req/res. Proves parse returns
// a plan tokenlessly and submit is double-gated (flag off -> 403; flag on -> 501 live-wiring-pending),
// so no code path launches in this phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import parseHandler from '../../api/launch/parse.js';
import submitHandler from '../../api/launch/submit.js';

const extracted = JSON.parse(readFileSync(new URL('./fixtures/bms_golden.extracted.json', import.meta.url), 'utf8'));

function mockRes() {
  return {
    _status: 0, _json: null, _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    end() { return this; },
    send(t) { this._json = t; return this; },
  };
}

test('parse: returns a plan tokenlessly, launch not allowed', async () => {
  const res = mockRes();
  await parseHandler({ method: 'POST', body: extracted }, res);
  assert.equal(res._status, 200);
  assert.equal(res._json.tokenless, true);
  assert.ok(res._json.plan);
  assert.equal(res._json.plan.asl_gate.state, 'unknown');
  assert.equal(res._json.plan.launch_permission.allowed, false);
});

test('parse: rejects malformed body', async () => {
  const res = mockRes();
  await parseHandler({ method: 'POST', body: { paragraphs: 'nope' } }, res);
  assert.equal(res._status, 400);
});

test('submit: flag OFF -> 403 blocked_by_security_gate', async () => {
  const prev = process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  delete process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  const res = mockRes();
  await submitHandler({ method: 'POST', body: extracted }, res);
  assert.equal(res._status, 403);
  assert.equal(res._json.status, 'blocked_by_security_gate');
  if (prev !== undefined) process.env.META_LAUNCH_ALLOW_LIVE_WRITES = prev;
});

test('submit: flag ON -> still 501 live_wiring_pending (no token/live read wired)', async () => {
  const prev = process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  process.env.META_LAUNCH_ALLOW_LIVE_WRITES = '1';
  const res = mockRes();
  await submitHandler({ method: 'POST', body: extracted }, res);
  assert.equal(res._status, 501);
  assert.equal(res._json.status, 'live_wiring_pending');
  if (prev === undefined) delete process.env.META_LAUNCH_ALLOW_LIVE_WRITES;
  else process.env.META_LAUNCH_ALLOW_LIVE_WRITES = prev;
});
