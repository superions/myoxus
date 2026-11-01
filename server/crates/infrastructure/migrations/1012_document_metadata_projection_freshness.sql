-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The projection cache version must advance for every fact selected from docs,
-- including content-owned system timestamps and attribution.
CREATE OR REPLACE FUNCTION docs_touch_metadata_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.updated_at IS DISTINCT FROM OLD.updated_at OR
    NEW.updated_by IS DISTINCT FROM OLD.updated_by OR
    NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR
    NEW.status_id IS DISTINCT FROM OLD.status_id OR
    NEW.status_source IS DISTINCT FROM OLD.status_source OR
    NEW.document_type_id IS DISTINCT FROM OLD.document_type_id OR
    NEW.document_type_source IS DISTINCT FROM OLD.document_type_source OR
    NEW.classification_id IS DISTINCT FROM OLD.classification_id OR
    NEW.classification_source IS DISTINCT FROM OLD.classification_source OR
    NEW.retention_policy_id IS DISTINCT FROM OLD.retention_policy_id OR
    NEW.retention_policy_source IS DISTINCT FROM OLD.retention_policy_source OR
    NEW.language_id IS DISTINCT FROM OLD.language_id OR
    NEW.language_source IS DISTINCT FROM OLD.language_source OR
    NEW.responsible_user_id IS DISTINCT FROM OLD.responsible_user_id OR
    NEW.responsible_source IS DISTINCT FROM OLD.responsible_source OR
    NEW.document_number IS DISTINCT FROM OLD.document_number OR
    NEW.review_due_at IS DISTINCT FROM OLD.review_due_at OR
    NEW.valid_from IS DISTINCT FROM OLD.valid_from OR
    NEW.valid_until IS DISTINCT FROM OLD.valid_until OR
    NEW.journal_date IS DISTINCT FROM OLD.journal_date OR
    NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR
    NEW.dirty_since_current_version IS DISTINCT FROM OLD.dirty_since_current_version OR
    NEW.version_display_mode IS DISTINCT FROM OLD.version_display_mode OR
    NEW.last_versioned_at IS DISTINCT FROM OLD.last_versioned_at
  THEN
    NEW.metadata_revision = OLD.metadata_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER trg_docs_touch_metadata_revision ON docs;
CREATE TRIGGER trg_docs_touch_metadata_revision
BEFORE UPDATE OF
  workspace_id, created_at, created_by, updated_at, updated_by, deleted_at,
  status_id, status_source,
  document_type_id, document_type_source,
  classification_id, classification_source,
  retention_policy_id, retention_policy_source,
  language_id, language_source,
  responsible_user_id, responsible_source,
  document_number, review_due_at, valid_from, valid_until, journal_date,
  current_version_id, dirty_since_current_version, version_display_mode,
  last_versioned_at
ON docs FOR EACH ROW EXECUTE FUNCTION docs_touch_metadata_revision();

-- The current version label and sequence are rendered as a reference value.
CREATE FUNCTION document_metadata_touch_version_reference_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.label IS DISTINCT FROM OLD.label OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
    UPDATE docs
    SET metadata_revision = metadata_revision + 1,
        metadata_updated_at = now()
    WHERE current_version_id = NEW.id
      AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_document_version_metadata_revision
AFTER UPDATE OF label, version_no ON document_version
FOR EACH ROW EXECUTE FUNCTION document_metadata_touch_version_reference_revision();
