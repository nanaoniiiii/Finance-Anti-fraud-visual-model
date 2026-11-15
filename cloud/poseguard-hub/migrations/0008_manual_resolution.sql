ALTER TABLE incidents ADD COLUMN signal_ended_at TEXT;
ALTER TABLE native_receivers ADD COLUMN supports_clear INTEGER NOT NULL DEFAULT 0;
CREATE INDEX changes_entity_category ON changes(category,entity_id,seq DESC);
CREATE INDEX personal_messages_event_recipient ON personal_messages(event_id,recipient_id,kind);
UPDATE incidents SET signal_ended_at=COALESCE(resolved_at,(SELECT MAX(received_at) FROM incident_updates WHERE incident_id=incidents.id AND action IN ('resolved','interrupted')))
WHERE EXISTS(SELECT 1 FROM incident_updates WHERE incident_id=incidents.id AND action IN ('resolved','interrupted'));
UPDATE incidents SET status=CASE WHEN staff_requested_at IS NOT NULL THEN 'intervention_requested' WHEN acknowledged_at IS NOT NULL THEN 'acknowledged' ELSE 'open' END,resolved_at=NULL
WHERE status='resolved' AND NOT EXISTS(SELECT 1 FROM incident_updates WHERE incident_id=incidents.id AND action IN ('resolve','record-disposition'));
