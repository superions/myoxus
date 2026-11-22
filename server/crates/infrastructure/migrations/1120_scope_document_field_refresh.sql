-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The relation rename in 1108 preserved the workspace trigger, but its
-- TG_TABLE_NAME comparison no longer matched. Bind the scope at registration:
-- inventory revisions neither change field values nor invalidate search.
CREATE OR REPLACE FUNCTION document_field_search_catalog_refresh() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  CASE TG_ARGV[0]
    WHEN 'workspace' THEN
      IF TG_OP <> 'INSERT' AND OLD.epoch_name = 'defaults' THEN
        PERFORM enqueue_document_field_search_refresh(OLD.workspace_id, NULL, NULL);
      END IF;
      IF TG_OP <> 'DELETE' AND NEW.epoch_name = 'defaults' AND (
        TG_OP = 'INSERT' OR OLD.epoch_name <> 'defaults' OR OLD.workspace_id <> NEW.workspace_id
      ) THEN
        PERFORM enqueue_document_field_search_refresh(NEW.workspace_id, NULL, NULL);
      END IF;
    WHEN 'global' THEN
      IF (TG_OP <> 'INSERT' AND OLD.epoch_name IN ('field_definition', 'reference_values'))
        OR (TG_OP <> 'DELETE' AND NEW.epoch_name IN ('field_definition', 'reference_values')) THEN
        PERFORM enqueue_document_field_search_refresh(NULL, NULL, NULL);
      END IF;
    WHEN 'organization' THEN
      -- Effective organization metadata can be inherited across workspaces.
      PERFORM enqueue_document_field_search_refresh(NULL, NULL, NULL);
    ELSE
      RAISE EXCEPTION 'Unrecognized document field search refresh scope';
  END CASE;
  RETURN NULL; -- AFTER trigger
END;
$$;

CREATE OR REPLACE TRIGGER document_field_search_workspace_epoch
AFTER INSERT OR UPDATE OR DELETE ON workspace_revisions FOR EACH ROW
EXECUTE FUNCTION document_field_search_catalog_refresh('workspace');
CREATE OR REPLACE TRIGGER document_field_search_global_epoch
AFTER INSERT OR UPDATE OR DELETE ON document_metadata_global_epoch FOR EACH ROW
EXECUTE FUNCTION document_field_search_catalog_refresh('global');
CREATE OR REPLACE TRIGGER document_field_search_organization_epoch
AFTER INSERT OR UPDATE OR DELETE ON organization_document_metadata_epoch FOR EACH ROW
EXECUTE FUNCTION document_field_search_catalog_refresh('organization');

-- Bound the consumer's same-target claim even while draining a pre-fix backlog.
CREATE INDEX idx_outbox_pending_field_refresh_target ON outbox_events
  ((payload->>'workspaceId'), (payload->>'docId'), id)
  WHERE processed_at IS NULL AND event_type = 'doc_updated'
    AND payload @> '{"fieldContextChanged":true}';
