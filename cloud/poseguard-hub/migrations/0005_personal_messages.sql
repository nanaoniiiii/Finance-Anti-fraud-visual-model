ALTER TABLE users ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE changes ADD COLUMN audience_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE changes ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX changes_dedupe ON changes(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE personal_message_batches(
  id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(sender_id,request_id)
);
CREATE TABLE personal_messages(
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES personal_message_batches(id),
  sender_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('notice','inspection','intervention')),
  title TEXT NOT NULL, body TEXT NOT NULL, area TEXT NOT NULL DEFAULT '',
  device_id TEXT REFERENCES devices(id), event_id TEXT REFERENCES incidents(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  read_at TEXT, acknowledged_at TEXT, completed_at TEXT, completion_note TEXT NOT NULL DEFAULT '',
  UNIQUE(batch_id,recipient_id)
);
CREATE INDEX personal_messages_inbox ON personal_messages(recipient_id,created_at DESC,id DESC);
CREATE INDEX personal_messages_sender ON personal_messages(sender_id,created_at DESC,id DESC);
CREATE INDEX personal_messages_unread ON personal_messages(recipient_id,read_at);
