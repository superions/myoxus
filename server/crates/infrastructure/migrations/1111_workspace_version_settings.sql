-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A workspace can configure either group independently; each has its own
-- timestamp and actor. A version-only row has no metadata settings timestamp.
ALTER TABLE document_workspace_settings
  ALTER COLUMN updated_at DROP NOT NULL,
  ADD COLUMN enabled boolean,
  ADD COLUMN auto_version_on text[],
  ADD COLUMN retention_count integer CHECK (retention_count BETWEEN 1 AND 50),
  ADD COLUMN edit_capture_enabled boolean,
  ADD COLUMN edit_capture_interval_ms bigint CHECK (edit_capture_interval_ms BETWEEN 1 AND 86400000),
  ADD COLUMN versioning_updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN versioning_updated_at timestamptz;

-- Versioning writes must not rematerialize documents or advance metadata cursors.
DROP TRIGGER trg_document_workspace_settings_metadata_epoch ON document_workspace_settings;
CREATE TRIGGER trg_document_workspace_settings_metadata_epoch
AFTER INSERT OR UPDATE OF status_schema_id, default_status_id, version_policy_id,
  default_document_type_id, default_classification_id, default_retention_policy_id,
  default_language_id, default_responsible_user_id, updated_by, updated_at, metadata_revision
ON document_workspace_settings FOR EACH ROW WHEN (NEW.updated_at IS NOT NULL)
EXECUTE FUNCTION document_metadata_bump_workspace_epoch_trigger('defaults');
CREATE TRIGGER trg_document_workspace_settings_deleted_epoch
AFTER DELETE ON document_workspace_settings FOR EACH ROW WHEN (OLD.updated_at IS NOT NULL)
EXECUTE FUNCTION document_metadata_bump_workspace_epoch_trigger('defaults');

DROP TRIGGER trg_document_metadata_workspace_settings_rematerialize ON document_workspace_settings;
CREATE TRIGGER trg_document_metadata_workspace_settings_rematerialize
AFTER INSERT OR UPDATE OF status_schema_id, default_status_id, default_document_type_id,
  default_classification_id, default_retention_policy_id, default_language_id, default_responsible_user_id, updated_by
ON document_workspace_settings FOR EACH ROW WHEN (NEW.updated_at IS NOT NULL)
EXECUTE FUNCTION document_metadata_rematerialize_workspace_settings_trigger();

DROP TRIGGER trg_document_workspace_settings_document_metadata_index_membership ON document_workspace_settings;
CREATE TRIGGER trg_document_workspace_settings_document_metadata_index_insert
AFTER INSERT ON document_workspace_settings FOR EACH ROW WHEN (NEW.updated_at IS NOT NULL)
EXECUTE FUNCTION document_metadata_index_touch_workspace_settings();
CREATE TRIGGER trg_document_workspace_settings_document_metadata_index_delete
AFTER DELETE ON document_workspace_settings FOR EACH ROW WHEN (OLD.updated_at IS NOT NULL)
EXECUTE FUNCTION document_metadata_index_touch_workspace_settings();

INSERT INTO document_workspace_settings(workspace_id,updated_at,enabled,auto_version_on,retention_count,
  edit_capture_enabled,edit_capture_interval_ms,versioning_updated_by,versioning_updated_at)
SELECT workspace_id,NULL,enabled,auto_version_on,retention_count,
  edit_capture_enabled,edit_capture_interval_ms,updated_by,updated_at FROM document_versioning_workspace_settings
ON CONFLICT (workspace_id) DO UPDATE SET
  enabled=EXCLUDED.enabled, auto_version_on=EXCLUDED.auto_version_on, retention_count=EXCLUDED.retention_count,
  edit_capture_enabled=EXCLUDED.edit_capture_enabled, edit_capture_interval_ms=EXCLUDED.edit_capture_interval_ms,
  versioning_updated_by=EXCLUDED.versioning_updated_by, versioning_updated_at=EXCLUDED.versioning_updated_at;
DROP TABLE document_versioning_workspace_settings;
