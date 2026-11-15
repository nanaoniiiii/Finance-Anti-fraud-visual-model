ALTER TABLE incidents ADD COLUMN automatic_severity INTEGER NOT NULL DEFAULT 0;
UPDATE incidents SET automatic_severity=COALESCE((SELECT MAX(CAST(json_extract(data_json,'$.severity') AS INTEGER)) FROM changes WHERE category='event' AND entity_id=incidents.id AND action IN ('created','escalated','resolved','interrupted') AND json_extract(data_json,'$.notify')=1),severity);
UPDATE incidents SET resolved_at=NULL WHERE NOT EXISTS(SELECT 1 FROM incident_updates WHERE incident_id=incidents.id AND action IN ('resolve','record-disposition'));
