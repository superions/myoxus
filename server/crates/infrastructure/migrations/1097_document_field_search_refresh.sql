-- SPDX-License-Identifier: AGPL-3.0-or-later
-- This is a dependency bit on the existing derived search row, not canonical
-- field data or a separate field registry. Only complete native indexing sets it.
ALTER TABLE search_content ADD COLUMN has_document_fields BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE search_content ADD COLUMN field_source_revision BIGINT CHECK (field_source_revision>=0);

CREATE FUNCTION enqueue_document_field_search_refresh(
  p_workspace_id UUID, p_doc_id UUID, p_user_id UUID
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE enqueued BIGINT;
BEGIN
  INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
    SELECT gen_random_uuid(),'doc',d.id::text,'doc_updated',
      jsonb_build_object('workspaceId',d.workspace_id,'docId',d.id,'fieldContextChanged',true)
    FROM docs d LEFT JOIN search_content s ON d.workspace_id=s.workspace_id AND d.id=s.doc_id
    JOIN workspaces w ON w.id=d.workspace_id AND w.lifecycle_state='active' AND w.deleted_at IS NULL
    LEFT JOIN page_registration_evidence e ON e.workspace_id=d.workspace_id AND e.doc_id=d.id
    WHERE d.workspace_id IS NOT NULL
      AND d.userspace_owner_id IS NULL AND d.deleted_at IS NULL AND NOT d.is_workspace_root
      AND d.id<>d.workspace_id AND d.external_id NOT LIKE 'db$%'
      AND d.external_id NOT LIKE 'userdata$%' AND COALESCE(e.state,'legacy')<>'deleted'
      AND (p_workspace_id IS NULL OR d.workspace_id=p_workspace_id)
      AND (p_doc_id IS NULL OR d.id=p_doc_id)
      AND (p_user_id IS NULL OR p_user_id IN (d.created_by,d.updated_by,d.responsible_user_id))
      -- A field-free bit is meaningful only at its exact native revision. A
      -- first/new field can race indexing and a metadata commit; suppressing
      -- unknown or stale dependencies would lose that committed invalidation.
      AND (s.has_document_fields OR s.field_source_revision IS NULL OR s.field_source_revision <> GREATEST(
        COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id=d.workspace_id AND doc_id=d.id),0),
        COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=d.workspace_id AND doc_id=d.id),0)));
  -- Do not coalesce against an unprocessed event: a consumer can already have
  -- enqueued/read its old context while this transaction is still uncommitted.
  GET DIAGNOSTICS enqueued = ROW_COUNT;
  RETURN enqueued;
END;
$$;

CREATE FUNCTION document_field_search_document_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_document_field_search_refresh(NEW.workspace_id,NEW.id,NULL);
  RETURN NEW;
END;
$$;
-- Content-owned title/timestamps already use the native-content search event.
-- This hook belongs only to the canonical business-metadata invalidation owner.
CREATE TRIGGER document_field_search_metadata_refresh
  AFTER UPDATE OF metadata_updated_at ON docs FOR EACH ROW
  WHEN (OLD.metadata_updated_at IS DISTINCT FROM NEW.metadata_updated_at)
  EXECUTE FUNCTION document_field_search_document_refresh();

CREATE FUNCTION document_field_search_identity_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- BEFORE deletion retains target IDs before FK actions remove attribution.
    PERFORM enqueue_document_field_search_refresh(NULL,NULL,OLD.id);
    RETURN OLD;
  END IF;
  PERFORM enqueue_document_field_search_refresh(NULL,NULL,NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_field_search_profile_refresh AFTER UPDATE OF name,email,status ON users
  FOR EACH ROW WHEN (ROW(OLD.name,OLD.email,OLD.status) IS DISTINCT FROM ROW(NEW.name,NEW.email,NEW.status))
  EXECUTE FUNCTION document_field_search_identity_refresh();
CREATE TRIGGER document_field_search_identity_delete BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION document_field_search_identity_refresh();

CREATE FUNCTION document_field_search_catalog_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='document_metadata_global_epoch' THEN
    IF TG_OP='DELETE' THEN
      IF OLD.epoch_name NOT IN ('field_definition','reference_values') THEN RETURN OLD; END IF;
    ELSE
      IF NEW.epoch_name NOT IN ('field_definition','reference_values') THEN RETURN NEW; END IF;
    END IF;
  END IF;
  -- The existing effective-organization resolver has inherited and fallback
  -- ownership. Conservatively refresh field-bearing rows rather than inventing
  -- a second organization/default resolution model in this invalidation hook.
  IF TG_TABLE_NAME='workspace_document_metadata_epoch' THEN
    IF TG_OP='DELETE' THEN
      PERFORM enqueue_document_field_search_refresh(OLD.workspace_id,NULL,NULL);
    ELSE
      PERFORM enqueue_document_field_search_refresh(NEW.workspace_id,NULL,NULL);
    END IF;
  ELSE
    PERFORM enqueue_document_field_search_refresh(NULL,NULL,NULL);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_field_search_global_epoch AFTER INSERT OR UPDATE OR DELETE
  ON document_metadata_global_epoch FOR EACH ROW
  EXECUTE FUNCTION document_field_search_catalog_refresh();
CREATE TRIGGER document_field_search_organization_epoch AFTER INSERT OR UPDATE OR DELETE
  ON organization_document_metadata_epoch FOR EACH ROW
  EXECUTE FUNCTION document_field_search_catalog_refresh();
CREATE TRIGGER document_field_search_workspace_epoch AFTER INSERT OR UPDATE OR DELETE
  ON workspace_document_metadata_epoch FOR EACH ROW
  EXECUTE FUNCTION document_field_search_catalog_refresh();

CREATE FUNCTION document_field_search_format_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.id=OLD.id AND NEW.value IS NOT DISTINCT FROM OLD.value THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.id='i18n.default_locale' THEN PERFORM enqueue_document_field_search_refresh(NULL,NULL,NULL); END IF;
    RETURN OLD;
  END IF;
  IF NEW.id='i18n.default_locale' THEN PERFORM enqueue_document_field_search_refresh(NULL,NULL,NULL); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_field_search_format_refresh AFTER INSERT OR UPDATE OR DELETE
  ON app_configs FOR EACH ROW EXECUTE FUNCTION document_field_search_format_refresh();
