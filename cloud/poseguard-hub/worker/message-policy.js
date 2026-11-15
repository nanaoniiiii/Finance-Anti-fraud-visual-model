import { parse } from './utils.js';

export function userTags(user) {
  return [`user:${user.id}`, ...(user.role === 'owner' ? ['role:owner'] : [])];
}
export function changeVisible(tags, change) {
  const audience = parse(change.audience_json || '[]', null);
  if (!Array.isArray(audience)) return false;
  return !audience.length || audience.some((tag) => tags.includes(tag));
}
export function messageAudience(senderId, recipientId) {
  return JSON.stringify([
    ...new Set([
      `user:${senderId}`,
      ...(recipientId ? [`user:${recipientId}`] : []),
      'role:owner',
    ]),
  ]);
}
export function shouldInterruptMessage(userId, change) {
  const data = change.data || parse(change.data_json, {});
  return (
    change.category === 'message' &&
    data.kind === 'intervention' &&
    data.recipient_id === userId &&
    data.notify === true
  );
}
