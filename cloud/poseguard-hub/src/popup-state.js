export function popupKey(alert) {
  return alert.personal
    ? 'message:' + alert.id
    : 'event:' +
        (alert.event_id || alert.id) +
        ':' +
        (alert.notification_severity ?? alert.severity);
}
export function postponePendingAlerts(current,alerts,snoozes={},time=Date.now()) {
  const next={...snoozes};
  for(const alert of [current,...alerts].filter(Boolean))next[popupKey(alert)]=time+300000;
  return next;
}
export function choosePendingAlert(
  previous,
  alerts,
  snoozes = {},
  handlingEvent = null,
  time = Date.now(),
) {
  if (handlingEvent) return null;
  const eligible = alerts.filter(
    (alert) =>
      (alert.event_id || alert.id) !== handlingEvent &&
      (snoozes[popupKey(alert)] || 0) <= time,
  );
  if (previous) {
    const matching = eligible.find(
      (alert) => popupKey(alert) === popupKey(previous),
    );
    if (matching) return matching;
  }
  return eligible[0] || null;
}
