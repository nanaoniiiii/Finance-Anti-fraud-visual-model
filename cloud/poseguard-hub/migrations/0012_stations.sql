CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO workspaces(id, name, created_at) VALUES ('main', '主工作区', '2026-11-17T00:00:00.000Z');
CREATE TABLE workspace_access (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, user_id)
);
CREATE INDEX workspace_access_user ON workspace_access(user_id, workspace_id);
CREATE TABLE workspace_relays (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen TEXT,
  revoked_at TEXT
);
CREATE INDEX workspace_relays_workspace ON workspace_relays(workspace_id, revoked_at);
CREATE TABLE workspace_records (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  relay_id TEXT NOT NULL REFERENCES workspace_relays(id),
  kind TEXT NOT NULL CHECK(kind IN ('event','device','staff')),
  entity_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  timestamp TEXT,
  severity INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id, relay_id, kind, entity_id)
);
CREATE INDEX workspace_records_timeline
  ON workspace_records(workspace_id, kind, timestamp DESC, relay_id, entity_id);
CREATE INDEX incidents_occurred_at ON incidents(occurred_at);

CREATE TABLE station_runtime (
  id INTEGER PRIMARY KEY CHECK(id=1),
  archive_enabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO station_runtime(id, archive_enabled) VALUES (1, 0);
CREATE TABLE station_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('event','device','staff')),
  entity_id TEXT NOT NULL,
  UNIQUE(kind, entity_id)
);
CREATE TRIGGER station_incident_insert AFTER INSERT ON incidents
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('event', NEW.id);
END;
CREATE TRIGGER station_incident_update AFTER UPDATE ON incidents
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('event', NEW.id);
END;
CREATE TRIGGER station_incident_history AFTER INSERT ON incident_updates
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('event', NEW.incident_id);
END;
CREATE TRIGGER station_snapshot_insert AFTER INSERT ON snapshots
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('event', NEW.incident_id);
END;
CREATE TRIGGER station_device_insert AFTER INSERT ON devices
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('device', NEW.id);
END;
CREATE TRIGGER station_device_update AFTER UPDATE OF name,location,last_seen,health_json,revoked_at,config_json ON devices
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1 AND (
  NEW.name IS NOT OLD.name OR NEW.location IS NOT OLD.location OR NEW.revoked_at IS NOT OLD.revoked_at
  OR NEW.config_json IS NOT OLD.config_json
  OR substr(NEW.last_seen,1,16) IS NOT substr(OLD.last_seen,1,16)
)
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('device', NEW.id);
END;
CREATE TRIGGER station_staff_insert AFTER INSERT ON users
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('staff', NEW.id);
END;
CREATE TRIGGER station_staff_update AFTER UPDATE OF name,role ON users
WHEN (SELECT archive_enabled FROM station_runtime WHERE id=1)=1
BEGIN
  INSERT OR REPLACE INTO station_outbox(kind, entity_id) VALUES ('staff', NEW.id);
END;

CREATE TABLE station_signals (
  device_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  code TEXT NOT NULL,
  confidence REAL NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, signal_id, code)
);
CREATE INDEX station_signals_recent ON station_signals(scope, captured_at);
CREATE TABLE station_cases (
  scope TEXT PRIMARY KEY,
  case_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  last_signal_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  evidence_key TEXT NOT NULL DEFAULT ''
);
ALTER TABLE incidents ADD COLUMN risk_score INTEGER;
ALTER TABLE incidents ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
