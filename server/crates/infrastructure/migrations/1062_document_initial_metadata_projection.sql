-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One active defaults owner for native insert and read-only prepared projection.
-- The established trigger delegates to the unchanged record transformation;
-- previewing this function creates no document, audit row or path ownership.
CREATE FUNCTION public.document_metadata_initial_defaults(p_document public.docs)
RETURNS public.docs LANGUAGE plpgsql AS $$
DECLARE
  NEW public.docs := p_document;
  ws_defaults document_workspace_settings%ROWTYPE;
  org_defaults organization_document_settings%ROWTYPE;
  effective_org_id UUID;
  effective_type_id UUID;
  effective_schema_id UUID;
  type_status_id UUID;
  fallback_status_id UUID;
  fallback_language_id UUID;
  fallback_responsible_id UUID;
  valid_ws_responsible_id UUID;
  valid_org_responsible_id UUID;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO ws_defaults
  FROM document_workspace_settings
  WHERE workspace_id = NEW.workspace_id;

  SELECT document_metadata_effective_organization_id(NEW.workspace_id)
  INTO effective_org_id;

  SELECT * INTO org_defaults
  FROM organization_document_settings
  WHERE organization_id = effective_org_id
  LIMIT 1;

  effective_type_id := COALESCE(NEW.document_type_id, ws_defaults.default_document_type_id, org_defaults.default_document_type_id);
  effective_schema_id := COALESCE(ws_defaults.status_schema_id, org_defaults.status_schema_id);

  IF effective_type_id IS NOT NULL AND effective_schema_id IS NOT NULL THEN
    SELECT status_id INTO type_status_id
    FROM document_type_status_default
    WHERE document_type_id = effective_type_id
      AND status_schema_id = effective_schema_id
    LIMIT 1;
  END IF;

  SELECT v.id INTO fallback_status_id
  FROM document_status_value v
  JOIN document_status_schema s ON s.id = v.schema_id
  WHERE v.is_active
    AND (s.key = 'simple' OR NOT EXISTS (SELECT 1 FROM document_status_schema WHERE key = 'simple' AND is_active))
  ORDER BY CASE WHEN s.key = 'simple' THEN 0 ELSE 1 END, v.sort_order, v.key
  LIMIT 1;

  SELECT id INTO fallback_language_id
  FROM language_definition
  WHERE key = 'de' AND is_active
  LIMIT 1;

  valid_ws_responsible_id := CASE
    WHEN document_metadata_is_valid_responsible_user(NEW.workspace_id, ws_defaults.default_responsible_user_id)
    THEN ws_defaults.default_responsible_user_id
    ELSE NULL
  END;
  valid_org_responsible_id := CASE
    WHEN document_metadata_is_valid_responsible_user(NEW.workspace_id, org_defaults.default_responsible_user_id)
    THEN org_defaults.default_responsible_user_id
    ELSE NULL
  END;

  SELECT document_metadata_resolve_responsible_fallback(NEW.workspace_id, NEW.created_by)
  INTO fallback_responsible_id;

  IF NEW.status_id IS NULL THEN
    NEW.status_id := COALESCE(ws_defaults.default_status_id, type_status_id, org_defaults.default_status_id, fallback_status_id);
    NEW.status_source := CASE
      WHEN ws_defaults.default_status_id IS NOT NULL OR type_status_id IS NOT NULL THEN 'workspace'
      WHEN org_defaults.default_status_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  ELSE
    NEW.status_source := 'document';
  END IF;

  IF NEW.document_type_id IS NULL THEN
    NEW.document_type_id := effective_type_id;
    NEW.document_type_source := CASE
      WHEN ws_defaults.default_document_type_id IS NOT NULL THEN 'workspace'
      WHEN org_defaults.default_document_type_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  ELSE
    NEW.document_type_source := 'document';
  END IF;

  IF NEW.classification_id IS NULL THEN
    NEW.classification_id := COALESCE(ws_defaults.default_classification_id, org_defaults.default_classification_id);
    NEW.classification_source := CASE
      WHEN ws_defaults.default_classification_id IS NOT NULL THEN 'workspace'
      WHEN org_defaults.default_classification_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  ELSE
    NEW.classification_source := 'document';
  END IF;

  IF NEW.retention_policy_id IS NULL THEN
    NEW.retention_policy_id := COALESCE(ws_defaults.default_retention_policy_id, org_defaults.default_retention_policy_id);
    NEW.retention_policy_source := CASE
      WHEN ws_defaults.default_retention_policy_id IS NOT NULL THEN 'workspace'
      WHEN org_defaults.default_retention_policy_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  ELSE
    NEW.retention_policy_source := 'document';
  END IF;

  IF NEW.language_id IS NULL THEN
    NEW.language_id := COALESCE(ws_defaults.default_language_id, org_defaults.default_language_id, fallback_language_id);
    NEW.language_source := CASE
      WHEN ws_defaults.default_language_id IS NOT NULL THEN 'workspace'
      WHEN org_defaults.default_language_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  ELSE
    NEW.language_source := 'document';
  END IF;

  IF NEW.responsible_user_id IS NULL THEN
    NEW.responsible_user_id := COALESCE(valid_ws_responsible_id, valid_org_responsible_id, fallback_responsible_id);
    NEW.responsible_source := CASE
      WHEN valid_ws_responsible_id IS NOT NULL THEN 'workspace'
      WHEN valid_org_responsible_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  ELSIF document_metadata_is_valid_responsible_user(NEW.workspace_id, NEW.responsible_user_id) THEN
    NEW.responsible_source := 'document';
  ELSE
    NEW.responsible_user_id := COALESCE(valid_ws_responsible_id, valid_org_responsible_id, fallback_responsible_id);
    NEW.responsible_source := CASE
      WHEN valid_ws_responsible_id IS NOT NULL THEN 'workspace'
      WHEN valid_org_responsible_id IS NOT NULL THEN 'organization'
      ELSE 'fallback'
    END;
  END IF;

  NEW.metadata_materialized_at := COALESCE(NEW.metadata_materialized_at, now());
  NEW.metadata_updated_at := COALESCE(NEW.metadata_updated_at, now());
  NEW.metadata_updated_by := COALESCE(NEW.metadata_updated_by, NEW.updated_by, NEW.created_by);

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.docs_materialize_metadata_defaults_on_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.document_metadata_initial_defaults(NEW);
END;
$$;
