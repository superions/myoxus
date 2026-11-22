-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Preserve the metadata returned by the former context-file fallback.
UPDATE copilot_context_items i SET metadata =
  jsonb_strip_nulls(jsonb_build_object('name', f.file_name, 'mimeType', f.mime_type,
    'size', f.size, 'blobId', f.blob_id)) || i.metadata
FROM copilot_contexts c JOIN ai_workspace_files f ON f.workspace_id = c.workspace_id
WHERE i.context_id = c.id AND i.item_type = 'file' AND i.item_ref = f.file_id;
DROP TABLE ai_workspace_files;

-- The blob owns the provider upload ID. Multiple active IDs or missing blob
-- metadata require reconciliation before the upgrade can safely resume.
DO $$ BEGIN
  IF EXISTS (
    SELECT FROM multipart_uploads u LEFT JOIN blobs b USING (workspace_id,key)
    WHERE u.status = 'active' AND (b.key IS NULL OR b.deleted_at IS NOT NULL OR
      (b.upload_id IS DISTINCT FROM u.upload_id AND
       (b.upload_id IS NOT NULL OR b.status NOT IN ('pending','uploading'))))
  ) OR EXISTS (
    SELECT FROM multipart_uploads WHERE status='active' GROUP BY workspace_id,key
    HAVING count(DISTINCT upload_id)>1
  ) THEN RAISE EXCEPTION 'Reconcile conflicting legacy multipart uploads with their workspace blobs before upgrading'; END IF;
END $$;
UPDATE blobs b SET upload_id=u.upload_id,status='uploading'
FROM multipart_uploads u WHERE u.status='active' AND b.workspace_id=u.workspace_id
  AND b.key=u.key AND b.status IN ('pending','uploading') AND b.upload_id IS NULL;
DROP TABLE multipart_uploads;

-- Use the audit event and sensitivity contract in effect at this migration.
WITH legacy AS (
  SELECT c.*, config_key IN ('calendar.caldav', 'calendar.google', 'captcha.hmac_key', 'copilot.embedding.api_key', 'copilot.exa', 'copilot.providers', 'copilot.unsplash', 'crypto.private_key', 'database.url', 'indexer.provider_api_key', 'indexer.provider_password', 'indexer.provider_username', 'mail.fallback_smtp.password', 'mail.fallback_smtp.username', 'mail.smtp_pass', 'mail.smtp_user', 'oauth.providers.apple', 'oauth.providers.github', 'oauth.providers.google', 'oauth.providers.oidc', 'redis.url', 'storage.access_key', 'storage.secret_key', 'transcription.api_key') AS sensitive
  FROM config_changelog c
), events AS (
  SELECT config_key, changed_by, changed_at, id,
    CASE WHEN sensitive AND old_value IS NOT NULL THEN to_jsonb('***REDACTED***'::text) ELSE old_value END AS old_value,
    CASE WHEN sensitive THEN to_jsonb('***REDACTED***'::text) ELSE new_value END AS new_value
  FROM legacy
)
INSERT INTO admin_audit_log(event_key,category,target_type,target_id,target_label,old_value,new_value,actor_user_id,created_at,metadata)
SELECT 'config.'||config_key||'.update','config','config',config_key,config_key,
  e.old_value,e.new_value,changed_by,changed_at,jsonb_build_object('legacyChangelogId',e.id)
FROM events e WHERE NOT EXISTS (
  SELECT FROM admin_audit_log a WHERE a.category='config' AND a.target_id=e.config_key
    AND a.created_at=e.changed_at AND a.actor_user_id IS NOT DISTINCT FROM e.changed_by
    AND a.old_value IS NOT DISTINCT FROM e.old_value AND a.new_value IS NOT DISTINCT FROM e.new_value
);
DROP TABLE config_changelog;
