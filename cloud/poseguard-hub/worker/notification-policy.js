import { ApiError, identifier, parse, readSetting } from './utils.js';

export const policyKeys = [
  ...['phone_to_ear', 'multi_person', 'lingering'].flatMap((risk) =>
    [1, 2, 3].map((level) => `${risk}:${level}`),
  ),
  'device:online',
  'device:offline',
  'device:fault',
];
export const defaultNotificationPolicy = Object.fromEntries(
  policyKeys.map((key) => [key, { mode: 'all', member_ids: [] }]),
);
export function normalizeNotificationPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, '通知范围格式不正确');
  const result = {};
  for (const key of policyKeys) {
    const rule = value[key] || defaultNotificationPolicy[key];
    if (
      !['all', 'admins', 'selected', 'off'].includes(rule.mode) ||
      !Array.isArray(rule.member_ids) ||
      rule.member_ids.length > 100
    )
      throw new ApiError(400, '通知范围或指定成员不正确');
    const member_ids = [...new Set(rule.member_ids.map(identifier))];
    if (rule.mode === 'selected' && !member_ids.length)
      throw new ApiError(400, '指定成员模式至少选择一名成员');
    result[key] = { mode: rule.mode, member_ids };
  }
  return result;
}
export async function attachNotificationScope(env, category, data) {
  if (!data.notify || !['event', 'device'].includes(category)) return data;
  const key =
    category === 'event'
      ? `${data.risk_kind}:${data.notification_severity ?? data.severity}`
      : `device:${data.state}`;
  const policy = normalizeNotificationPolicy(
    await readSetting(env, 'notification_policy', {}),
  );
  return {
    ...data,
    notification_scope: policy[key] || { mode: 'all', member_ids: [] },
  };
}
export function notificationAllowed(user, change) {
  const data = change.data || parse(change.data_json, {});
  if (!data.notify) return false;
  if (change.category === 'message')
    return data.kind === 'intervention' && data.recipient_id === user.id;
  const scope = data.notification_scope;
  if (!scope || scope.mode === 'all') return true;
  if (scope.mode === 'admins') return user.role === 'owner';
  if (scope.mode === 'selected')
    return scope.member_ids?.includes(user.id) === true;
  return false;
}
export function changeForUser(user, change) {
  const data = { ...(change.data || parse(change.data_json, {})) };
  data.notify = notificationAllowed(user, change);
  return { ...change, data, data_json: JSON.stringify(data) };
}
