ALTER TABLE devices ADD COLUMN connection_state TEXT NOT NULL DEFAULT 'unknown';
CREATE TABLE IF NOT EXISTS device_status_events(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,state TEXT NOT NULL,occurred_at TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS device_status_time ON device_status_events(occurred_at DESC);
