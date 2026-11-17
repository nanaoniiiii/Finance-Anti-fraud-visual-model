import test from 'node:test';
import assert from 'node:assert/strict';
import { combineStationSignals, stationWindowMs } from '../shared/station-policy.js';
import { forwardVision } from '../worker/station-fusion.js';
import { calendar, sanitizeRecord } from '../worker/workspaces.js';

test('ordinary call prompt cannot raise a warning and repeating an observation does not increase its score', () => {
  assert.equal(combineStationSignals([{code:'speech_call_indicator', confidence:.99}]).level, 0);
  const sample = {code:'speech_code_handoff', confidence:.9};
  assert.deepEqual(combineStationSignals([sample,sample,sample]), combineStationSignals([sample]));
  assert.equal(combineStationSignals([sample]).level, 2);
  assert.equal(combineStationSignals([sample,{code:'vision_phone',confidence:.95}]).level, 3);
});

test('edge fusion clamps a modest vision clock lead and excludes stale evidence', async () => {
  const forwarded = [];
  const env = {
    DEPLOYMENT_MODE: 'edge',
    ROOMS: {
      idFromName: (name) => name,
      get: () => ({ fetch: async (_url, init) => {
        forwarded.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      } }),
    },
  };
  const device = { id: 'camera', is_test: 1, config_json: '{"fusion_group":"ATM-01"}' };
  const event = { event_id: 'live', revision: 1, risk_kind: 'phone_to_ear', update_type: 'created' };
  const receiptStart = Date.now();
  await forwardVision(env, device, { ...event, updated_at: new Date(receiptStart + 11_300).toISOString() });
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].codes, ['vision_phone']);
  assert.equal(forwarded[0].scope, 'test:group:ATM-01');
  assert.ok(forwarded[0].captured_at >= receiptStart && forwarded[0].captured_at <= Date.now());

  for (const offset of [-stationWindowMs - 1000, 31_000]) {
    await forwardVision(env, device, { ...event, updated_at: new Date(Date.now() + offset).toISOString() });
  }
  assert.equal(forwarded.length, 1);
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
