ALTER TABLE incidents ADD COLUMN handled_by TEXT;
ALTER TABLE incidents ADD COLUMN handled_by_name TEXT;
ALTER TABLE incidents ADD COLUMN handled_at TEXT;
ALTER TABLE incidents ADD COLUMN disposition TEXT;
CREATE TABLE disposition_confirmations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,incident_id TEXT NOT NULL,not_before INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_at TEXT,claim_nonce TEXT);
CREATE INDEX disposition_confirmations_expiry ON disposition_confirmations(expires_at);
CREATE TABLE event_dispositions(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,user_id TEXT NOT NULL,user_name TEXT NOT NULL,outcome TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,UNIQUE(user_id,request_id));
CREATE INDEX event_dispositions_incident ON event_dispositions(incident_id,created_at DESC);
UPDATE incidents SET
 handled_by_name=(SELECT actor FROM incident_updates WHERE incident_id=incidents.id AND action IN ('ack','resolve') ORDER BY id DESC LIMIT 1),
 handled_at=(SELECT received_at FROM incident_updates WHERE incident_id=incidents.id AND action IN ('ack','resolve') ORDER BY id DESC LIMIT 1)
WHERE EXISTS(SELECT 1 FROM incident_updates WHERE incident_id=incidents.id AND action IN ('ack','resolve'));
