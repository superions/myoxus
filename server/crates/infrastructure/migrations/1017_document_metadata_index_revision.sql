-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE workspace_document_metadata_index_revision (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION bump_workspace_document_metadata_index_revision(p_workspace_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = p_workspace_id) THEN
    RETURN;
  END IF;
  INSERT INTO workspace_document_metadata_index_revision (workspace_id, revision, updated_at)
  VALUES (p_workspace_id, 1, now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET revision = workspace_document_metadata_index_revision.revision + 1,
        updated_at = now();
END;
$$;

CREATE FUNCTION document_metadata_index_touch_docs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM bump_workspace_document_metadata_index_revision(NEW.workspace_id);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM bump_workspace_document_metadata_index_revision(OLD.workspace_id);
    RETURN OLD;
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    PERFORM bump_workspace_document_metadata_index_revision(OLD.workspace_id);
  END IF;
  PERFORM bump_workspace_document_metadata_index_revision(NEW.workspace_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_docs_document_metadata_index_membership
AFTER INSERT OR DELETE ON docs
FOR EACH ROW EXECUTE FUNCTION document_metadata_index_touch_docs();

CREATE TRIGGER trg_docs_document_metadata_index_facts
AFTER UPDATE OF
  workspace_id, external_id, created_by, updated_by, journal_date, deleted_at,
  status_id, document_type_id, current_version_id,
  dirty_since_current_version, review_due_at, valid_until, classification_id
ON docs FOR EACH ROW
WHEN (
  OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR
  OLD.external_id IS DISTINCT FROM NEW.external_id OR
  OLD.created_by IS DISTINCT FROM NEW.created_by OR
  OLD.updated_by IS DISTINCT FROM NEW.updated_by OR
  OLD.journal_date IS DISTINCT FROM NEW.journal_date OR
  OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR
  OLD.status_id IS DISTINCT FROM NEW.status_id OR
  OLD.document_type_id IS DISTINCT FROM NEW.document_type_id OR
  OLD.current_version_id IS DISTINCT FROM NEW.current_version_id OR
  OLD.dirty_since_current_version IS DISTINCT FROM NEW.dirty_since_current_version OR
  OLD.review_due_at IS DISTINCT FROM NEW.review_due_at OR
  OLD.valid_until IS DISTINCT FROM NEW.valid_until OR
  OLD.classification_id IS DISTINCT FROM NEW.classification_id
)
EXECUTE FUNCTION document_metadata_index_touch_docs();

CREATE FUNCTION document_metadata_index_touch_subsystem() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_doc_id UUID;
  target_workspace_id UUID;
BEGIN
  target_doc_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.doc_id ELSE NEW.doc_id END;
  SELECT workspace_id INTO target_workspace_id FROM docs WHERE id = target_doc_id;
  PERFORM bump_workspace_document_metadata_index_revision(target_workspace_id);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_document_template_state_document_metadata_index_membership
AFTER INSERT OR DELETE ON document_template_state
FOR EACH ROW EXECUTE FUNCTION document_metadata_index_touch_subsystem();

CREATE TRIGGER trg_document_template_state_document_metadata_index_facts
AFTER UPDATE OF state, metadata ON document_template_state
FOR EACH ROW
WHEN (
  OLD.state IS DISTINCT FROM NEW.state OR
  OLD.metadata ->> 'origin' IS DISTINCT FROM NEW.metadata ->> 'origin'
)
EXECUTE FUNCTION document_metadata_index_touch_subsystem();

CREATE TRIGGER trg_document_presentation_state_document_metadata_index_membership
AFTER INSERT OR DELETE ON document_presentation_state
FOR EACH ROW EXECUTE FUNCTION document_metadata_index_touch_subsystem();

CREATE TRIGGER trg_document_presentation_state_document_metadata_index_facts
AFTER UPDATE OF primary_mode, page_width, edgeless_color_theme ON document_presentation_state
FOR EACH ROW
WHEN (
  OLD.primary_mode IS DISTINCT FROM NEW.primary_mode OR
  OLD.page_width IS DISTINCT FROM NEW.page_width OR
  OLD.edgeless_color_theme IS DISTINCT FROM NEW.edgeless_color_theme
)
EXECUTE FUNCTION document_metadata_index_touch_subsystem();

CREATE TRIGGER trg_document_integration_state_document_metadata_index_membership
AFTER INSERT OR DELETE ON document_integration_state
FOR EACH ROW EXECUTE FUNCTION document_metadata_index_touch_subsystem();

CREATE TRIGGER trg_document_integration_state_document_metadata_index_facts
AFTER UPDATE OF integration_type ON document_integration_state
FOR EACH ROW
WHEN (OLD.integration_type IS DISTINCT FROM NEW.integration_type)
EXECUTE FUNCTION document_metadata_index_touch_subsystem();

CREATE FUNCTION document_metadata_index_touch_workspace_settings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_workspace_document_metadata_index_revision(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_document_workspace_settings_document_metadata_index_membership
AFTER INSERT OR DELETE ON document_workspace_settings
FOR EACH ROW EXECUTE FUNCTION document_metadata_index_touch_workspace_settings();

CREATE TRIGGER trg_document_workspace_settings_document_metadata_index_facts
AFTER UPDATE OF status_schema_id, default_document_type_id, default_classification_id
ON document_workspace_settings
FOR EACH ROW
WHEN (
  OLD.status_schema_id IS DISTINCT FROM NEW.status_schema_id OR
  OLD.default_document_type_id IS DISTINCT FROM NEW.default_document_type_id OR
  OLD.default_classification_id IS DISTINCT FROM NEW.default_classification_id
)
EXECUTE FUNCTION document_metadata_index_touch_workspace_settings();

-- Only reference data read by the list projection participates in this epoch;
-- unrelated metadata catalog edits must not invalidate every workspace list.
ALTER TABLE document_metadata_global_epoch
  DROP CONSTRAINT document_metadata_global_epoch_name_check;
ALTER TABLE document_metadata_global_epoch
  ADD CONSTRAINT document_metadata_global_epoch_name_check
  CHECK (epoch_name IN ('field_definition', 'reference_values', 'list_index'));
INSERT INTO document_metadata_global_epoch (epoch_name, revision)
VALUES ('list_index', 0);

CREATE TRIGGER trg_document_status_schema_list_index_insert_epoch
AFTER INSERT ON document_status_schema
FOR EACH ROW WHEN (NEW.is_active)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_status_schema_list_index_delete_epoch
AFTER DELETE ON document_status_schema
FOR EACH ROW WHEN (OLD.is_active)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_status_schema_list_index_facts_epoch
AFTER UPDATE OF key, is_active ON document_status_schema
FOR EACH ROW
WHEN (
  (OLD.is_active OR NEW.is_active) AND
  (OLD.key IS DISTINCT FROM NEW.key OR OLD.is_active IS DISTINCT FROM NEW.is_active)
)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_status_value_list_index_insert_epoch
AFTER INSERT ON document_status_value
FOR EACH ROW WHEN (NEW.is_active)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_status_value_list_index_delete_epoch
AFTER DELETE ON document_status_value
FOR EACH ROW WHEN (OLD.is_active)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_status_value_list_index_facts_epoch
AFTER UPDATE OF schema_id, key, sort_order, is_active ON document_status_value
FOR EACH ROW
WHEN (
  (OLD.is_active OR NEW.is_active) AND
  (
    OLD.schema_id IS DISTINCT FROM NEW.schema_id OR
    OLD.key IS DISTINCT FROM NEW.key OR
    OLD.sort_order IS DISTINCT FROM NEW.sort_order OR
    OLD.is_active IS DISTINCT FROM NEW.is_active
  )
)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_type_status_default_list_index_membership_epoch
AFTER INSERT OR DELETE ON document_type_status_default
FOR EACH ROW EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');

CREATE TRIGGER trg_document_type_status_default_list_index_facts_epoch
AFTER UPDATE OF document_type_id, status_schema_id, status_id ON document_type_status_default
FOR EACH ROW
WHEN (
  OLD.document_type_id IS DISTINCT FROM NEW.document_type_id OR
  OLD.status_schema_id IS DISTINCT FROM NEW.status_schema_id OR
  OLD.status_id IS DISTINCT FROM NEW.status_id
)
EXECUTE FUNCTION document_metadata_bump_global_epoch_trigger('list_index');
