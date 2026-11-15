CREATE TABLE staff_contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',area TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX staff_contacts_email ON staff_contacts(email) WHERE email<>'';
CREATE TABLE user_contact_orders(user_id TEXT PRIMARY KEY,keys_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE intervention_contact_deliveries(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,sender_id TEXT NOT NULL,contact_id TEXT NOT NULL,device_id TEXT NOT NULL,event_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,area TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,email_job_id TEXT,UNIQUE(batch_id,contact_id));
CREATE VIEW personal_message_records AS
 SELECT m.*,s.name AS sender_name,r.name AS recipient_name,s.role AS sender_role,r.role AS recipient_role,d.name AS device_name,
  0 AS is_external,NULL AS contact_id,NULL AS contact_email,NULL AS contact_phone,NULL AS delivery_status
 FROM personal_messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.recipient_id LEFT JOIN devices d ON d.id=m.device_id
 UNION ALL
 SELECT x.id,x.batch_id,x.sender_id,NULL,'intervention',x.title,x.body,x.area,x.device_id,x.event_id,x.created_at,x.created_at,NULL,NULL,NULL,'',
  s.name,c.name,s.role,'external',d.name,1,c.id,c.email,c.phone,
  CASE WHEN x.email_job_id IS NULL THEN 'manual_call_required' ELSE COALESCE(j.status,'pending') END
 FROM intervention_contact_deliveries x JOIN users s ON s.id=x.sender_id JOIN staff_contacts c ON c.id=x.contact_id LEFT JOIN devices d ON d.id=x.device_id LEFT JOIN notification_jobs j ON j.id=x.email_job_id;
