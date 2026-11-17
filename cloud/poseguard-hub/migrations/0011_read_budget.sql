-- Bound recurring dashboard reads independently of notification history size.
CREATE TABLE IF NOT EXISTS notification_job_counts(status TEXT PRIMARY KEY,total INTEGER NOT NULL DEFAULT 0 CHECK(total>=0));
INSERT INTO notification_job_counts(status,total) SELECT status,COUNT(*) FROM notification_jobs GROUP BY status
ON CONFLICT(status) DO UPDATE SET total=excluded.total;
CREATE TRIGGER IF NOT EXISTS notification_counts_insert AFTER INSERT ON notification_jobs BEGIN
  INSERT INTO notification_job_counts(status,total) VALUES(NEW.status,1) ON CONFLICT(status) DO UPDATE SET total=total+1;
END;
CREATE TRIGGER IF NOT EXISTS notification_counts_delete AFTER DELETE ON notification_jobs BEGIN
  UPDATE notification_job_counts SET total=total-1 WHERE status=OLD.status;
END;
CREATE TRIGGER IF NOT EXISTS notification_counts_update AFTER UPDATE OF status ON notification_jobs WHEN OLD.status<>NEW.status BEGIN
  UPDATE notification_job_counts SET total=total-1 WHERE status=OLD.status;
  INSERT INTO notification_job_counts(status,total) VALUES(NEW.status,1) ON CONFLICT(status) DO UPDATE SET total=total+1;
END;
CREATE INDEX IF NOT EXISTS incidents_received_status ON incidents(received_at,status);
CREATE INDEX IF NOT EXISTS incident_updates_incident ON incident_updates(incident_id,id);
CREATE INDEX IF NOT EXISTS device_commands_pending ON device_commands(device_id,acknowledged_at,created_at);
CREATE INDEX IF NOT EXISTS changes_created ON changes(created_at);
CREATE INDEX IF NOT EXISTS changes_category_latest ON changes(category,seq DESC);
CREATE INDEX IF NOT EXISTS snapshots_created ON snapshots(created_at);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS enrollments_expiry ON enrollments(expires_at);
CREATE INDEX IF NOT EXISTS notification_jobs_lease ON notification_jobs(status,lease_until);
CREATE INDEX IF NOT EXISTS notification_jobs_created ON notification_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS notification_jobs_incident ON notification_jobs(incident_id,created_at DESC);
