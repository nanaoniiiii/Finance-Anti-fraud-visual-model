import { json, parse, readSetting } from './utils.js';
import {
  normalizeNotificationPolicy,
  notificationAllowed,
} from './notification-policy.js';
export async function pendingAlertRoute(env, user) {
  const policy = normalizeNotificationPolicy(
    await readSetting(env, 'notification_policy', {}),
  );
  const candidates = (
    await env.DB.prepare(
      `SELECT i.*,d.name AS device_name,d.platform,d.location,d.is_test,
      (SELECT c.data_json FROM changes c WHERE c.category='event' AND c.entity_id=i.id AND json_extract(c.data_json,'$.notify')=1 ORDER BY c.seq DESC LIMIT 1) AS notification_data
    FROM incidents i JOIN devices d ON d.id=i.device_id
    WHERE i.status<>'resolved' AND EXISTS(SELECT 1 FROM changes c WHERE c.category='event' AND c.entity_id=i.id AND json_extract(c.data_json,'$.notify')=1)
    ORDER BY i.severity DESC,i.received_at DESC LIMIT 100`,
    ).all()
  ).results;
  const alerts = new Map();
  for (const event of candidates) {
    const source = parse(event.notification_data, {}),
      level =
        source.notification_severity ??
        source.severity ??
        event.automatic_severity;
    delete event.notification_data;
    const data = {
      ...event,
      event_id: event.id,
      notify: true,
      personal: false,
      severity: level,
      notification_severity: level,
      notification_scope: policy[`${event.risk_kind}:${level}`],
    };
    if (notificationAllowed(user, { category: 'event', data }))
      alerts.set(event.id, data);
  }
  const personal = (
    await env.DB.prepare(
      `SELECT m.id AS message_id,m.event_id,m.title,m.body,m.area,m.created_at AS message_created_at,s.name AS sender_name,
      i.*,d.name AS device_name,d.platform,d.location,d.is_test FROM personal_messages m JOIN incidents i ON i.id=m.event_id JOIN users s ON s.id=m.sender_id JOIN devices d ON d.id=i.device_id
    WHERE m.recipient_id=? AND m.kind='intervention' AND m.completed_at IS NULL AND i.status<>'resolved'
      AND EXISTS(SELECT 1 FROM changes c WHERE c.category='message' AND c.entity_id=m.id AND c.action='created' AND json_extract(c.data_json,'$.notify')=1)
    ORDER BY m.created_at DESC LIMIT 100`,
    )
      .bind(user.id)
      .all()
  ).results;
  for (const item of personal) {
    if (alerts.get(item.event_id)?.personal) continue;
    alerts.set(item.event_id, {
      ...item,
      id: item.message_id,
      event_id: item.event_id,
      recipient_id: user.id,
      kind: 'intervention',
      personal: true,
      notify: true,
      severity: 3,
    });
  }
  return json({
    alerts: [...alerts.values()]
      .sort(
        (a, b) =>
          b.severity - a.severity || b.received_at.localeCompare(a.received_at),
      )
      .slice(0, 50),
  });
}
