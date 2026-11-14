import test from 'node:test';
import assert from 'node:assert/strict';
import {
  severityFor,
  defaultRules,
  validateRules,
  validSnapshot,
  ApiError,
  email,
} from '../worker/utils.js';
import { passwordHash, passwordMatches } from '../worker/auth.js';
test('累计恰好100不触发，101候选与确认区分风险，301确认升级', () => {
  assert.equal(severityFor(100, 'candidate', false, defaultRules), 0);
  assert.equal(severityFor(101, 'candidate', false, defaultRules), 1);
  assert.equal(severityFor(101, 'alert', true, defaultRules), 2);
  assert.equal(severityFor(300, 'alert', true, defaultRules), 2);
  assert.equal(severityFor(301, 'alert', true, defaultRules), 3);
  assert.equal(severityFor(301, 'candidate', false, defaultRules), 2);
});
test('云端规则拒绝非法阈值和无界保留期限', () => {
  assert.throws(
    () => validateRules({ frame_threshold: 100, escalation_threshold: 99 }),
    ApiError
  );
  assert.throws(() => validateRules({ retention_days: 365 }), ApiError);
  assert.equal(
    validateRules({ include_candidates: true }).include_candidates,
    true
  );
});
test('截图限制与邮箱头注入拒绝', () => {
  assert.throws(
    () => validSnapshot({ data_base64: btoa('<script>bad</script>') }),
    ApiError
  );
  assert.throws(() => email('x@example.com\r\nBcc:a@b.test'), ApiError);
});
test('口令验证及错误口令拒绝', async () => {
  const encoded = await passwordHash('poseguard-test-password-2026');
  assert.ok(await passwordMatches('poseguard-test-password-2026', encoded));
  assert.equal(
    await passwordMatches('different-long-password', encoded),
    false
  );
});
