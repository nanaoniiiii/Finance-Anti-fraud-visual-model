import test from 'node:test';
import assert from 'node:assert/strict';
import { combineStationSignals } from '../shared/station-policy.js';
import { calendar, sanitizeRecord } from '../worker/workspaces.js';

test('ordinary call prompt cannot raise a warning and repeating an observation does not increase its score', () => {
  assert.equal(combineStationSignals([{code:'speech_call_indicator', confidence:.99}]).level, 0);
  const sample = {code:'speech_code_handoff', confidence:.9};
  assert.deepEqual(combineStationSignals([sample,sample,sample]), combineStationSignals([sample]));
  assert.equal(combineStationSignals([sample]).level, 2);
  assert.equal(combineStationSignals([sample,{code:'vision_phone',confidence:.95}]).level, 3);
});

test('Chinese local calendar handles leap months and midnight in UTC', () => {
  const days = calendar('day', '2028-02-09');
  assert.equal(days.buckets.length, 29);
  assert.equal(days.start, '2028-01-31T16:00:00.000Z');
  assert.equal(days.end, '2028-02-29T16:00:00.000Z');
  assert.equal(calendar('hour', '2026-11-17').buckets.length, 24);
  assert.equal(calendar('month', '2026-11-17').buckets.length, 12);
  assert.throws(() => calendar('day', '2026-02-30'));
});

test('archive records contain neither audio, transcripts nor unrecognized evidence values', () => {
  const when='2026-11-17T11:00:00.000Z';
  const event = sanitizeRecord('event', {
    id:'demo',device_id:'device',device_name:'试验设备',location:'ATM-1',
    risk_kind:'fraud_risk',status:'open',severity:2,occurred_at:when,updated_at:when,
    evidence:['speech_code_handoff','fake-secret-value','speech_code_handoff'],
    transcript:'sensitive words', audio:'data',password:'secret',
  });
  assert.deepEqual(event.evidence,['speech_code_handoff']);
  for(const field of ['transcript','audio','password']) assert.ok(!Object.hasOwn(event,field));
  assert.equal(event.snapshot,null);
});
