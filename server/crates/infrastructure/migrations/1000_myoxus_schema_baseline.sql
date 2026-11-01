-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Canonical Myoxus schema baseline, derived from migrations 0001 through 0243 at commit 5b7fa8b3145d4e4878f80a8f56da980a78208f00.
-- Generated from an empty isolated PostgreSQL database; contains only schema and migration-owned canonical seed rows.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: calendar_event_origin; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.calendar_event_origin AS ENUM (
    'native',
    'external'
);


--
-- Name: organization_policy_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_policy_state AS ENUM (
    'disabled',
    'requires_approval',
    'allowed'
);


--
-- Name: organization_project_request_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_project_request_scope AS ENUM (
    'organization_root',
    'ou'
);


--
-- Name: organization_project_request_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_project_request_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'cancelled'
);


--
-- Name: organization_unit_member_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_unit_member_source AS ENUM (
    'manual',
    'import',
    'oidc',
    'ldap',
    'scim'
);


--
-- Name: organization_unit_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_unit_role AS ENUM (
    'reader',
    'member',
    'manager'
);


--
-- Name: organization_unit_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_unit_status AS ENUM (
    'active',
    'disabled',
    'archived'
);


--
-- Name: organization_unit_workspace_relationship; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.organization_unit_workspace_relationship AS ENUM (
    'owner',
    'managed',
    'linked'
);


--
-- Name: owner_principal_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.owner_principal_type AS ENUM (
    'user',
    'ou',
    'system'
);


--
-- Name: pdf_export_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pdf_export_status AS ENUM (
    'queued',
    'running',
    'done',
    'failed'
);


--
-- Name: assign_default_pdf_template_to_new_workspace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_default_pdf_template_to_new_workspace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    actor_id UUID;
BEGIN
    actor_id := COALESCE(NEW.created_by_user_id, NEW.owner_user_id);

    -- Import/shared creation paths always carry a creator. A deliberately
    -- ownerless system row is left for the runtime repair pass, which can use
    -- an accepted workspace administrator when one exists.
    IF actor_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO pdf_workspace_template_assignments (
        workspace_id,
        template_id,
        is_default,
        assigned_by,
        assigned_at
    )
    SELECT NEW.id, template.id, TRUE, actor_id, now()
      FROM pdf_templates template
     WHERE template.slug = 'default'
       AND template.deleted_at IS NULL
    ON CONFLICT (workspace_id, template_id) DO NOTHING;

    RETURN NEW;
END;
$$;


--
-- Name: bump_document_metadata_global_epoch(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_document_metadata_global_epoch(p_epoch_name text, p_actor_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    next_revision BIGINT;
BEGIN
    INSERT INTO document_metadata_global_epoch (epoch_name, revision, updated_by, updated_at)
    VALUES (p_epoch_name, 1, p_actor_id, now())
    ON CONFLICT (epoch_name) DO UPDATE
      SET revision = document_metadata_global_epoch.revision + 1,
          updated_by = p_actor_id,
          updated_at = now()
    RETURNING revision INTO next_revision;
    RETURN next_revision;
END;
$$;


--
-- Name: bump_organization_document_metadata_epoch(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_organization_document_metadata_epoch(p_organization_id uuid, p_epoch_name text, p_actor_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    next_revision BIGINT;
BEGIN
    INSERT INTO organization_document_metadata_epoch (organization_id, epoch_name, revision, updated_by, updated_at)
    VALUES (p_organization_id, p_epoch_name, 1, p_actor_id, now())
    ON CONFLICT (organization_id, epoch_name) DO UPDATE
      SET revision = organization_document_metadata_epoch.revision + 1,
          updated_by = p_actor_id,
          updated_at = now()
    RETURNING revision INTO next_revision;
    RETURN next_revision;
END;
$$;


--
-- Name: bump_workspace_document_metadata_epoch(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_workspace_document_metadata_epoch(p_workspace_id uuid, p_epoch_name text, p_actor_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    next_revision BIGINT;
BEGIN
    INSERT INTO workspace_document_metadata_epoch (workspace_id, epoch_name, revision, updated_by, updated_at)
    VALUES (p_workspace_id, p_epoch_name, 1, p_actor_id, now())
    ON CONFLICT (workspace_id, epoch_name) DO UPDATE
      SET revision = workspace_document_metadata_epoch.revision + 1,
          updated_by = p_actor_id,
          updated_at = now()
    RETURNING revision INTO next_revision;
    RETURN next_revision;
END;
$$;


--
-- Name: docs_materialize_audience_defaults_on_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.docs_materialize_audience_defaults_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  has_workspace_defaults BOOLEAN;
  has_org_defaults BOOLEAN;
  effective_org_id UUID;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM workspace_document_audience_default WHERE workspace_id = NEW.workspace_id
  ) INTO has_workspace_defaults;

  IF has_workspace_defaults THEN
    INSERT INTO doc_audience_assignment (doc_id, audience_id, source, assigned_by)
    SELECT NEW.id, audience_id, 'workspace', COALESCE(NEW.metadata_updated_by, NEW.updated_by, NEW.created_by)
    FROM workspace_document_audience_default
    WHERE workspace_id = NEW.workspace_id
    ON CONFLICT (doc_id, audience_id) DO NOTHING;

    UPDATE docs
    SET audience_source = 'workspace'
    WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  SELECT COALESCE(linked_owner.organization_id, owner_unit.organization_id, managed_unit.organization_id, default_org.id)
  INTO effective_org_id
  FROM workspaces w
  LEFT JOIN organization_unit owner_unit
    ON owner_unit.id = w.owner_principal_id
   AND w.owner_principal_type::text = 'ou'
  LEFT JOIN organization_unit managed_unit
    ON managed_unit.id = w.management_unit_id
  LEFT JOIN LATERAL (
    SELECT ou.organization_id
    FROM organization_unit_workspace ouw
    JOIN organization_unit ou ON ou.id = ouw.unit_id
    WHERE ouw.workspace_id = w.id
    ORDER BY CASE ouw.relationship::text
      WHEN 'owner' THEN 0
      WHEN 'managed' THEN 1
      ELSE 2
    END, ouw.updated_at DESC
    LIMIT 1
  ) linked_owner ON true
  LEFT JOIN LATERAL (
    SELECT id
    FROM organization
    WHERE key = 'myoxus'
    ORDER BY created_at, id
    LIMIT 1
  ) default_org ON true
  WHERE w.id = NEW.workspace_id;

  SELECT EXISTS(
    SELECT 1 FROM organization_document_audience_default WHERE organization_id = effective_org_id
  ) INTO has_org_defaults;
  IF has_org_defaults THEN
    INSERT INTO doc_audience_assignment (doc_id, audience_id, source, assigned_by)
    SELECT NEW.id, audience_id, 'organization', COALESCE(NEW.metadata_updated_by, NEW.updated_by, NEW.created_by)
    FROM organization_document_audience_default
    WHERE organization_id = effective_org_id
    ORDER BY sort_order
    ON CONFLICT (doc_id, audience_id) DO NOTHING;

    UPDATE docs
    SET audience_source = 'organization'
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: docs_materialize_external_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.docs_materialize_external_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.external_id IS NULL OR btrim(NEW.external_id) = '' THEN
    NEW.external_id := NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: docs_materialize_metadata_defaults_on_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.docs_materialize_metadata_defaults_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
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


--
-- Name: docs_reject_template_document_type(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.docs_reject_template_document_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  type_key TEXT;
BEGIN
  IF NEW.document_type_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT key INTO type_key FROM document_type_definition WHERE id = NEW.document_type_id;
  IF type_key = 'template' THEN
    RAISE EXCEPTION 'documentType=template is not allowed in canonical docs metadata; use document_template_state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: docs_touch_metadata_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.docs_touch_metadata_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF
    NEW.status_id IS DISTINCT FROM OLD.status_id OR
    NEW.document_type_id IS DISTINCT FROM OLD.document_type_id OR
    NEW.classification_id IS DISTINCT FROM OLD.classification_id OR
    NEW.retention_policy_id IS DISTINCT FROM OLD.retention_policy_id OR
    NEW.language_id IS DISTINCT FROM OLD.language_id OR
    NEW.responsible_user_id IS DISTINCT FROM OLD.responsible_user_id OR
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
    IF NEW.metadata_updated_at IS NOT DISTINCT FROM OLD.metadata_updated_at THEN
      NEW.metadata_updated_at = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: document_metadata_bump_global_epoch_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_bump_global_epoch_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    actor_id UUID;
    payload JSONB;
BEGIN
    payload = CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    actor_id = NULLIF(payload->>'updated_by', '')::UUID;
    PERFORM bump_document_metadata_global_epoch(TG_ARGV[0], actor_id);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: document_metadata_bump_organization_epoch_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_bump_organization_epoch_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    actor_id UUID;
    payload JSONB;
    target_organization_id UUID;
BEGIN
    payload = CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    actor_id = NULLIF(payload->>'updated_by', '')::UUID;
    target_organization_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
    IF NOT EXISTS (SELECT 1 FROM organization WHERE id = target_organization_id) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    PERFORM bump_organization_document_metadata_epoch(target_organization_id, TG_ARGV[0], actor_id);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: document_metadata_bump_workspace_epoch_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_bump_workspace_epoch_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    actor_id UUID;
    payload JSONB;
    target_workspace_id UUID;
BEGIN
    payload = CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    actor_id = NULLIF(payload->>'updated_by', '')::UUID;
    target_workspace_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = target_workspace_id) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    PERFORM bump_workspace_document_metadata_epoch(target_workspace_id, TG_ARGV[0], actor_id);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: document_metadata_can_edit_organization_default(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_can_edit_organization_default(p_organization_id uuid, p_actor_id uuid, p_field_key text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT p_actor_id IS NULL OR EXISTS (
    SELECT 1
    FROM users u
    JOIN document_metadata_field_definition f ON f.key = p_field_key
    LEFT JOIN organization_document_metadata_policy p
      ON p.organization_id = p_organization_id
     AND p.field_key = f.key
    WHERE u.id = p_actor_id
      AND u.is_admin = true
      AND COALESCE(p.enabled, true) = true
      AND f.organization_edit_role = 'organization_admin'
      AND f.inheritance_mode IN ('inherited', 'relation_inherited')
  );
$$;


--
-- Name: document_metadata_default_language_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_default_language_id() RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  configured_locale TEXT;
  normalized_locale TEXT;
  result_id UUID;
BEGIN
  SELECT COALESCE(NULLIF(value->>'value', ''), NULLIF(value#>>'{}', ''))
  INTO configured_locale
  FROM app_configs
  WHERE id = 'i18n.default_locale'
  LIMIT 1;

  normalized_locale := COALESCE(NULLIF(btrim(configured_locale), ''), 'en');

  IF lower(normalized_locale) = 'en-us' THEN
    normalized_locale := 'en';
  END IF;

  SELECT id INTO result_id
  FROM language_definition
  WHERE is_active AND lower(key) = lower(normalized_locale)
  ORDER BY sort_order, key
  LIMIT 1;

  IF result_id IS NULL AND position('-' IN normalized_locale) > 0 THEN
    SELECT id INTO result_id
    FROM language_definition
    WHERE is_active AND lower(key) = lower(split_part(normalized_locale, '-', 1))
    ORDER BY sort_order, key
    LIMIT 1;
  END IF;

  IF result_id IS NULL THEN
    SELECT id INTO result_id
    FROM language_definition
    WHERE is_active AND key = 'en'
    LIMIT 1;
  END IF;

  RETURN result_id;
END;
$$;


--
-- Name: document_metadata_default_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_default_profile() RETURNS TABLE(status_schema_key text, default_status_key text, default_document_type_key text, default_classification_key text, default_retention_policy_key text, default_language_key text, default_audience_keys text[])
    LANGUAGE sql STABLE
    AS $$
  SELECT
    'simple'::TEXT AS status_schema_key,
    'in_progress'::TEXT AS default_status_key,
    'documentation'::TEXT AS default_document_type_key,
    'public'::TEXT AS default_classification_key,
    'standard'::TEXT AS default_retention_policy_key,
    COALESCE(
      (SELECT key FROM language_definition WHERE id = document_metadata_default_language_id()),
      'en'
    )::TEXT AS default_language_key,
    ARRAY['internal']::TEXT[] AS default_audience_keys
$$;


--
-- Name: document_metadata_effective_organization_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_effective_organization_id(p_workspace_id uuid) RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE(linked_owner.organization_id, owner_unit.organization_id, managed_unit.organization_id, default_org.id)
  FROM workspaces w
  LEFT JOIN organization_unit owner_unit
    ON owner_unit.id = w.owner_principal_id
   AND w.owner_principal_type::text = 'ou'
  LEFT JOIN organization_unit managed_unit
    ON managed_unit.id = w.management_unit_id
  LEFT JOIN LATERAL (
    SELECT ou.organization_id
    FROM organization_unit_workspace ouw
    JOIN organization_unit ou ON ou.id = ouw.unit_id
    WHERE ouw.workspace_id = w.id
    ORDER BY CASE lower(ouw.relationship::text)
      WHEN 'owner' THEN 0
      WHEN 'managed' THEN 1
      ELSE 2
    END, ouw.updated_at DESC
    LIMIT 1
  ) linked_owner ON true
  LEFT JOIN LATERAL (
    SELECT id
    FROM organization
    WHERE key = 'myoxus'
    ORDER BY created_at, id
    LIMIT 1
  ) default_org ON true
  WHERE w.id = p_workspace_id
$$;


--
-- Name: document_metadata_guard_organization_settings_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_guard_organization_settings_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_document_type_id UUID;
  old_classification_id UUID;
  old_retention_policy_id UUID;
  old_language_id UUID;
  old_responsible_user_id UUID;
BEGIN
  IF NEW.updated_by IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_document_type_id := OLD.default_document_type_id;
    old_classification_id := OLD.default_classification_id;
    old_retention_policy_id := OLD.default_retention_policy_id;
    old_language_id := OLD.default_language_id;
    old_responsible_user_id := OLD.default_responsible_user_id;
  END IF;

  IF NEW.default_document_type_id IS DISTINCT FROM old_document_type_id AND
     NOT document_metadata_can_edit_organization_default(NEW.organization_id, NEW.updated_by, 'documentType') THEN
    RAISE EXCEPTION 'organization document default field locked for actor: documentType'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.default_classification_id IS DISTINCT FROM old_classification_id AND
     NOT document_metadata_can_edit_organization_default(NEW.organization_id, NEW.updated_by, 'classification') THEN
    RAISE EXCEPTION 'organization document default field locked for actor: classification'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.default_retention_policy_id IS DISTINCT FROM old_retention_policy_id AND
     NOT document_metadata_can_edit_organization_default(NEW.organization_id, NEW.updated_by, 'retentionPolicy') THEN
    RAISE EXCEPTION 'organization document default field locked for actor: retentionPolicy'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.default_language_id IS DISTINCT FROM old_language_id AND
     NOT document_metadata_can_edit_organization_default(NEW.organization_id, NEW.updated_by, 'language') THEN
    RAISE EXCEPTION 'organization document default field locked for actor: language'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.default_responsible_user_id IS DISTINCT FROM old_responsible_user_id AND
     NOT document_metadata_can_edit_organization_default(NEW.organization_id, NEW.updated_by, 'responsible') THEN
    RAISE EXCEPTION 'organization document default field locked for actor: responsible'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: document_metadata_is_valid_responsible_user(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_is_valid_responsible_user(p_workspace_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = p_user_id
        AND u.status = 'active'
    )
    AND (
      EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id = p_workspace_id
          AND w.owner_user_id = p_user_id
      )
      OR EXISTS (
        SELECT 1 FROM workspace_memberships wm
        WHERE wm.workspace_id = p_workspace_id
          AND wm.user_id = p_user_id
          AND wm.status = 'Accepted'
      )
      OR EXISTS (
        SELECT 1
        FROM organization_unit_workspace ouw
        JOIN organization_unit ou ON ou.id = ouw.unit_id
        JOIN organization_unit_member oum ON oum.unit_id = ou.id
        WHERE ouw.workspace_id = p_workspace_id
          AND ou.status = 'active'
          AND oum.user_id = p_user_id
      )
    );
$$;


--
-- Name: document_metadata_rematerialize_organization_settings_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_rematerialize_organization_settings_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  workspace_row RECORD;
BEGIN
  FOR workspace_row IN
    SELECT w.id
    FROM workspaces w
    WHERE w.deleted_at IS NULL
      AND document_metadata_effective_organization_id(w.id) = NEW.organization_id
  LOOP
    PERFORM * FROM document_metadata_rematerialize_workspace_defaults(workspace_row.id, NEW.updated_by);
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: document_metadata_rematerialize_workspace_defaults(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_rematerialize_workspace_defaults(p_workspace_id uuid, p_actor_id uuid DEFAULT NULL::uuid) RETURNS TABLE(scanned_count bigint, changed_count bigint, materialized_count bigint)
    LANGUAGE plpgsql
    AS $$
DECLARE
  materialized_at TIMESTAMPTZ := now();
BEGIN
  SELECT COUNT(*)
  INTO scanned_count
  FROM docs
  WHERE workspace_id = p_workspace_id
    AND deleted_at IS NULL;

  WITH context AS (
    SELECT
      p_workspace_id AS workspace_id,
      document_metadata_effective_organization_id(p_workspace_id) AS organization_id
  ), defaults AS (
    SELECT
      ws.workspace_id,
      ws.status_schema_id AS ws_status_schema_id,
      ws.default_status_id AS ws_default_status_id,
      ws.default_document_type_id AS ws_default_document_type_id,
      ws.default_classification_id AS ws_default_classification_id,
      ws.default_retention_policy_id AS ws_default_retention_policy_id,
      ws.default_language_id AS ws_default_language_id,
      ws.default_responsible_user_id AS ws_default_responsible_user_id,
      org.status_schema_id AS org_status_schema_id,
      org.default_status_id AS org_default_status_id,
      org.default_document_type_id AS org_default_document_type_id,
      org.default_classification_id AS org_default_classification_id,
      org.default_retention_policy_id AS org_default_retention_policy_id,
      org.default_language_id AS org_default_language_id,
      org.default_responsible_user_id AS org_default_responsible_user_id
    FROM context ctx
    LEFT JOIN document_workspace_settings ws ON ws.workspace_id = ctx.workspace_id
    LEFT JOIN organization_document_settings org ON org.organization_id = ctx.organization_id
  ), fallback_status AS (
    SELECT v.id
    FROM document_status_value v
    JOIN document_status_schema s ON s.id = v.schema_id
    WHERE v.is_active
      AND (s.key = 'simple' OR NOT EXISTS (SELECT 1 FROM document_status_schema WHERE key = 'simple' AND is_active))
    ORDER BY CASE WHEN s.key = 'simple' THEN 0 ELSE 1 END, v.sort_order, v.key
    LIMIT 1
  ), fallback_language AS (
    SELECT id
    FROM language_definition
    WHERE key = 'de' AND is_active
    LIMIT 1
  ), target AS (
    SELECT
      d.id,
      d.created_by,
      COALESCE(d.document_type_id, defs.ws_default_document_type_id, defs.org_default_document_type_id) AS effective_type_id,
      COALESCE(defs.ws_status_schema_id, defs.org_status_schema_id) AS effective_schema_id,
      defs.*,
      CASE
        WHEN document_metadata_is_valid_responsible_user(p_workspace_id, defs.ws_default_responsible_user_id)
        THEN defs.ws_default_responsible_user_id
        ELSE NULL
      END AS ws_valid_responsible_user_id,
      CASE
        WHEN document_metadata_is_valid_responsible_user(p_workspace_id, defs.org_default_responsible_user_id)
        THEN defs.org_default_responsible_user_id
        ELSE NULL
      END AS org_valid_responsible_user_id,
      fs.id AS fallback_status_id,
      fl.id AS fallback_language_id,
      document_metadata_resolve_responsible_fallback(p_workspace_id, d.created_by) AS fallback_responsible_id
    FROM docs d
    CROSS JOIN defaults defs
    CROSS JOIN fallback_status fs
    CROSS JOIN fallback_language fl
    WHERE d.workspace_id = p_workspace_id
      AND d.deleted_at IS NULL
  ), computed AS (
    SELECT
      d.id,
      CASE WHEN d.status_source = 'document'
        THEN d.status_id
        ELSE COALESCE(t.ws_default_status_id, type_status.status_id, t.org_default_status_id, t.fallback_status_id)
      END AS status_id,
      CASE WHEN d.status_source = 'document'
        THEN d.status_source
        WHEN t.ws_default_status_id IS NOT NULL OR type_status.status_id IS NOT NULL THEN 'workspace'
        WHEN t.org_default_status_id IS NOT NULL THEN 'organization'
        ELSE 'fallback'
      END AS status_source,
      CASE WHEN d.document_type_source = 'document'
        THEN d.document_type_id
        ELSE t.effective_type_id
      END AS document_type_id,
      CASE WHEN d.document_type_source = 'document'
        THEN d.document_type_source
        WHEN t.ws_default_document_type_id IS NOT NULL THEN 'workspace'
        WHEN t.org_default_document_type_id IS NOT NULL THEN 'organization'
        ELSE 'fallback'
      END AS document_type_source,
      CASE WHEN d.classification_source = 'document'
        THEN d.classification_id
        ELSE COALESCE(t.ws_default_classification_id, t.org_default_classification_id)
      END AS classification_id,
      CASE WHEN d.classification_source = 'document'
        THEN d.classification_source
        WHEN t.ws_default_classification_id IS NOT NULL THEN 'workspace'
        WHEN t.org_default_classification_id IS NOT NULL THEN 'organization'
        ELSE 'fallback'
      END AS classification_source,
      CASE WHEN d.retention_policy_source = 'document'
        THEN d.retention_policy_id
        ELSE COALESCE(t.ws_default_retention_policy_id, t.org_default_retention_policy_id)
      END AS retention_policy_id,
      CASE WHEN d.retention_policy_source = 'document'
        THEN d.retention_policy_source
        WHEN t.ws_default_retention_policy_id IS NOT NULL THEN 'workspace'
        WHEN t.org_default_retention_policy_id IS NOT NULL THEN 'organization'
        ELSE 'fallback'
      END AS retention_policy_source,
      CASE WHEN d.language_source = 'document'
        THEN d.language_id
        ELSE COALESCE(t.ws_default_language_id, t.org_default_language_id, t.fallback_language_id)
      END AS language_id,
      CASE WHEN d.language_source = 'document'
        THEN d.language_source
        WHEN t.ws_default_language_id IS NOT NULL THEN 'workspace'
        WHEN t.org_default_language_id IS NOT NULL THEN 'organization'
        ELSE 'fallback'
      END AS language_source,
      CASE WHEN d.responsible_source = 'document' AND d.responsible_user_id IS NULL
        THEN NULL
        WHEN d.responsible_source = 'document' AND document_metadata_is_valid_responsible_user(p_workspace_id, d.responsible_user_id)
        THEN d.responsible_user_id
        ELSE COALESCE(t.ws_valid_responsible_user_id, t.org_valid_responsible_user_id, t.fallback_responsible_id)
      END AS responsible_user_id,
      CASE WHEN d.responsible_source = 'document' AND d.responsible_user_id IS NULL
        THEN d.responsible_source
        WHEN d.responsible_source = 'document' AND document_metadata_is_valid_responsible_user(p_workspace_id, d.responsible_user_id)
        THEN d.responsible_source
        WHEN t.ws_valid_responsible_user_id IS NOT NULL THEN 'workspace'
        WHEN t.org_valid_responsible_user_id IS NOT NULL THEN 'organization'
        ELSE 'fallback'
      END AS responsible_source
    FROM docs d
    JOIN target t ON t.id = d.id
    LEFT JOIN document_type_status_default type_status
      ON type_status.document_type_id = t.effective_type_id
     AND type_status.status_schema_id = t.effective_schema_id
  ), changed AS (
    UPDATE docs d
    SET status_id = c.status_id,
        status_source = c.status_source,
        document_type_id = c.document_type_id,
        document_type_source = c.document_type_source,
        classification_id = c.classification_id,
        classification_source = c.classification_source,
        retention_policy_id = c.retention_policy_id,
        retention_policy_source = c.retention_policy_source,
        language_id = c.language_id,
        language_source = c.language_source,
        responsible_user_id = c.responsible_user_id,
        responsible_source = c.responsible_source,
        metadata_materialized_at = materialized_at,
        metadata_updated_at = materialized_at,
        metadata_updated_by = p_actor_id
    FROM computed c
    WHERE d.id = c.id
      AND (
        d.status_id IS DISTINCT FROM c.status_id OR
        d.status_source IS DISTINCT FROM c.status_source OR
        d.document_type_id IS DISTINCT FROM c.document_type_id OR
        d.document_type_source IS DISTINCT FROM c.document_type_source OR
        d.classification_id IS DISTINCT FROM c.classification_id OR
        d.classification_source IS DISTINCT FROM c.classification_source OR
        d.retention_policy_id IS DISTINCT FROM c.retention_policy_id OR
        d.retention_policy_source IS DISTINCT FROM c.retention_policy_source OR
        d.language_id IS DISTINCT FROM c.language_id OR
        d.language_source IS DISTINCT FROM c.language_source OR
        d.responsible_user_id IS DISTINCT FROM c.responsible_user_id OR
        d.responsible_source IS DISTINCT FROM c.responsible_source
      )
    RETURNING d.id
  )
  SELECT COUNT(*) INTO changed_count FROM changed;

  UPDATE docs
  SET metadata_materialized_at = materialized_at
  WHERE workspace_id = p_workspace_id
    AND deleted_at IS NULL
    AND metadata_materialized_at IS DISTINCT FROM materialized_at;

  GET DIAGNOSTICS materialized_count = ROW_COUNT;

  RETURN NEXT;
END;
$$;


--
-- Name: document_metadata_rematerialize_workspace_membership_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_rematerialize_workspace_membership_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  affected_workspace_id UUID;
BEGIN
  affected_workspace_id := COALESCE(NEW.workspace_id, OLD.workspace_id);
  PERFORM * FROM document_metadata_rematerialize_workspace_defaults(affected_workspace_id, NULL);
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: document_metadata_rematerialize_workspace_owner_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_rematerialize_workspace_owner_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    PERFORM * FROM document_metadata_rematerialize_workspace_defaults(NEW.id, NULL);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: document_metadata_rematerialize_workspace_settings_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_rematerialize_workspace_settings_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM * FROM document_metadata_rematerialize_workspace_defaults(NEW.workspace_id, NEW.updated_by);
  RETURN NEW;
END;
$$;


--
-- Name: document_metadata_resolve_responsible_fallback(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_resolve_responsible_fallback(p_workspace_id uuid, p_created_by uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  manager_count BIGINT;
  manager_id UUID;
  owner_id UUID;
BEGIN
  SELECT COUNT(*), (array_agg(wm.user_id ORDER BY wm.user_id::text))[1]
  INTO manager_count, manager_id
  FROM workspace_memberships wm
  JOIN users u ON u.id = wm.user_id AND u.status = 'active'
  WHERE wm.workspace_id = p_workspace_id
    AND wm.role = 'Manager'
    AND wm.status = 'Accepted';

  IF manager_count = 1 THEN
    RETURN manager_id;
  END IF;

  SELECT w.owner_user_id INTO owner_id
  FROM workspaces w
  JOIN users u ON u.id = w.owner_user_id AND u.status = 'active'
  WHERE w.id = p_workspace_id;

  IF owner_id IS NOT NULL THEN
    RETURN owner_id;
  END IF;

  IF p_created_by IS NOT NULL AND EXISTS (
    SELECT 1 FROM users u WHERE u.id = p_created_by AND u.status = 'active'
  ) THEN
    RETURN p_created_by;
  END IF;

  RETURN NULL;
END;
$$;


--
-- Name: document_metadata_seed_organization_defaults(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_seed_organization_defaults(p_organization_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  profile RECORD;
  simple_schema_id UUID;
  in_progress_status_id UUID;
  documentation_type_id UUID;
  public_classification_id UUID;
  standard_retention_id UUID;
  default_language_id UUID;
  audience_key TEXT;
  resolved_audience_id UUID;
  audience_sort_order INTEGER := 10;
BEGIN
  SELECT * INTO profile
  FROM document_metadata_default_profile()
  LIMIT 1;

  SELECT id INTO simple_schema_id
  FROM document_status_schema
  WHERE key = profile.status_schema_key AND is_active
  LIMIT 1;

  SELECT v.id INTO in_progress_status_id
  FROM document_status_value v
  JOIN document_status_schema s ON s.id = v.schema_id
  WHERE s.key = profile.status_schema_key
    AND v.key = profile.default_status_key
    AND v.is_active
  LIMIT 1;

  SELECT id INTO documentation_type_id
  FROM document_type_definition
  WHERE key = profile.default_document_type_key AND is_active
  LIMIT 1;

  SELECT id INTO public_classification_id
  FROM document_classification_definition
  WHERE key = profile.default_classification_key AND is_active
  LIMIT 1;

  SELECT id INTO standard_retention_id
  FROM document_retention_policy_definition
  WHERE key = profile.default_retention_policy_key AND is_active
  LIMIT 1;

  SELECT id INTO default_language_id
  FROM language_definition
  WHERE key = profile.default_language_key AND is_active
  LIMIT 1;

  INSERT INTO organization_document_settings (
    organization_id,
    status_schema_id,
    default_status_id,
    default_document_type_id,
    default_classification_id,
    default_retention_policy_id,
    default_language_id
  ) VALUES (
    p_organization_id,
    simple_schema_id,
    in_progress_status_id,
    documentation_type_id,
    public_classification_id,
    standard_retention_id,
    default_language_id
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    status_schema_id = COALESCE(organization_document_settings.status_schema_id, EXCLUDED.status_schema_id),
    default_status_id = COALESCE(organization_document_settings.default_status_id, EXCLUDED.default_status_id),
    default_document_type_id = COALESCE(organization_document_settings.default_document_type_id, EXCLUDED.default_document_type_id),
    default_classification_id = COALESCE(organization_document_settings.default_classification_id, EXCLUDED.default_classification_id),
    default_retention_policy_id = COALESCE(organization_document_settings.default_retention_policy_id, EXCLUDED.default_retention_policy_id),
    default_language_id = COALESCE(organization_document_settings.default_language_id, EXCLUDED.default_language_id),
    updated_at = now();

  INSERT INTO organization_document_metadata_policy (organization_id, field_key)
  SELECT p_organization_id, key
  FROM document_metadata_field_definition
  ON CONFLICT (organization_id, field_key) DO NOTHING;

  FOREACH audience_key IN ARRAY profile.default_audience_keys LOOP
    SELECT id INTO resolved_audience_id
    FROM document_audience_definition
    WHERE key = audience_key AND is_active
    LIMIT 1;

    IF resolved_audience_id IS NOT NULL THEN
      INSERT INTO organization_document_audience_default (organization_id, audience_id, sort_order)
      VALUES (p_organization_id, resolved_audience_id, audience_sort_order)
      ON CONFLICT (organization_id, audience_id) DO NOTHING;
      audience_sort_order := audience_sort_order + 10;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: document_metadata_seed_organization_defaults_on_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_seed_organization_defaults_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM document_metadata_seed_organization_defaults(NEW.id);
  RETURN NEW;
END;
$$;


--
-- Name: document_metadata_touch_subsystem_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_metadata_touch_subsystem_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_doc_id UUID;
  actor_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_doc_id := OLD.doc_id;
    actor_id := OLD.updated_by;
  ELSE
    target_doc_id := NEW.doc_id;
    actor_id := NEW.updated_by;
  END IF;

  UPDATE docs
  SET metadata_revision = metadata_revision + 1,
      metadata_updated_at = now(),
      metadata_updated_by = COALESCE(actor_id, metadata_updated_by),
      metadata_materialized_at = COALESCE(metadata_materialized_at, now())
  WHERE id = target_doc_id
    AND workspace_id IS NOT NULL
    AND deleted_at IS NULL;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: document_version_assign_version_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.document_version_assign_version_no() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.version_no IS NULL THEN
    INSERT INTO document_version_label_counter (doc_id, counter_key, next_value)
    VALUES (NEW.doc_id, 'seq', 2)
    ON CONFLICT (doc_id, counter_key) DO UPDATE
      SET next_value = document_version_label_counter.next_value + 1,
          updated_at = now()
    RETURNING next_value - 1 INTO NEW.version_no;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: normalize_workspace_owner_principal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_workspace_owner_principal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.owner_principal_type IS NULL THEN
        IF NEW.owner_user_id IS NULL THEN
            NEW.owner_principal_type := 'system'::owner_principal_type;
            NEW.owner_principal_id := NULL;
        ELSE
            NEW.owner_principal_type := 'user'::owner_principal_type;
            NEW.owner_principal_id := NEW.owner_user_id;
            NEW.created_by_user_id := COALESCE(NEW.created_by_user_id, NEW.owner_user_id);
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: refresh_database_row_tag_search_projection(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_database_row_tag_search_projection(target_workspace_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
  WITH tag_references AS (
    SELECT DISTINCT ON (search.row_id, tag.id)
           search.row_id,
           tag.id,
           tag.name,
           tag.slug,
           tag.color_role,
           field.position AS field_position,
           reference.position AS tag_position
      FROM workspace_database_row_search search
      JOIN workspace_database_cell_values value ON value.row_id = search.row_id
      JOIN workspace_database_fields field
        ON field.id = value.field_id
       AND field.field_type = 'tags'
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(value.value_json) = 'array' THEN value.value_json
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS reference(tag_id, position)
      JOIN workspace_tags tag
        ON tag.workspace_id = search.workspace_id
       AND tag.id::text = reference.tag_id
     WHERE search.workspace_id = target_workspace_id
     ORDER BY search.row_id, tag.id, field.position, reference.position
  ),
  projections AS (
    SELECT search.row_id,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id', reference.id,
                 'name', reference.name,
                 'slug', reference.slug,
                 'colorRole', reference.color_role
               ) ORDER BY reference.field_position, reference.tag_position
             ) FILTER (WHERE reference.id IS NOT NULL),
             '[]'::jsonb
           ) AS tags
      FROM workspace_database_row_search search
      LEFT JOIN tag_references reference ON reference.row_id = search.row_id
     WHERE search.workspace_id = target_workspace_id
     GROUP BY search.row_id
  )
  UPDATE workspace_database_row_search search
     SET workspace_tags = projections.tags,
         updated_at = now()
    FROM projections
   WHERE search.workspace_id = target_workspace_id
     AND search.row_id = projections.row_id;
$$;


--
-- Name: sync_git_sync_document_path_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_git_sync_document_path_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM git_sync_path_owners
    WHERE profile_id = OLD.profile_id
      AND owner_kind = 'document'
      AND owner_id = OLD.doc_id;
    RETURN OLD;
  END IF;
  IF NEW.tombstone THEN
    DELETE FROM git_sync_path_owners
    WHERE profile_id = OLD.profile_id
      AND owner_kind = 'document'
      AND owner_id = OLD.doc_id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.profile_id, OLD.doc_id) IS DISTINCT FROM (NEW.profile_id, NEW.doc_id) THEN
    DELETE FROM git_sync_path_owners
    WHERE profile_id = OLD.profile_id
      AND owner_kind = 'document'
      AND owner_id = OLD.doc_id;
  END IF;

  INSERT INTO git_sync_path_owners (profile_id, repo_path, owner_kind, owner_id)
  VALUES (NEW.profile_id, NEW.repo_path, 'document', NEW.doc_id)
  ON CONFLICT (profile_id, owner_kind, owner_id)
  DO UPDATE SET repo_path = EXCLUDED.repo_path, updated_at = now();
  RETURN NEW;
END
$$;


--
-- Name: sync_git_sync_file_path_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_git_sync_file_path_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM git_sync_path_owners
    WHERE profile_id = OLD.profile_id
      AND owner_kind = 'file'
      AND owner_id = OLD.id;
    RETURN OLD;
  END IF;
  IF NEW.tombstoned THEN
    DELETE FROM git_sync_path_owners
    WHERE profile_id = OLD.profile_id
      AND owner_kind = 'file'
      AND owner_id = OLD.id;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.profile_id, OLD.id) IS DISTINCT FROM (NEW.profile_id, NEW.id) THEN
    DELETE FROM git_sync_path_owners
    WHERE profile_id = OLD.profile_id
      AND owner_kind = 'file'
      AND owner_id = OLD.id;
  END IF;

  INSERT INTO git_sync_path_owners (profile_id, repo_path, owner_kind, owner_id)
  VALUES (NEW.profile_id, NEW.repo_path, 'file', NEW.id)
  ON CONFLICT (profile_id, owner_kind, owner_id)
  DO UPDATE SET repo_path = EXCLUDED.repo_path, updated_at = now();
  RETURN NEW;
END
$$;


--
-- Name: trg_workspace_database_csv_mapping_templates_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_workspace_database_csv_mapping_templates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: validate_database_view_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_database_view_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  actual_profile_kind TEXT;
  actual_view_kind TEXT;
  expected_view_kind TEXT;
BEGIN
  SELECT profile_kind
  INTO actual_profile_kind
  FROM database_profiles
  WHERE database_id = NEW.database_id;

  SELECT view_kind
  INTO actual_view_kind
  FROM workspace_database_views
  WHERE database_id = NEW.database_id AND id = NEW.view_id;

  expected_view_kind := split_part(NEW.role_key, '.', 2);
  IF actual_profile_kind IS DISTINCT FROM NEW.profile_kind THEN
    RAISE EXCEPTION 'database view role profile does not match database profile'
      USING ERRCODE = '23514';
  END IF;
  IF actual_view_kind IS DISTINCT FROM expected_view_kind THEN
    RAISE EXCEPTION 'database view role kind does not match role key'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    revealed_prefix text,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    category text NOT NULL,
    target_type text,
    target_id text,
    target_label text,
    old_value jsonb,
    new_value jsonb,
    actor_user_id uuid,
    actor_label text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    target_unit_id uuid,
    actor_kind text DEFAULT 'user'::text NOT NULL,
    credential_type text,
    credential_id text,
    CONSTRAINT admin_audit_log_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'system'::text, 'api_key'::text]))),
    CONSTRAINT admin_audit_log_category_check CHECK ((category = ANY (ARRAY['config'::text, 'user'::text, 'workspace'::text, 'feature'::text, 'template'::text, 'logging'::text, 'cache'::text, 'auth'::text, 'pdf_export_config'::text, 'document_version'::text, 'document'::text, 'organization'::text, 'mcp'::text, 'workspace_automation'::text, 'database'::text])))
);


--
-- Name: ai_workspace_doc_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_workspace_doc_embeddings (
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    chunk integer DEFAULT 0 NOT NULL,
    content text NOT NULL,
    embedding public.vector(1024) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_workspace_file_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_workspace_file_embeddings (
    workspace_id uuid NOT NULL,
    file_id text NOT NULL,
    chunk integer DEFAULT 0 NOT NULL,
    content text NOT NULL,
    embedding public.vector(1024) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_workspace_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_workspace_files (
    workspace_id uuid NOT NULL,
    file_id text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    size integer DEFAULT 0 NOT NULL,
    blob_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_workspace_ignored_docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_workspace_ignored_docs (
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone
);


--
-- Name: app_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_configs (
    id text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_updated_by uuid
);


--
-- Name: app_server_branding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_server_branding (
    id boolean DEFAULT true NOT NULL,
    logo_asset_id uuid,
    product_mark_asset_id uuid,
    favicon_pack_asset_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT app_server_branding_id_check CHECK (id)
);


--
-- Name: blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blobs (
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    size bigint NOT NULL,
    mime text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    upload_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    blob_id uuid DEFAULT gen_random_uuid() NOT NULL,
    checksum text,
    deleted_at timestamp with time zone
);


--
-- Name: brand_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    slot text NOT NULL,
    variant text NOT NULL,
    quality_class text NOT NULL,
    storage_kind text NOT NULL,
    storage_key text NOT NULL,
    public_path text,
    mime text NOT NULL,
    sha256 text NOT NULL,
    byte_size bigint,
    width_px integer,
    height_px integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT brand_assets_byte_size_check CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
    CONSTRAINT brand_assets_check CHECK ((((scope = 'global'::text) AND (workspace_id IS NULL)) OR ((scope = 'workspace'::text) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT brand_assets_check1 CHECK ((((storage_kind = 'style_static'::text) AND (public_path IS NOT NULL)) OR ((storage_kind = 'pdf_blob'::text) AND (public_path IS NULL)))),
    CONSTRAINT brand_assets_height_px_check CHECK (((height_px IS NULL) OR (height_px > 0))),
    CONSTRAINT brand_assets_quality_class_check CHECK ((quality_class = ANY (ARRAY['web'::text, 'print'::text, 'favicon'::text, 'shared'::text]))),
    CONSTRAINT brand_assets_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'workspace'::text]))),
    CONSTRAINT brand_assets_slot_check CHECK ((slot = ANY (ARRAY['logo'::text, 'product_mark'::text, 'favicon_pack'::text]))),
    CONSTRAINT brand_assets_storage_kind_check CHECK ((storage_kind = ANY (ARRAY['style_static'::text, 'pdf_blob'::text]))),
    CONSTRAINT brand_assets_variant_check CHECK ((variant = ANY (ARRAY['large'::text, 'small'::text, 'mark'::text, 'pack'::text, 'default'::text]))),
    CONSTRAINT brand_assets_width_px_check CHECK (((width_px IS NULL) OR (width_px > 0)))
);


--
-- Name: brand_identity_cutover_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_identity_cutover_findings (
    finding_key text NOT NULL,
    severity text NOT NULL,
    details jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brand_identity_cutover_findings_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text])))
);


--
-- Name: branding_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branding_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    asset_type text NOT NULL,
    asset_key text NOT NULL,
    mime text NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT branding_assets_asset_type_check CHECK ((asset_type = ANY (ARRAY['logo_large'::text, 'logo_small'::text, 'product_mark'::text, 'favicon_pack'::text])))
);


--
-- Name: branding_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branding_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    theme_id uuid NOT NULL,
    theme_mode text NOT NULL,
    company_name text,
    footer_text text,
    default_pdf_template_id uuid,
    default_paper_size text,
    default_locale text,
    default_color_profile_id uuid,
    default_image_quality text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT branding_profiles_check CHECK ((((scope = 'global'::text) AND (workspace_id IS NULL)) OR ((scope = 'workspace'::text) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT branding_profiles_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'workspace'::text]))),
    CONSTRAINT branding_profiles_theme_mode_check CHECK ((theme_mode = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text])))
);


--
-- Name: cache_tuning_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache_tuning_metrics (
    id integer NOT NULL,
    cache_name text NOT NULL,
    hits bigint DEFAULT 0 NOT NULL,
    misses bigint DEFAULT 0 NOT NULL,
    hit_rate double precision DEFAULT 0.0 NOT NULL,
    invalidations_local bigint DEFAULT 0 NOT NULL,
    invalidations_remote bigint DEFAULT 0 NOT NULL,
    current_ttl_seconds integer NOT NULL,
    recommended_ttl_seconds integer NOT NULL,
    action_taken text DEFAULT 'none'::text NOT NULL,
    cycle_type text NOT NULL,
    measured_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cache_tuning_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cache_tuning_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cache_tuning_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cache_tuning_metrics_id_seq OWNED BY public.cache_tuning_metrics.id;


--
-- Name: calendar_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    remote_account_id text NOT NULL,
    access_token_ciphertext text,
    refresh_token_ciphertext text,
    expires_at timestamp with time zone,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_event_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    instance_start timestamp with time zone NOT NULL,
    instance_end timestamp with time zone NOT NULL,
    is_override boolean DEFAULT false NOT NULL,
    is_cancelled boolean DEFAULT false NOT NULL,
    override_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_event_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    user_id uuid,
    email text NOT NULL,
    display_name text,
    response_status text DEFAULT 'needsAction'::text NOT NULL,
    is_organizer boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_event_source_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_source_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    source_doc_id uuid NOT NULL,
    relation text DEFAULT 'mentioned_in'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_block_id text,
    source_start_offset integer,
    source_end_offset integer,
    source_kind text DEFAULT 'document'::text NOT NULL,
    CONSTRAINT calendar_event_source_links_relation_check CHECK ((relation = ANY (ARRAY['mentioned_in'::text, 'derived_from'::text, 'created_from'::text, 'agenda_for'::text, 'minutes_for'::text]))),
    CONSTRAINT calendar_event_source_links_source_end_offset_check CHECK (((source_end_offset IS NULL) OR (source_end_offset >= 0))),
    CONSTRAINT calendar_event_source_links_source_kind_check CHECK ((source_kind = ANY (ARRAY['document'::text, 'block'::text, 'text_range'::text]))),
    CONSTRAINT calendar_event_source_links_source_offset_order_check CHECK (((source_start_offset IS NULL) OR (source_end_offset IS NULL) OR (source_end_offset >= source_start_offset))),
    CONSTRAINT calendar_event_source_links_source_start_offset_check CHECK (((source_start_offset IS NULL) OR (source_start_offset >= 0)))
);


--
-- Name: calendar_event_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_event_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    remote_event_id text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    title text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid,
    source_doc_id uuid,
    etag text,
    remote_href text,
    origin public.calendar_event_origin DEFAULT 'external'::public.calendar_event_origin NOT NULL,
    all_members boolean DEFAULT false NOT NULL,
    description_delta jsonb,
    recurrence_parent_id uuid,
    tag_id uuid,
    CONSTRAINT ck_calendar_events_origin_consistency CHECK ((((origin = 'native'::public.calendar_event_origin) AND (account_id IS NULL) AND (remote_event_id IS NULL)) OR ((origin = 'external'::public.calendar_event_origin) AND (account_id IS NOT NULL) AND (remote_event_id IS NOT NULL))))
);


--
-- Name: calendar_pending_writes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_pending_writes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    operation text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    last_error text,
    CONSTRAINT calendar_pending_writes_operation_check CHECK ((operation = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text])))
);


--
-- Name: calendar_reminder_dispatch_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_reminder_dispatch_log (
    reminder_id uuid NOT NULL,
    worker_job_id uuid NOT NULL,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    channel text DEFAULT 'in_app'::text NOT NULL,
    minutes_before integer NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: calendar_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    remote_calendar_id text NOT NULL,
    webhook_channel text,
    sync_token text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    webhook_channel_json jsonb
);


--
-- Name: color_schema_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.color_schema_values (
    schema_id uuid NOT NULL,
    mode text NOT NULL,
    token_key text NOT NULL,
    value text NOT NULL,
    CONSTRAINT color_schema_values_mode_check CHECK ((mode = ANY (ARRAY['light'::text, 'dark'::text])))
);


--
-- Name: color_schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.color_schemas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    origin text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT color_schemas_origin_check CHECK ((origin = ANY (ARRAY['system'::text, 'custom'::text, 'workspace'::text])))
);


--
-- Name: comment_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    comment_id uuid,
    storage_key text NOT NULL,
    mime_type text,
    size_bytes bigint NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comment_edit_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_edit_history (
    id bigint NOT NULL,
    comment_id uuid NOT NULL,
    body jsonb NOT NULL,
    edited_by uuid NOT NULL,
    edited_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comment_edit_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.comment_edit_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.comment_edit_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: comment_thread_read_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_thread_read_state (
    user_id uuid NOT NULL,
    thread_comment_id uuid NOT NULL,
    read_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    parent_comment_id uuid,
    author_id uuid NOT NULL,
    body jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    last_edited_by uuid,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    deleted_by uuid,
    selection_anchor jsonb
);


--
-- Name: config_changelog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_changelog (
    id bigint NOT NULL,
    config_key text NOT NULL,
    old_value jsonb,
    new_value jsonb NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_changelog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.config_changelog_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: config_changelog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.config_changelog_id_seq OWNED BY public.config_changelog.id;


--
-- Name: connected_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connected_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    provider_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    access_token text,
    refresh_token text,
    expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_context_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_context_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    context_id uuid NOT NULL,
    item_type text NOT NULL,
    item_ref text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_contexts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    chunk_index integer NOT NULL,
    chunk_text text NOT NULL,
    token_count integer DEFAULT 0 NOT NULL,
    embedding public.vector(1536) NOT NULL,
    model text DEFAULT 'text-embedding-3-small'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type text NOT NULL,
    state text NOT NULL,
    workspace_id uuid,
    user_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_message_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_message_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    session_id uuid NOT NULL,
    role text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    token_usage jsonb,
    edited_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    revision_created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    role text NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    token_usage jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone
);


--
-- Name: copilot_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    workspace_id uuid,
    title text,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    doc_id uuid,
    pinned boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: copilot_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_transcripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    language text,
    content text DEFAULT ''::text NOT NULL,
    segments jsonb DEFAULT '[]'::jsonb,
    confidence real,
    model text DEFAULT ''::text NOT NULL,
    duration_secs real,
    metadata jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copilot_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copilot_workspaces (
    workspace_id uuid NOT NULL,
    last_embedding_at timestamp with time zone,
    ignored_doc_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: database_activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_activity_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    database_id uuid NOT NULL,
    row_id uuid,
    event_type text NOT NULL,
    actor_user_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_activity_events_event_type_length CHECK (((char_length(event_type) >= 1) AND (char_length(event_type) <= 64)))
);


--
-- Name: database_document_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_document_references (
    workspace_id uuid NOT NULL,
    database_id uuid NOT NULL,
    row_id uuid NOT NULL,
    field_id uuid,
    reference_kind text NOT NULL,
    raw_target_doc_id text NOT NULL,
    resolved_target_doc_id uuid,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_document_references_reference_kind_check CHECK ((reference_kind = ANY (ARRAY['row_content_document'::text, 'document_link_field'::text]))),
    CONSTRAINT database_document_references_shape CHECK ((((reference_kind = 'row_content_document'::text) AND (field_id IS NULL)) OR ((reference_kind = 'document_link_field'::text) AND (field_id IS NOT NULL))))
);


--
-- Name: database_field_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_field_roles (
    database_id uuid NOT NULL,
    profile_kind text NOT NULL,
    role_key text NOT NULL,
    row_kind_scope text,
    field_id uuid NOT NULL,
    required boolean DEFAULT false NOT NULL,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_field_roles_config_object CHECK ((jsonb_typeof(config_json) = 'object'::text)),
    CONSTRAINT database_field_roles_key_valid CHECK ((role_key ~ '^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$'::text)),
    CONSTRAINT database_field_roles_profile_valid CHECK ((profile_kind = 'project'::text)),
    CONSTRAINT database_field_roles_scope_valid CHECK (((row_kind_scope IS NULL) OR (row_kind_scope = ANY (ARRAY['task'::text, 'phase'::text, 'milestone'::text]))))
);


--
-- Name: database_import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_import_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    database_id uuid,
    actor_id uuid,
    kind text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    cancellation_requested_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    payload_summary_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    result_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_import_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: database_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_profiles (
    database_id uuid NOT NULL,
    profile_kind text NOT NULL,
    profile_version integer DEFAULT 1 NOT NULL,
    structure_preset text,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_profiles_config_object CHECK ((jsonb_typeof(config_json) = 'object'::text)),
    CONSTRAINT database_profiles_kind_valid CHECK ((profile_kind = ANY (ARRAY['generic'::text, 'project'::text]))),
    CONSTRAINT database_profiles_structure_valid CHECK ((((profile_kind = 'generic'::text) AND (structure_preset IS NULL)) OR ((profile_kind = 'project'::text) AND (structure_preset = ANY (ARRAY['tasks_only'::text, 'phases'::text, 'milestones'::text, 'phases_and_milestones'::text]))))),
    CONSTRAINT database_profiles_version_valid CHECK ((profile_version >= 1))
);


--
-- Name: database_row_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_row_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    database_id uuid NOT NULL,
    row_id uuid NOT NULL,
    field_id uuid NOT NULL,
    user_id uuid NOT NULL,
    offset_minutes bigint NOT NULL,
    trigger_at timestamp with time zone NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    schedule_revision bigint DEFAULT 1 NOT NULL,
    claim_token uuid,
    claim_expires_at timestamp with time zone,
    claim_attempts integer DEFAULT 0 NOT NULL,
    fired_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_row_reminders_check CHECK ((((status = 'claimed'::text) AND (claim_token IS NOT NULL) AND (claim_expires_at IS NOT NULL)) OR (status <> 'claimed'::text))),
    CONSTRAINT database_row_reminders_claim_attempts_check CHECK ((claim_attempts >= 0)),
    CONSTRAINT database_row_reminders_offset_minutes_check CHECK ((offset_minutes >= 0)),
    CONSTRAINT database_row_reminders_schedule_revision_check CHECK ((schedule_revision > 0)),
    CONSTRAINT database_row_reminders_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'claimed'::text, 'fired'::text, 'cancelled'::text])))
);


--
-- Name: workspace_database_cell_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_cell_values (
    row_id uuid NOT NULL,
    field_id uuid NOT NULL,
    value_json jsonb,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    database_id uuid NOT NULL,
    edit_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT workspace_database_cell_values_edit_revision_positive CHECK ((edit_revision > 0))
);


--
-- Name: workspace_database_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid NOT NULL,
    name text NOT NULL,
    field_type text NOT NULL,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    "position" integer NOT NULL,
    required boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    edit_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT workspace_database_fields_edit_revision_positive CHECK ((edit_revision > 0)),
    CONSTRAINT workspace_database_fields_field_type_check CHECK ((field_type = ANY (ARRAY['title'::text, 'text'::text, 'rich_text'::text, 'number'::text, 'percent'::text, 'currency'::text, 'duration'::text, 'checkbox'::text, 'date'::text, 'date_time'::text, 'files'::text, 'unique_id'::text, 'select'::text, 'multi_select'::text, 'tags'::text, 'status'::text, 'user'::text, 'users'::text, 'document_link'::text, 'relation'::text, 'rollup'::text, 'formula'::text, 'url'::text, 'email'::text, 'phone'::text, 'created_time'::text, 'created_by'::text, 'updated_time'::text, 'updated_by'::text]))),
    CONSTRAINT workspace_database_fields_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT workspace_database_fields_position_check CHECK (("position" >= 0))
);


--
-- Name: workspace_database_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid NOT NULL,
    doc_id uuid,
    "position" integer NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text NOT NULL,
    row_kind text DEFAULT 'record'::text NOT NULL,
    deleted_at timestamp with time zone,
    created_by_job_id uuid,
    edit_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT chk_workspace_database_rows_title_non_empty CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT workspace_database_rows_edit_revision_positive CHECK ((edit_revision > 0)),
    CONSTRAINT workspace_database_rows_position_check CHECK (("position" >= 0)),
    CONSTRAINT workspace_database_rows_row_kind_check CHECK ((row_kind = ANY (ARRAY['record'::text, 'task'::text, 'phase'::text, 'milestone'::text])))
);


--
-- Name: workspace_databases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_databases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    edit_revision bigint DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT workspace_databases_edit_revision_positive CHECK ((edit_revision > 0)),
    CONSTRAINT workspace_databases_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0))
);


--
-- Name: database_row_tag_references; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.database_row_tag_references AS
 SELECT database.workspace_id,
    "row".database_id,
    value.row_id,
    value.field_id,
    (reference.tag_id)::uuid AS tag_id,
    (reference."position")::integer AS "position"
   FROM ((((public.workspace_database_cell_values value
     JOIN public.workspace_database_rows "row" ON (("row".id = value.row_id)))
     JOIN public.workspace_databases database ON ((database.id = "row".database_id)))
     JOIN public.workspace_database_fields field ON (((field.id = value.field_id) AND (field.field_type = 'tags'::text))))
     CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN (jsonb_typeof(value.value_json) = 'array'::text) THEN value.value_json
            ELSE '[]'::jsonb
        END) WITH ORDINALITY reference(tag_id, "position"));


--
-- Name: database_unique_id_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_unique_id_sequences (
    database_id uuid NOT NULL,
    field_id uuid NOT NULL,
    next_value bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_unique_id_sequences_next_value_check CHECK ((next_value > 0))
);


--
-- Name: database_view_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_view_roles (
    database_id uuid NOT NULL,
    profile_kind text NOT NULL,
    role_key text NOT NULL,
    view_id uuid NOT NULL,
    required boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_view_roles_key_valid CHECK ((role_key = ANY (ARRAY['project.table'::text, 'project.kanban'::text, 'project.list'::text, 'project.progress'::text, 'project.calendar'::text, 'project.timeline'::text, 'project.gallery'::text]))),
    CONSTRAINT database_view_roles_profile_valid CHECK ((profile_kind = 'project'::text))
);


--
-- Name: database_view_user_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_view_user_states (
    view_id uuid NOT NULL,
    user_id uuid NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    sort_json jsonb,
    filter_tree_json jsonb,
    field_width_overrides_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    collapsed_group_keys_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    edit_revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT database_view_user_states_collapsed_groups_array CHECK ((jsonb_typeof(collapsed_group_keys_json) = 'array'::text)),
    CONSTRAINT database_view_user_states_revision_non_negative CHECK ((edit_revision >= 0)),
    CONSTRAINT database_view_user_states_widths_object CHECK ((jsonb_typeof(field_width_overrides_json) = 'object'::text))
);


--
-- Name: doc_audience_assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_audience_assignment (
    doc_id uuid NOT NULL,
    audience_id uuid NOT NULL,
    source text DEFAULT 'document'::text NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doc_audience_assignment_source_check CHECK ((source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])))
);


--
-- Name: doc_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_histories (
    id bigint NOT NULL,
    doc_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    snapshot bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doc_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.doc_histories ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.doc_histories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: doc_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_snapshots (
    doc_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    payload bytea NOT NULL,
    last_sequence bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doc_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_updates (
    id bigint NOT NULL,
    doc_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    payload bytea NOT NULL,
    sequence bigint NOT NULL,
    server_timestamp timestamp with time zone DEFAULT now() NOT NULL,
    payload_sha256 bytea
);


--
-- Name: doc_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.doc_updates ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.doc_updates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: doc_user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doc_user_permissions (
    user_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: docs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    userspace_owner_id uuid,
    title text DEFAULT ''::text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    blocked boolean DEFAULT false NOT NULL,
    is_workspace_root boolean DEFAULT false NOT NULL,
    public_mode text,
    default_role text DEFAULT 'viewer'::text NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    external_id text NOT NULL,
    status_id uuid,
    document_type_id uuid,
    classification_id uuid,
    retention_policy_id uuid,
    language_id uuid,
    responsible_user_id uuid,
    document_number text,
    review_due_at timestamp with time zone,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    journal_date date,
    current_version_id uuid,
    dirty_since_current_version boolean DEFAULT false NOT NULL,
    version_display_mode text DEFAULT 'show'::text NOT NULL,
    last_versioned_at timestamp with time zone,
    metadata_materialized_at timestamp with time zone,
    metadata_updated_at timestamp with time zone,
    metadata_updated_by uuid,
    metadata_revision bigint DEFAULT 0 NOT NULL,
    status_source text DEFAULT 'fallback'::text NOT NULL,
    document_type_source text DEFAULT 'fallback'::text NOT NULL,
    classification_source text DEFAULT 'fallback'::text NOT NULL,
    retention_policy_source text DEFAULT 'fallback'::text NOT NULL,
    language_source text DEFAULT 'fallback'::text NOT NULL,
    responsible_source text DEFAULT 'fallback'::text NOT NULL,
    audience_source text DEFAULT 'fallback'::text NOT NULL,
    sync_state_vector_v1 bytea,
    CONSTRAINT docs_check CHECK ((((workspace_id IS NOT NULL) AND (userspace_owner_id IS NULL)) OR ((workspace_id IS NULL) AND (userspace_owner_id IS NOT NULL)))),
    CONSTRAINT docs_document_metadata_valid_range_check CHECK (((valid_until IS NULL) OR (valid_from IS NULL) OR (valid_until >= valid_from))),
    CONSTRAINT docs_external_id_not_blank CHECK ((btrim(external_id) <> ''::text)),
    CONSTRAINT docs_metadata_revision_check CHECK ((metadata_revision >= 0)),
    CONSTRAINT docs_metadata_source_check CHECK (((status_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])) AND (document_type_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])) AND (classification_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])) AND (retention_policy_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])) AND (language_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])) AND (responsible_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])) AND (audience_source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text])))),
    CONSTRAINT docs_version_display_mode_check CHECK ((version_display_mode = ANY (ARRAY['show'::text, 'hide'::text, 'compact'::text])))
);


--
-- Name: document_audience_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_audience_definition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    color text,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_brand_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_brand_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    logo_large_asset_id uuid,
    logo_small_asset_id uuid,
    footer_text text,
    legal_text text,
    color_policy text DEFAULT 'theme_palette'::text NOT NULL,
    color_palette_key text,
    custom_primary_color text,
    custom_accent_color text,
    custom_rule_color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT document_brand_profiles_check CHECK ((((scope = 'global'::text) AND (workspace_id IS NULL)) OR ((scope = 'workspace'::text) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT document_brand_profiles_check1 CHECK ((((color_policy = 'theme_palette'::text) AND (color_palette_key IS NOT NULL)) OR ((color_policy = 'plain'::text) AND (color_palette_key = 'plain'::text)) OR ((color_policy = 'custom'::text) AND (custom_primary_color IS NOT NULL) AND (custom_accent_color IS NOT NULL)))),
    CONSTRAINT document_brand_profiles_color_palette_key_check CHECK (((color_palette_key IS NULL) OR (color_palette_key = ANY (ARRAY['balanced'::text, 'muted'::text, 'accent_line'::text, 'plain'::text])))),
    CONSTRAINT document_brand_profiles_color_policy_check CHECK ((color_policy = ANY (ARRAY['theme_palette'::text, 'plain'::text, 'custom'::text]))),
    CONSTRAINT document_brand_profiles_custom_accent_color_check CHECK (((custom_accent_color IS NULL) OR (custom_accent_color ~* '^#[0-9a-f]{6}$'::text))),
    CONSTRAINT document_brand_profiles_custom_primary_color_check CHECK (((custom_primary_color IS NULL) OR (custom_primary_color ~* '^#[0-9a-f]{6}$'::text))),
    CONSTRAINT document_brand_profiles_custom_rule_color_check CHECK (((custom_rule_color IS NULL) OR (custom_rule_color ~* '^#[0-9a-f]{6}$'::text))),
    CONSTRAINT document_brand_profiles_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'workspace'::text])))
);


--
-- Name: document_classification_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_classification_definition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    color text,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_graph_index_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_graph_index_state (
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    source_updated_at timestamp with time zone,
    indexed_at timestamp with time zone,
    queued_at timestamp with time zone,
    started_at timestamp with time zone,
    failed_at timestamp with time zone,
    stale_state text NOT NULL,
    error_code text,
    error_message text,
    attempt_count integer DEFAULT 0 NOT NULL,
    occurrence_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT document_graph_index_state_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT document_graph_index_state_occurrence_count_check CHECK ((occurrence_count >= 0)),
    CONSTRAINT document_graph_index_state_stale_state_check CHECK ((stale_state = ANY (ARRAY['current'::text, 'stale'::text, 'queued'::text, 'extracting'::text, 'failed'::text, 'deleted'::text])))
);


--
-- Name: document_graph_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_graph_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source_doc_id uuid NOT NULL,
    source_block_id text NOT NULL,
    source_parent_block_id text,
    source_parent_flavour text,
    raw_target_doc_id text NOT NULL,
    target_doc_id uuid,
    link_kind text NOT NULL,
    params_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    params_key text NOT NULL,
    markdown_preview text DEFAULT ''::text NOT NULL,
    target_state text NOT NULL,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    source_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_graph_occurrences_link_kind_check CHECK ((link_kind = ANY (ARRAY['inline_reference'::text, 'embed_linked_doc'::text, 'embed_synced_doc'::text, 'surface_ref'::text, 'database_cell_reference'::text]))),
    CONSTRAINT document_graph_occurrences_params_key_check CHECK ((length(params_key) > 0)),
    CONSTRAINT document_graph_occurrences_raw_target_doc_id_check CHECK ((length(raw_target_doc_id) > 0)),
    CONSTRAINT document_graph_occurrences_source_block_id_check CHECK ((length(source_block_id) > 0)),
    CONSTRAINT document_graph_occurrences_target_state_check CHECK ((target_state = ANY (ARRAY['available'::text, 'redacted'::text, 'deleted'::text, 'missing'::text, 'unresolved'::text])))
);


--
-- Name: document_initial_sync_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_initial_sync_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid,
    client_instance_id text,
    source_property_doc_revision text,
    idempotency_key text NOT NULL,
    provenance_mode text NOT NULL,
    received_at_server timestamp with time zone NOT NULL,
    resolution_kind text NOT NULL,
    decision_code text NOT NULL,
    raw_provenance jsonb NOT NULL,
    normalized_provenance jsonb NOT NULL,
    applied_created_at timestamp with time zone,
    applied_updated_at timestamp with time zone,
    applied_created_by uuid,
    applied_updated_by uuid,
    rejected_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_initial_sync_audit_provenance_mode_check CHECK ((provenance_mode = ANY (ARRAY['server_observed_first_sync'::text, 'offline_sync'::text, 'explicit_import'::text]))),
    CONSTRAINT document_initial_sync_audit_resolution_kind_check CHECK ((resolution_kind = ANY (ARRAY['created'::text, 'ignored_existing_document'::text])))
);


--
-- Name: document_integration_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_integration_state (
    doc_id uuid NOT NULL,
    integration_type text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_integration_state_integration_type_check CHECK ((length(TRIM(BOTH FROM integration_type)) > 0))
);


--
-- Name: document_metadata_field_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_metadata_field_definition (
    key text NOT NULL,
    category text NOT NULL,
    value_kind text NOT NULL,
    source_table text NOT NULL,
    is_system_fact boolean DEFAULT false NOT NULL,
    is_multi_value boolean DEFAULT false NOT NULL,
    organization_edit_role text,
    workspace_edit_role text,
    document_edit_role text,
    required_mode text DEFAULT 'never'::text NOT NULL,
    visible_in_header boolean DEFAULT false NOT NULL,
    visible_in_properties boolean DEFAULT true NOT NULL,
    visible_in_lists boolean DEFAULT true NOT NULL,
    export_mode text DEFAULT 'optional'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label text NOT NULL,
    storage_area text DEFAULT 'docs'::text NOT NULL,
    storage_field text NOT NULL,
    inheritance_mode text DEFAULT 'document_only'::text NOT NULL,
    source_column text,
    mutation_route text DEFAULT 'document_metadata'::text NOT NULL,
    projection_visibility text DEFAULT 'both'::text NOT NULL,
    CONSTRAINT document_metadata_field_definition_category_check CHECK ((category = ANY (ARRAY['system'::text, 'lifecycle'::text, 'classification'::text, 'responsibility'::text, 'retention'::text, 'audience'::text, 'template'::text, 'journal'::text, 'presentation'::text, 'integration'::text]))),
    CONSTRAINT document_metadata_field_definition_document_edit_role_check CHECK (((document_edit_role IS NULL) OR (document_edit_role = ANY (ARRAY['organization_admin'::text, 'workspace_admin'::text, 'document_manager'::text, 'document_editor'::text, 'responsible_user'::text, 'system_only'::text])))),
    CONSTRAINT document_metadata_field_definition_export_mode_check CHECK ((export_mode = ANY (ARRAY['hidden'::text, 'optional'::text, 'required'::text]))),
    CONSTRAINT document_metadata_field_definition_inheritance_mode_check CHECK ((inheritance_mode = ANY (ARRAY['inherited'::text, 'document_only'::text, 'relation_inherited'::text, 'system_readonly'::text, 'specialized_subsystem'::text]))),
    CONSTRAINT document_metadata_field_definition_mutation_route_check CHECK ((mutation_route = ANY (ARRAY['document_metadata'::text, 'status_transition'::text, 'readonly'::text, 'template_state'::text, 'journal_calendar'::text, 'presentation_setting'::text, 'integration_subsystem'::text, 'free_property_pass_through'::text]))),
    CONSTRAINT document_metadata_field_definition_organization_edit_role_check CHECK (((organization_edit_role IS NULL) OR (organization_edit_role = ANY (ARRAY['organization_admin'::text, 'system_only'::text])))),
    CONSTRAINT document_metadata_field_definition_projection_visibility_check CHECK ((projection_visibility = ANY (ARRAY['myoxus_native'::text, 'affine_legacy'::text, 'both'::text, 'none'::text]))),
    CONSTRAINT document_metadata_field_definition_required_mode_check CHECK ((required_mode = ANY (ARRAY['never'::text, 'always'::text, 'by_status'::text, 'by_type'::text, 'by_status_and_type'::text]))),
    CONSTRAINT document_metadata_field_definition_storage_area_check CHECK ((storage_area = ANY (ARRAY['docs'::text, 'relation_table'::text, 'system_fact'::text, 'template_state'::text, 'journal_calendar_subsystem'::text, 'presentation_setting'::text, 'integration_subsystem'::text, 'tag_free_property'::text]))),
    CONSTRAINT document_metadata_field_definition_value_kind_check CHECK ((value_kind = ANY (ARRAY['uuid'::text, 'text'::text, 'date'::text, 'timestamp'::text, 'boolean'::text, 'json'::text, 'relation'::text]))),
    CONSTRAINT document_metadata_field_definition_workspace_edit_role_check CHECK (((workspace_edit_role IS NULL) OR (workspace_edit_role = ANY (ARRAY['organization_admin'::text, 'workspace_admin'::text, 'system_only'::text]))))
);


--
-- Name: document_metadata_global_epoch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_metadata_global_epoch (
    epoch_name text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_metadata_global_epoch_name_check CHECK ((epoch_name = ANY (ARRAY['field_definition'::text, 'reference_values'::text]))),
    CONSTRAINT document_metadata_global_epoch_revision_check CHECK ((revision >= 0))
);


--
-- Name: document_presentation_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_presentation_state (
    doc_id uuid NOT NULL,
    primary_mode text,
    page_width text,
    edgeless_color_theme text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_presentation_state_edgeless_color_theme_check CHECK (((edgeless_color_theme IS NULL) OR (length(TRIM(BOTH FROM edgeless_color_theme)) > 0))),
    CONSTRAINT document_presentation_state_page_width_check CHECK (((page_width IS NULL) OR (page_width = ANY (ARRAY['standard'::text, 'fullWidth'::text])))),
    CONSTRAINT document_presentation_state_primary_mode_check CHECK (((primary_mode IS NULL) OR (primary_mode = ANY (ARRAY['page'::text, 'edgeless'::text]))))
);


--
-- Name: document_retention_policy_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_retention_policy_definition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    color text,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_status_schema; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_status_schema (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    complexity text NOT NULL,
    is_preset boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_status_schema_complexity_check CHECK ((complexity = ANY (ARRAY['simple'::text, 'review'::text, 'controlled'::text, 'custom'::text])))
);


--
-- Name: document_status_transition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_status_transition (
    from_status_id uuid NOT NULL,
    to_status_id uuid NOT NULL,
    required_roles text[] DEFAULT '{}'::text[] NOT NULL,
    required_metadata_fields text[] DEFAULT '{}'::text[] NOT NULL,
    creates_version text DEFAULT 'never'::text NOT NULL,
    sets_version_kind text,
    date_enforcement text DEFAULT 'warn'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT document_status_transition_creates_version_check CHECK ((creates_version = ANY (ARRAY['never'::text, 'optional'::text, 'required'::text]))),
    CONSTRAINT document_status_transition_date_enforcement_check CHECK ((date_enforcement = ANY (ARRAY['warn'::text, 'block_transition'::text, 'block_export'::text]))),
    CONSTRAINT document_status_transition_kind_check CHECK (((sets_version_kind IS NULL) OR (sets_version_kind = ANY (ARRAY['checkpoint'::text, 'milestone'::text, 'published'::text, 'exported'::text, 'restored'::text]))))
);


--
-- Name: document_status_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_status_value (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schema_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    color text,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    terminal boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: document_template_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_template_state (
    doc_id uuid NOT NULL,
    template_id uuid,
    revision_id uuid,
    instance_id uuid,
    state text DEFAULT 'none'::text NOT NULL,
    source text DEFAULT 'document'::text NOT NULL,
    materialized_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_template_state_source_check CHECK ((source = ANY (ARRAY['document'::text, 'workspace'::text, 'organization'::text, 'fallback'::text]))),
    CONSTRAINT document_template_state_state_check CHECK ((state = ANY (ARRAY['none'::text, 'seeded'::text, 'managed'::text, 'detached'::text, 'retired'::text])))
);


--
-- Name: document_theme_color_palettes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_theme_color_palettes (
    theme_id uuid NOT NULL,
    palette_key text NOT NULL,
    name text NOT NULL,
    primary_color text NOT NULL,
    accent_color text NOT NULL,
    rule_color text NOT NULL,
    text_color text NOT NULL,
    background_color text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_theme_color_palettes_accent_color_check CHECK ((accent_color ~* '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT document_theme_color_palettes_background_color_check CHECK ((background_color ~* '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT document_theme_color_palettes_palette_key_check CHECK ((palette_key = ANY (ARRAY['balanced'::text, 'muted'::text, 'accent_line'::text, 'plain'::text]))),
    CONSTRAINT document_theme_color_palettes_primary_color_check CHECK ((primary_color ~* '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT document_theme_color_palettes_rule_color_check CHECK ((rule_color ~* '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT document_theme_color_palettes_text_color_check CHECK ((text_color ~* '^#[0-9a-f]{6}$'::text))
);


--
-- Name: document_type_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_type_definition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    icon text,
    color text,
    is_active boolean DEFAULT true NOT NULL,
    is_suggested boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_type_status_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_type_status_default (
    document_type_id uuid NOT NULL,
    status_schema_id uuid NOT NULL,
    status_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    doc_history_id bigint NOT NULL,
    label text NOT NULL,
    description text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    version_no bigint NOT NULL,
    event text DEFAULT 'manual'::text NOT NULL,
    kind text DEFAULT 'checkpoint'::text NOT NULL,
    is_protected boolean DEFAULT false NOT NULL,
    policy_id uuid,
    policy_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_hash text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone,
    CONSTRAINT document_version_event_check CHECK ((event = ANY (ARRAY['manual'::text, 'publish'::text, 'pdf_export'::text, 'daily'::text, 'api'::text, 'restore'::text]))),
    CONSTRAINT document_version_kind_check CHECK ((kind = ANY (ARRAY['checkpoint'::text, 'milestone'::text, 'published'::text, 'exported'::text, 'restored'::text])))
);


--
-- Name: document_version_artifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_version_artifact (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version_id uuid NOT NULL,
    artifact_kind text NOT NULL,
    source_job_id uuid,
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint,
    checksum_sha256 text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT document_version_artifact_kind_check CHECK ((artifact_kind = ANY (ARRAY['pdf'::text, 'html'::text, 'zip'::text, 'signed_pdf'::text]))),
    CONSTRAINT document_version_artifact_size_check CHECK (((size_bytes IS NULL) OR (size_bytes >= 0)))
);


--
-- Name: document_version_label_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_version_label_counter (
    doc_id uuid NOT NULL,
    counter_key text NOT NULL,
    next_value bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_version_label_counter_next_value_check CHECK ((next_value >= 1))
);


--
-- Name: document_version_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_version_policy (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    enabled_by_default boolean DEFAULT false NOT NULL,
    scheme_preset text DEFAULT 'simple_counter'::text NOT NULL,
    custom_pattern text,
    timezone_mode text DEFAULT 'utc'::text NOT NULL,
    auto_version_on text[] DEFAULT '{}'::text[] NOT NULL,
    retention_count integer DEFAULT 10 NOT NULL,
    pin_manual_versions boolean DEFAULT false NOT NULL,
    pin_publish_versions boolean DEFAULT true NOT NULL,
    published_versions_protected boolean DEFAULT true NOT NULL,
    export_versions_protected boolean DEFAULT false NOT NULL,
    metadata_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_version_policy_retention_count_check CHECK (((retention_count >= 1) AND (retention_count <= 500))),
    CONSTRAINT document_version_policy_scheme_preset_check CHECK ((scheme_preset = ANY (ARRAY['simple_counter'::text, 'date_counter'::text, 'event_counter'::text, 'semver_manual'::text, 'custom_pattern'::text]))),
    CONSTRAINT document_version_policy_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'workspace'::text, 'doc_template'::text]))),
    CONSTRAINT document_version_policy_timezone_mode_check CHECK ((timezone_mode = ANY (ARRAY['utc'::text, 'workspace'::text, 'user'::text])))
);


--
-- Name: document_version_relation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_version_relation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_version_id uuid NOT NULL,
    to_version_id uuid NOT NULL,
    relation text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT document_version_relation_not_self_check CHECK ((from_version_id <> to_version_id)),
    CONSTRAINT document_version_relation_relation_check CHECK ((relation = ANY (ARRAY['restored_from'::text, 'supersedes'::text, 'derived_from'::text, 'exported_as'::text, 'reviewed_by'::text, 'approved_from'::text, 'translated_from'::text])))
);


--
-- Name: document_versioning_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versioning_settings (
    doc_id uuid NOT NULL,
    auto_version_on text[] DEFAULT '{}'::text[] NOT NULL,
    retention_count integer DEFAULT 10 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    policy_id uuid,
    enabled_override boolean,
    auto_version_on_override text[],
    retention_count_override integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_versioning_settings_retention_override_check CHECK (((retention_count_override IS NULL) OR ((retention_count_override >= 1) AND (retention_count_override <= 500))))
);


--
-- Name: document_versioning_workspace_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versioning_workspace_settings (
    workspace_id uuid NOT NULL,
    auto_version_on text[],
    retention_count integer,
    enabled boolean,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_versioning_workspace_settings_retention_count_check CHECK (((retention_count IS NULL) OR ((retention_count >= 1) AND (retention_count <= 50))))
);


--
-- Name: document_workspace_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_workspace_settings (
    workspace_id uuid NOT NULL,
    status_schema_id uuid,
    default_document_type_id uuid,
    default_classification_id uuid,
    default_retention_policy_id uuid,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version_policy_id uuid,
    default_status_id uuid,
    default_language_id uuid,
    default_responsible_user_id uuid,
    metadata_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT document_workspace_settings_default_status_requires_schema CHECK (((default_status_id IS NULL) OR (status_schema_id IS NOT NULL))),
    CONSTRAINT document_workspace_settings_metadata_revision_check CHECK ((metadata_revision >= 0))
);


--
-- Name: font_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.font_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_id uuid NOT NULL,
    usage text NOT NULL,
    format text NOT NULL,
    style text DEFAULT 'normal'::text NOT NULL,
    weight_min integer NOT NULL,
    weight_max integer NOT NULL,
    weight_default integer NOT NULL,
    asset_key text NOT NULL,
    sha256 text NOT NULL,
    mime text NOT NULL,
    unicode_ranges jsonb DEFAULT '[]'::jsonb NOT NULL,
    subset_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT font_assets_check CHECK (((weight_min <= weight_default) AND (weight_default <= weight_max))),
    CONSTRAINT font_assets_format_check CHECK ((format = ANY (ARRAY['woff2'::text, 'ttf'::text, 'otf'::text, 'variable_ttf'::text]))),
    CONSTRAINT font_assets_usage_check CHECK ((usage = ANY (ARRAY['web'::text, 'pdf'::text]))),
    CONSTRAINT font_assets_weight_default_check CHECK (((weight_default >= 1) AND (weight_default <= 1000))),
    CONSTRAINT font_assets_weight_max_check CHECK (((weight_max >= 1) AND (weight_max <= 1000))),
    CONSTRAINT font_assets_weight_min_check CHECK (((weight_min >= 1) AND (weight_min <= 1000)))
);


--
-- Name: font_families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.font_families (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    css_family text NOT NULL,
    generic_class text NOT NULL,
    source text NOT NULL,
    license_spdx text NOT NULL,
    license_status text DEFAULT 'pending'::text NOT NULL,
    is_selectable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT font_families_generic_class_check CHECK ((generic_class = ANY (ARRAY['sans'::text, 'semi_sans'::text, 'serif'::text, 'slab'::text, 'mono'::text, 'display'::text, 'handwriting'::text, 'symbol'::text]))),
    CONSTRAINT font_families_license_status_check CHECK ((license_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT font_families_source_check CHECK ((source = ANY (ARRAY['bundled'::text, 'uploaded'::text])))
);


--
-- Name: git_sync_baselines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_baselines (
    binding_id uuid NOT NULL,
    content_hash text NOT NULL,
    commit_oid text NOT NULL,
    myoxus_updated_at timestamp with time zone NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: git_sync_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    sync_id uuid NOT NULL,
    repo_path text NOT NULL,
    last_commit_oid text,
    content_hash text,
    structure_hash text,
    tombstone boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: git_sync_blob_promotions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_blob_promotions (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    stage_key text NOT NULL,
    final_key text NOT NULL,
    newly_promoted boolean,
    db_committed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT git_sync_blob_promotions_check CHECK (((btrim(stage_key) <> ''::text) AND (btrim(final_key) <> ''::text)))
);


--
-- Name: git_sync_bootstrap_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_bootstrap_attempts (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    phase text NOT NULL,
    expected_remote_oid text NOT NULL,
    observed_remote_oid text,
    desired_tree_fingerprint text NOT NULL,
    report jsonb NOT NULL,
    error_class text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT git_sync_bootstrap_attempts_check CHECK (((phase = 'Completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT git_sync_bootstrap_attempts_check1 CHECK (((phase <> 'RemoteApplied'::text) OR (observed_remote_oid IS NOT NULL))),
    CONSTRAINT git_sync_bootstrap_attempts_phase_check CHECK ((phase = ANY (ARRAY['Prepared'::text, 'RemoteApplied'::text, 'Completed'::text, 'Failed'::text])))
);


--
-- Name: git_sync_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_conflicts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    binding_id uuid,
    doc_id uuid NOT NULL,
    repo_path text NOT NULL,
    conflict_type text NOT NULL,
    resolution text DEFAULT 'Open'::text NOT NULL,
    base_content text,
    myoxus_content text,
    git_content text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    CONSTRAINT chk_conflict_type CHECK ((conflict_type = ANY (ARRAY['BothModified'::text, 'DeleteVsModify'::text, 'ModifyVsDelete'::text, 'RenameVsRename'::text, 'RenameVsModify'::text]))),
    CONSTRAINT chk_resolution CHECK ((resolution = ANY (ARRAY['Open'::text, 'MyoxusWins'::text, 'GitWins'::text, 'ManualMerge'::text, 'Dismissed'::text])))
);


--
-- Name: git_sync_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    auth_method text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    encrypted_data bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: git_sync_file_baselines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_file_baselines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    blob_key text NOT NULL,
    content_hash text NOT NULL,
    commit_oid text,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: git_sync_file_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_file_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    blob_key text NOT NULL,
    repo_path text NOT NULL,
    content_hash text NOT NULL,
    mime_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    file_size bigint DEFAULT 0 NOT NULL,
    tombstoned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: git_sync_file_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_file_conflicts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    run_id uuid NOT NULL,
    repo_path text NOT NULL,
    conflict_type text DEFAULT 'BothModified'::text NOT NULL,
    resolution text DEFAULT 'Open'::text NOT NULL,
    git_hash text,
    myoxus_hash text,
    baseline_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    binding_id uuid,
    blob_key text,
    CONSTRAINT chk_file_conflict_type CHECK ((conflict_type = ANY (ARRAY['BothModified'::text, 'DeleteVsModify'::text, 'ModifyVsDelete'::text, 'RenameVsRename'::text, 'RenameVsModify'::text]))),
    CONSTRAINT chk_file_resolution CHECK ((resolution = ANY (ARRAY['Open'::text, 'MyoxusWins'::text, 'GitWins'::text, 'ManualMerge'::text, 'Dismissed'::text])))
);


--
-- Name: git_sync_partial_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_partial_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    item_kind text NOT NULL,
    item_key text NOT NULL,
    doc_id uuid,
    repo_path text,
    sort_key text NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_run_id uuid,
    error_class text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT git_sync_partial_items_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT git_sync_partial_items_error_class_check CHECK (((error_class IS NULL) OR (error_class = ANY (ARRAY['GitAuth'::text, 'GitNetwork'::text, 'GitConflict'::text, 'ImportError'::text, 'ExportError'::text, 'InternalError'::text])))),
    CONSTRAINT git_sync_partial_items_identity_check CHECK ((((item_kind = 'Doc'::text) AND (doc_id IS NOT NULL)) OR ((item_kind = 'GitMarkdown'::text) AND (repo_path IS NOT NULL)))),
    CONSTRAINT git_sync_partial_items_kind_check CHECK ((item_kind = ANY (ARRAY['Doc'::text, 'GitMarkdown'::text]))),
    CONSTRAINT git_sync_partial_items_status_check CHECK ((status = ANY (ARRAY['Pending'::text, 'Running'::text, 'Completed'::text, 'Failed'::text, 'Conflicted'::text])))
);


--
-- Name: git_sync_partial_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_partial_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    direction text NOT NULL,
    source_workspace_watermark timestamp with time zone,
    source_git_commit_oid text,
    status text DEFAULT 'Open'::text NOT NULL,
    total_items integer DEFAULT 0 NOT NULL,
    processed_items integer DEFAULT 0 NOT NULL,
    failed_items integer DEFAULT 0 NOT NULL,
    created_run_id uuid NOT NULL,
    last_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT git_sync_partial_sessions_counts_check CHECK (((total_items >= 0) AND (processed_items >= 0) AND (failed_items >= 0) AND (processed_items <= total_items) AND (failed_items <= total_items))),
    CONSTRAINT git_sync_partial_sessions_direction_check CHECK ((direction = ANY (ARRAY['Bidirectional'::text, 'MyoxusToGit'::text, 'GitToMyoxus'::text]))),
    CONSTRAINT git_sync_partial_sessions_status_check CHECK ((status = ANY (ARRAY['Open'::text, 'Completed'::text, 'CompletedWithFailures'::text, 'Cancelled'::text])))
);


--
-- Name: git_sync_path_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_path_owners (
    profile_id uuid NOT NULL,
    repo_path text NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT git_sync_path_owners_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['document'::text, 'file'::text])))
);


--
-- Name: git_sync_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    repo_url text NOT NULL,
    branch text DEFAULT 'main'::text NOT NULL,
    root_path text DEFAULT 'content/'::text NOT NULL,
    sync_direction text DEFAULT 'Bidirectional'::text NOT NULL,
    trigger_mode text DEFAULT 'Manual'::text NOT NULL,
    polling_interval_secs bigint,
    auth_method text DEFAULT 'HttpsToken'::text NOT NULL,
    credential_id uuid,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    max_mirror_storage_mb bigint,
    cron_expression text,
    cron_timezone text,
    cron_misfire_policy text,
    cron_next_scheduled_at timestamp with time zone,
    cron_pending_misfire_scheduled_for timestamp with time zone,
    CONSTRAINT chk_auth_method CHECK ((auth_method = ANY (ARRAY['SshKey'::text, 'HttpsToken'::text, 'HttpsPassword'::text]))),
    CONSTRAINT chk_direction CHECK ((sync_direction = ANY (ARRAY['MyoxusToGit'::text, 'GitToMyoxus'::text, 'Bidirectional'::text]))),
    CONSTRAINT git_sync_profiles_cron_contract CHECK ((((trigger_mode = 'Cron'::text) AND (cron_expression IS NOT NULL) AND (length(TRIM(BOTH FROM cron_expression)) > 0) AND (cron_timezone IS NOT NULL) AND (length(TRIM(BOTH FROM cron_timezone)) > 0) AND (cron_misfire_policy = ANY (ARRAY['Skip'::text, 'RunOnce'::text])) AND ((enabled = false) OR (cron_next_scheduled_at IS NOT NULL))) OR ((trigger_mode <> 'Cron'::text) AND (cron_expression IS NULL) AND (cron_timezone IS NULL) AND (cron_misfire_policy IS NULL) AND (cron_next_scheduled_at IS NULL) AND (cron_pending_misfire_scheduled_for IS NULL)))),
    CONSTRAINT git_sync_profiles_polling_interval_check CHECK (((trigger_mode <> 'Polling'::text) OR (enabled = false) OR (COALESCE(polling_interval_secs, (0)::bigint) > 0)))
);


--
-- Name: git_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    direction text NOT NULL,
    status text DEFAULT 'Pending'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    commit_before text,
    commit_after text,
    docs_created integer DEFAULT 0 NOT NULL,
    docs_updated integer DEFAULT 0 NOT NULL,
    docs_deleted integer DEFAULT 0 NOT NULL,
    conflicts_found integer DEFAULT 0 NOT NULL,
    error_message text,
    error_class text,
    job_id text,
    trigger_source text DEFAULT 'Manual'::text NOT NULL,
    observed_remote_oid text,
    reconciliation_required boolean DEFAULT false NOT NULL,
    reconciliation_reason text,
    scheduled_for timestamp with time zone,
    CONSTRAINT chk_run_status CHECK ((status = ANY (ARRAY['Pending'::text, 'Running'::text, 'Completed'::text, 'Failed'::text, 'Cancelled'::text]))),
    CONSTRAINT git_sync_runs_reconciliation_complete CHECK (((reconciliation_required = false) OR ((status = 'Failed'::text) AND (observed_remote_oid IS NOT NULL) AND (btrim(observed_remote_oid) <> ''::text) AND (reconciliation_reason IS NOT NULL) AND (btrim(reconciliation_reason) <> ''::text)))),
    CONSTRAINT git_sync_runs_running_job_identity CHECK (((status <> 'Running'::text) OR ((job_id IS NOT NULL) AND (btrim(job_id) <> ''::text)))),
    CONSTRAINT git_sync_runs_scheduled_source_check CHECK (((trigger_source = 'Cron'::text) = (scheduled_for IS NOT NULL))),
    CONSTRAINT git_sync_runs_trigger_source_check CHECK ((trigger_source = ANY (ARRAY['Manual'::text, 'Polling'::text, 'Webhook'::text, 'Cron'::text]))),
    CONSTRAINT git_sync_runs_verified_terminal_revision CHECK ((((status = 'Completed'::text) AND (commit_after IS NOT NULL) AND (btrim(commit_after) <> ''::text) AND (observed_remote_oid = commit_after) AND (reconciliation_required = false)) OR ((status <> 'Completed'::text) AND (commit_after IS NULL))))
);


--
-- Name: git_sync_ssh_host_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_ssh_host_keys (
    host text NOT NULL,
    port integer DEFAULT 22 NOT NULL,
    key_type text NOT NULL,
    fingerprint_sha256 text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'sync_run'::text NOT NULL,
    created_by uuid,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT git_sync_ssh_host_keys_fingerprint_not_empty CHECK ((btrim(fingerprint_sha256) <> ''::text)),
    CONSTRAINT git_sync_ssh_host_keys_host_not_empty CHECK ((btrim(host) <> ''::text)),
    CONSTRAINT git_sync_ssh_host_keys_key_type_not_empty CHECK ((btrim(key_type) <> ''::text)),
    CONSTRAINT git_sync_ssh_host_keys_port_valid CHECK (((port > 0) AND (port <= 65535)))
);


--
-- Name: git_sync_version_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_version_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    run_id uuid NOT NULL,
    sync_object_kind text NOT NULL,
    sync_object_id text NOT NULL,
    direction text NOT NULL,
    git_commit_oid text,
    myoxus_history_id uuid,
    repo_path text NOT NULL,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_link_direction CHECK ((direction = ANY (ARRAY['push'::text, 'pull'::text]))),
    CONSTRAINT chk_object_kind CHECK ((sync_object_kind = ANY (ARRAY['doc'::text, 'file'::text])))
);


--
-- Name: git_sync_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_sync_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    dedupe_key text NOT NULL,
    delivery_id text,
    payload_hash text NOT NULL,
    provider text,
    event_name text,
    ref_name text,
    accepted boolean DEFAULT false NOT NULL,
    run_id uuid,
    rejection_reason text,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: language_definition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.language_definition (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    native_label text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: magic_link_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.magic_link_otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    otp_hash text NOT NULL,
    client_nonce text,
    attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verification_token_id uuid
);


--
-- Name: mcp_idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_idempotency_keys (
    id uuid NOT NULL,
    api_key_id uuid NOT NULL,
    user_id uuid NOT NULL,
    tool_name text NOT NULL,
    idempotency_key text NOT NULL,
    payload_sha256 text NOT NULL,
    response_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: metrics_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrics_daily (
    day date NOT NULL,
    category text NOT NULL,
    metric_name text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    sum double precision NOT NULL,
    count bigint NOT NULL
);


--
-- Name: metrics_raw; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrics_raw (
    id bigint NOT NULL,
    minute timestamp with time zone NOT NULL,
    category text NOT NULL,
    metric_name text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    value double precision NOT NULL
);


--
-- Name: metrics_raw_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metrics_raw_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metrics_raw_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metrics_raw_id_seq OWNED BY public.metrics_raw.id;


--
-- Name: multipart_blob_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multipart_blob_parts (
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    upload_id text NOT NULL,
    part_number integer NOT NULL,
    etag text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: multipart_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.multipart_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    upload_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    notification_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notification_level text DEFAULT 'default'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key text
);


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_document_audience_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_document_audience_default (
    organization_id uuid NOT NULL,
    audience_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: organization_document_metadata_epoch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_document_metadata_epoch (
    organization_id uuid NOT NULL,
    epoch_name text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_document_metadata_epoch_name_check CHECK ((epoch_name = ANY (ARRAY['policy'::text, 'defaults'::text]))),
    CONSTRAINT organization_document_metadata_epoch_revision_check CHECK ((revision >= 0))
);


--
-- Name: organization_document_metadata_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_document_metadata_policy (
    organization_id uuid NOT NULL,
    field_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    required_mode text,
    visible_in_header boolean,
    visible_in_properties boolean,
    visible_in_lists boolean,
    export_mode text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_document_metadata_policy_export_mode_check CHECK (((export_mode IS NULL) OR (export_mode = ANY (ARRAY['hidden'::text, 'optional'::text, 'required'::text])))),
    CONSTRAINT organization_document_metadata_policy_required_mode_check CHECK (((required_mode IS NULL) OR (required_mode = ANY (ARRAY['never'::text, 'always'::text, 'by_status'::text, 'by_type'::text, 'by_status_and_type'::text]))))
);


--
-- Name: organization_document_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_document_settings (
    organization_id uuid NOT NULL,
    status_schema_id uuid,
    default_status_id uuid,
    default_document_type_id uuid,
    default_classification_id uuid,
    default_retention_policy_id uuid,
    default_language_id uuid,
    default_responsible_user_id uuid,
    metadata_revision bigint DEFAULT 0 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_document_settings_default_status_requires_schema CHECK (((default_status_id IS NULL) OR (status_schema_id IS NOT NULL))),
    CONSTRAINT organization_document_settings_metadata_revision_check CHECK ((metadata_revision >= 0))
);


--
-- Name: organization_identity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_identity (
    id boolean DEFAULT true NOT NULL,
    legal_name text,
    display_name text,
    short_name text,
    jurisdiction text,
    website_url text,
    contact_email text,
    address_lines jsonb DEFAULT '[]'::jsonb NOT NULL,
    tax_id text,
    registration_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT organization_identity_id_check CHECK (id)
);


--
-- Name: organization_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_policy (
    organization_id uuid NOT NULL,
    manager_root_project_creation public.organization_policy_state DEFAULT 'requires_approval'::public.organization_policy_state NOT NULL,
    manager_unit_project_creation public.organization_policy_state DEFAULT 'allowed'::public.organization_policy_state NOT NULL,
    manager_can_create_workspaces boolean DEFAULT true NOT NULL,
    manager_can_manage_ou_members boolean DEFAULT true NOT NULL,
    import_export_enabled boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_project_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_project_request (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    requested_scope public.organization_project_request_scope NOT NULL,
    parent_unit_id uuid,
    proposed_name text NOT NULL,
    proposed_type_id uuid,
    proposed_members uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    proposed_workspace boolean DEFAULT false NOT NULL,
    status public.organization_project_request_status DEFAULT 'pending'::public.organization_project_request_status NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_unit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_unit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    parent_unit_id uuid,
    unit_type_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    status public.organization_unit_status DEFAULT 'active'::public.organization_unit_status NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    max_members integer DEFAULT 25 NOT NULL,
    CONSTRAINT organization_unit_max_members_check CHECK ((max_members >= 1))
);


--
-- Name: organization_unit_member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_unit_member (
    unit_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.organization_unit_role NOT NULL,
    source public.organization_unit_member_source DEFAULT 'manual'::public.organization_unit_member_source NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_unit_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_unit_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    icon text,
    color text,
    is_preset boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_structural boolean NOT NULL,
    can_have_children boolean NOT NULL,
    can_be_root_level boolean NOT NULL,
    can_be_manager_created boolean NOT NULL,
    can_have_cross_unit_members boolean NOT NULL,
    can_own_workspaces boolean NOT NULL,
    can_manage_workspaces boolean NOT NULL,
    is_staff_unit boolean DEFAULT false NOT NULL,
    requires_admin_approval boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization_unit_workspace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_unit_workspace (
    unit_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    relationship public.organization_unit_workspace_relationship NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT chk_outbox_events_event_type CHECK ((event_type = ANY (ARRAY['mention'::text, 'invite'::text, 'comment_reply'::text, 'access_change'::text, 'doc_updated'::text, 'workspace_doc_broadcast'::text, 'workspace_content_published'::text])))
);


--
-- Name: pdf_export_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_export_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    template_id text DEFAULT 'default'::text NOT NULL,
    render_inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    options_hash text NOT NULL,
    status public.pdf_export_status DEFAULT 'queued'::public.pdf_export_status NOT NULL,
    sync_or_async text DEFAULT 'async'::text NOT NULL,
    output_blob_id uuid,
    error_class text,
    error_detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    expires_at timestamp with time zone,
    page_count integer,
    unmapped_font_families jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: pdf_export_render_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_export_render_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    doc_version_label text,
    template_id uuid,
    template_version text NOT NULL,
    render_appearance_hash text NOT NULL,
    locale text NOT NULL,
    classification text,
    l3_inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    document_version_id uuid,
    document_metadata_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_validation jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: pdf_export_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_export_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    default_template_id uuid,
    default_paper_size text,
    default_locale text,
    default_color_profile_id uuid,
    default_image_quality text,
    ligatures_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pdf_export_settings_check CHECK ((((scope = 'global'::text) AND (workspace_id IS NULL)) OR ((scope = 'workspace'::text) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT pdf_export_settings_default_image_quality_check CHECK (((default_image_quality IS NULL) OR (default_image_quality = ANY (ARRAY['low'::text, 'med'::text, 'high'::text, 'lossless'::text])))),
    CONSTRAINT pdf_export_settings_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'workspace'::text])))
);


--
-- Name: pdf_fonts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_fonts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    family_name text NOT NULL,
    style text NOT NULL,
    weight integer NOT NULL,
    blob_key text NOT NULL,
    sha256 text NOT NULL,
    license text NOT NULL,
    license_status text DEFAULT 'pending'::text NOT NULL,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT pdf_fonts_license_status_check CHECK ((license_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: pdf_icc_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_icc_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    profile_type text NOT NULL,
    blob_key text NOT NULL,
    sha256 text NOT NULL,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pdf_icc_profiles_profile_type_check CHECK ((profile_type = ANY (ARRAY['sRGB'::text, 'CMYK'::text])))
);


--
-- Name: pdf_template_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_template_files (
    template_id uuid NOT NULL,
    file_path text NOT NULL,
    blob_key text NOT NULL,
    content_hash text NOT NULL
);


--
-- Name: pdf_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    version text NOT NULL,
    schema_version text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: pdf_workspace_template_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_workspace_template_assignments (
    workspace_id uuid NOT NULL,
    template_id uuid NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: public_asset_manifest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_asset_manifest (
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    asset_hash text NOT NULL,
    filename text NOT NULL,
    blob_key text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    last_modified timestamp with time zone,
    cache_control text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: public_render_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_render_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    doc_id uuid,
    source_hash text NOT NULL,
    renderer_version text NOT NULL,
    theme_version text NOT NULL,
    noindex boolean DEFAULT false NOT NULL,
    asset_manifest jsonb DEFAULT '[]'::jsonb NOT NULL,
    rendered_html text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: search_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_content (
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    plain_text text DEFAULT ''::text NOT NULL,
    search_vector tsvector,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_tags jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: search_reindex_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_reindex_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    mode text NOT NULL,
    status text NOT NULL,
    cursor_updated_at timestamp with time zone,
    cursor_doc_id uuid,
    processed_count bigint DEFAULT 0 NOT NULL,
    indexed_count bigint DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    error_message text,
    CONSTRAINT search_reindex_runs_mode_check CHECK ((mode = ANY (ARRAY['full'::text, 'incremental'::text]))),
    CONSTRAINT search_reindex_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: session_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_links (
    session_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    csrf_token text,
    user_agent text,
    ip_address inet,
    expires_at timestamp with time zone NOT NULL,
    refresh_after timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telemetry_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry_daily (
    day date NOT NULL,
    category text NOT NULL,
    event_name text NOT NULL,
    count bigint NOT NULL,
    unique_users bigint NOT NULL,
    unique_sessions bigint NOT NULL
);


--
-- Name: telemetry_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id text NOT NULL,
    event_name text NOT NULL,
    category text NOT NULL,
    user_id uuid,
    client_id text,
    session_id text,
    schema_version smallint NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    user_properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_timestamp timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: template_catalog_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_catalog_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    source text DEFAULT 'bundle'::text NOT NULL,
    builder_version integer,
    min_client_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT chk_template_source_builder_version_consistency CHECK ((((source = 'bundle'::text) AND (builder_version IS NULL)) OR ((source = 'builtin'::text) AND (builder_version IS NOT NULL)))),
    CONSTRAINT template_catalog_entries_source_check CHECK ((source = ANY (ARRAY['bundle'::text, 'builtin'::text]))),
    CONSTRAINT template_catalog_entries_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'archived'::text])))
);


--
-- Name: template_default_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_default_policies (
    template_id uuid NOT NULL,
    apply_to_new_workspaces boolean DEFAULT true NOT NULL,
    selection_mode text DEFAULT 'published'::text NOT NULL,
    provisioning_mode text DEFAULT 'managed_until_local_edit'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT template_default_policies_provisioning_mode_check CHECK ((provisioning_mode = ANY (ARRAY['seed_once'::text, 'managed_until_local_edit'::text, 'manual_update'::text]))),
    CONSTRAINT template_default_policies_selection_mode_check CHECK ((selection_mode = ANY (ARRAY['published'::text, 'pinned_revision'::text])))
);


--
-- Name: template_import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_import_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploaded_blob_id text,
    result_revision_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    validation_report_json jsonb,
    created_by uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT template_import_jobs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'validating'::text, 'importing'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: template_reconcile_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_reconcile_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text DEFAULT 'workspace'::text NOT NULL,
    workspace_id uuid,
    template_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    summary_json jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT template_reconcile_jobs_scope_check CHECK ((scope = ANY (ARRAY['workspace'::text, 'template'::text, 'global'::text]))),
    CONSTRAINT template_reconcile_jobs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: template_registry_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_registry_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid,
    template_id uuid,
    revision_id uuid,
    workspace_id uuid,
    policy_id uuid,
    instance_id uuid,
    import_job_id uuid,
    source_format text,
    detected_format text,
    normalizer_version text,
    ignored_entries_count integer,
    error_catalog_version text,
    error_code text,
    payload_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT template_registry_audit_events_action_check CHECK ((action = ANY (ARRAY['created'::text, 'updated'::text, 'deleted'::text, 'imported'::text, 'validated'::text, 'published'::text, 'assigned'::text, 'reconciled'::text, 'scanned'::text, 'detached'::text, 'exported'::text, 'failed'::text]))),
    CONSTRAINT template_registry_audit_events_ignored_entries_count_non_negati CHECK (((ignored_entries_count IS NULL) OR (ignored_entries_count >= 0)))
);


--
-- Name: template_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    version text NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    bundle_blob_id text,
    preview_blob_id text,
    checksum text,
    manifest_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    release_notes text DEFAULT ''::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    source_format text DEFAULT 'legacy_unknown'::text NOT NULL,
    normalizer_version text DEFAULT 'none'::text NOT NULL,
    detected_format text DEFAULT 'unknown'::text NOT NULL,
    ignored_entries_count integer DEFAULT 0 NOT NULL,
    error_catalog_version text DEFAULT 'unknown'::text NOT NULL,
    normalization_warnings_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT template_revisions_ignored_entries_count_non_negative CHECK ((ignored_entries_count >= 0)),
    CONSTRAINT template_revisions_normalization_warnings_json_is_array CHECK ((jsonb_typeof(normalization_warnings_json) = 'array'::text)),
    CONSTRAINT template_revisions_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'validated'::text, 'published'::text, 'deprecated'::text, 'archived'::text])))
);


--
-- Name: theme_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.theme_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scope text NOT NULL,
    workspace_id uuid,
    theme_id uuid NOT NULL,
    theme_mode text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT theme_profiles_check CHECK ((((scope = 'global'::text) AND (workspace_id IS NULL)) OR ((scope = 'workspace'::text) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT theme_profiles_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'workspace'::text]))),
    CONSTRAINT theme_profiles_theme_mode_check CHECK ((theme_mode = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text])))
);


--
-- Name: themes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.themes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    origin text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    color_schema_id uuid NOT NULL,
    typography_id uuid NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category text,
    preview_group text,
    preview_order integer DEFAULT 0 NOT NULL,
    tagline_key text,
    description_key text,
    CONSTRAINT themes_origin_check CHECK ((origin = ANY (ARRAY['system'::text, 'custom'::text, 'workspace'::text])))
);


--
-- Name: typography_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.typography_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    origin text NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT typography_sets_origin_check CHECK ((origin = ANY (ARRAY['system'::text, 'custom'::text, 'workspace'::text])))
);


--
-- Name: typography_styles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.typography_styles (
    typography_id uuid NOT NULL,
    style_key text NOT NULL,
    font_family_id uuid NOT NULL,
    font_weight integer NOT NULL,
    font_style text DEFAULT 'normal'::text NOT NULL,
    font_stretch numeric,
    size_px numeric,
    line_height numeric,
    letter_spacing_em numeric,
    text_transform text,
    decoration text,
    hover_decoration text,
    font_features jsonb DEFAULT '{}'::jsonb NOT NULL,
    font_variations jsonb DEFAULT '{}'::jsonb NOT NULL,
    pdf_role text,
    CONSTRAINT typography_styles_font_weight_check CHECK (((font_weight >= 1) AND (font_weight <= 1000))),
    CONSTRAINT typography_styles_pdf_role_check CHECK (((pdf_role IS NULL) OR (pdf_role = ANY (ARRAY['heading'::text, 'body'::text, 'mono'::text, 'symbol'::text]))))
);


--
-- Name: user_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_features (
    user_id uuid NOT NULL,
    feature_name text NOT NULL,
    activated boolean DEFAULT true NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    password_hash text,
    avatar_key text,
    status text DEFAULT 'active'::text NOT NULL,
    email_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_admin boolean DEFAULT false NOT NULL
);


--
-- Name: verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    kind text NOT NULL,
    token_hash text NOT NULL,
    email text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    extra jsonb
);


--
-- Name: workspace_analytics_minute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_analytics_minute (
    workspace_id uuid NOT NULL,
    bucket_at timestamp with time zone NOT NULL,
    active_users integer DEFAULT 0 NOT NULL,
    doc_views integer DEFAULT 0 NOT NULL,
    sync_updates integer DEFAULT 0 NOT NULL
);


--
-- Name: workspace_automation_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_automation_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    action_type text NOT NULL,
    "position" integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    result_json jsonb,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT workspace_automation_actions_action_type_check CHECK ((action_type = ANY (ARRAY['create_row'::text, 'update_cell'::text, 'create_linked_document'::text, 'notify_webhook'::text]))),
    CONSTRAINT workspace_automation_actions_position_check CHECK (("position" >= 0)),
    CONSTRAINT workspace_automation_actions_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: workspace_automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    trigger_type text NOT NULL,
    trigger_event_json jsonb NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    error_code text,
    error_message text,
    dead_letter boolean DEFAULT false NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT workspace_automation_runs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT workspace_automation_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'dead_letter'::text, 'skipped'::text]))),
    CONSTRAINT workspace_automation_runs_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['row_created'::text, 'row_updated'::text, 'relation_changed'::text, 'status_select_changed'::text])))
);


--
-- Name: workspace_automation_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_automation_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    action_id uuid NOT NULL,
    url text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    response_status integer,
    error_message text,
    next_retry_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_automation_webhook_deliveries_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT workspace_automation_webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT workspace_automation_webhook_deliveries_url_check CHECK ((length(TRIM(BOTH FROM url)) > 0))
);


--
-- Name: workspace_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'enabled'::text NOT NULL,
    trigger_type text NOT NULL,
    trigger_json jsonb NOT NULL,
    actions_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_automations_actions_json_check CHECK ((jsonb_typeof(actions_json) = 'array'::text)),
    CONSTRAINT workspace_automations_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT workspace_automations_status_check CHECK ((status = ANY (ARRAY['enabled'::text, 'disabled'::text]))),
    CONSTRAINT workspace_automations_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['row_created'::text, 'row_updated'::text, 'relation_changed'::text, 'status_select_changed'::text])))
);


--
-- Name: workspace_calendar_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_calendar_settings (
    workspace_id uuid NOT NULL,
    writeback_subscription_id uuid,
    default_reminder_offset_minutes integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_calendars (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    remote_calendar_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_content_copy_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_copy_publications (
    operation_id uuid NOT NULL,
    target_workspace_id uuid NOT NULL,
    manifest_hash character(64) NOT NULL,
    preview_revision character varying(128),
    object_count integer NOT NULL,
    diagnostic_instance_id character varying(128) NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_copy_publication_diagnostic_instance_id_check CHECK ((((diagnostic_instance_id)::text <> ''::text) AND ((diagnostic_instance_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_copy_publications_manifest_hash_check CHECK ((manifest_hash ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT workspace_content_copy_publications_object_count_check CHECK ((object_count > 0))
);


--
-- Name: workspace_content_extract_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_extract_publications (
    operation_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    target_workspace_id uuid NOT NULL,
    source_folder_id character varying(512) NOT NULL,
    manifest_hash character varying(64) NOT NULL,
    preview_revision character varying(128),
    resource_count integer NOT NULL,
    diagnostic_instance_id character varying(256) NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_extract_publications_check CHECK ((source_workspace_id <> target_workspace_id)),
    CONSTRAINT workspace_content_extract_publications_resource_count_check CHECK ((resource_count > 0))
);


--
-- Name: workspace_content_extract_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_extract_targets (
    operation_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    source_folder_id character varying(512) NOT NULL,
    target_workspace_id uuid NOT NULL,
    owner_principal_type public.owner_principal_type NOT NULL,
    owner_principal_id uuid NOT NULL,
    membership_revision character varying(128) NOT NULL,
    membership_snapshot jsonb NOT NULL,
    acl_publication_plan jsonb NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_extract_targets_acl_publication_plan_check CHECK ((jsonb_typeof(acl_publication_plan) = 'array'::text)),
    CONSTRAINT workspace_content_extract_targets_check CHECK ((source_workspace_id <> target_workspace_id)),
    CONSTRAINT workspace_content_extract_targets_membership_revision_check CHECK ((((membership_revision)::text <> ''::text) AND ((membership_revision)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_extract_targets_membership_snapshot_check CHECK ((jsonb_typeof(membership_snapshot) = 'array'::text)),
    CONSTRAINT workspace_content_extract_targets_owner_principal_type_check CHECK ((owner_principal_type = ANY (ARRAY['user'::public.owner_principal_type, 'ou'::public.owner_principal_type]))),
    CONSTRAINT workspace_content_extract_targets_source_folder_id_check CHECK ((((source_folder_id)::text <> ''::text) AND ((source_folder_id)::text !~ '[[:cntrl:]]'::text)))
);


--
-- Name: workspace_content_link_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_link_publications (
    operation_id uuid NOT NULL,
    target_workspace_id uuid NOT NULL,
    organizer_revision character varying(128) NOT NULL,
    organizer_sequence bigint,
    entry_id character varying(512) NOT NULL,
    diagnostic_instance_id character varying(128) NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_link_publication_diagnostic_instance_id_check CHECK ((((diagnostic_instance_id)::text <> ''::text) AND ((diagnostic_instance_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_link_publications_entry_id_check CHECK ((((entry_id)::text <> ''::text) AND ((entry_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_link_publications_organizer_revision_check CHECK ((((organizer_revision)::text <> ''::text) AND ((organizer_revision)::text !~ '[[:cntrl:]]'::text)))
);


--
-- Name: workspace_content_move_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_move_publications (
    operation_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    target_workspace_id uuid NOT NULL,
    manifest_hash character(64) NOT NULL,
    preview_revision character varying(128),
    resource_count integer NOT NULL,
    diagnostic_instance_id character varying(128) NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_move_publication_diagnostic_instance_id_check CHECK ((((diagnostic_instance_id)::text <> ''::text) AND ((diagnostic_instance_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_move_publications_manifest_hash_check CHECK ((manifest_hash ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT workspace_content_move_publications_resource_count_check CHECK ((resource_count > 0))
);


--
-- Name: workspace_content_move_revision_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_move_revision_manifests (
    operation_id uuid NOT NULL,
    manifest jsonb NOT NULL,
    manifest_hash character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_move_revision_manifests_manifest_check CHECK ((jsonb_typeof(manifest) = 'object'::text)),
    CONSTRAINT workspace_content_move_revision_manifests_manifest_hash_check CHECK ((manifest_hash ~ '^[0-9A-Fa-f]{64}$'::text))
);


--
-- Name: workspace_content_operation_compensations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_compensations (
    id bigint NOT NULL,
    operation_id uuid NOT NULL,
    sequence bigint NOT NULL,
    kind character varying(64) NOT NULL,
    target_workspace_id uuid NOT NULL,
    target_kind character varying(32) NOT NULL,
    target_id character varying(512) NOT NULL,
    completed_at timestamp with time zone,
    last_error_code character varying(64),
    last_error_message character varying(512),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operation_compensations_check CHECK (((last_error_code IS NULL) = (last_error_message IS NULL))),
    CONSTRAINT workspace_content_operation_compensations_kind_check CHECK ((((kind)::text <> ''::text) AND ((kind)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_compensations_last_error_code_check CHECK ((last_error_code IN ('XWS_PREFLIGHT_STALE', 'XWS_WORKSPACE_NAME_CONFLICT', 'XWS_OWNERSHIP_UNSUPPORTED', 'XWS_WORKER_EXECUTION_FAILED'))),
    CONSTRAINT workspace_content_operation_compensations_sequence_check CHECK ((sequence >= 0)),
    CONSTRAINT workspace_content_operation_compensations_target_id_check CHECK ((((target_id)::text <> ''::text) AND ((target_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_compensations_target_kind_check CHECK ((target_kind IN ('document', 'database', 'collection', 'folder', 'tag', 'blob')))
);


--
-- Name: workspace_content_operation_compensations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_content_operation_compensations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_content_operation_compensations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_content_operation_compensations_id_seq OWNED BY public.workspace_content_operation_compensations.id;


--
-- Name: workspace_content_operation_link_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_link_intents (
    operation_id uuid NOT NULL,
    entry_id character varying(512) NOT NULL,
    parent_id character varying(512) NOT NULL,
    organizer_index character varying(512) NOT NULL,
    organizer_revision character varying(128) NOT NULL,
    target_workspace_id uuid NOT NULL,
    target_kind character varying(32) NOT NULL,
    target_id character varying(512) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operation_link_inten_organizer_revision_check CHECK ((((organizer_revision)::text <> ''::text) AND ((organizer_revision)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_link_intents_entry_id_check CHECK ((((entry_id)::text <> ''::text) AND ((entry_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_link_intents_organizer_index_check CHECK ((((organizer_index)::text <> ''::text) AND ((organizer_index)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_link_intents_parent_id_check CHECK ((((parent_id)::text <> ''::text) AND ((parent_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_link_intents_target_id_check CHECK ((((target_id)::text <> ''::text) AND ((target_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_link_intents_target_kind_check CHECK ((target_kind IN ('document', 'database', 'collection', 'tag')))
);


--
-- Name: workspace_content_operation_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_mappings (
    operation_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    source_kind character varying(32) NOT NULL,
    source_id character varying(512) NOT NULL,
    target_workspace_id uuid NOT NULL,
    target_kind character varying(32) NOT NULL,
    target_id character varying(512) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operation_mappings_check CHECK (((source_kind)::text = (target_kind)::text)),
    CONSTRAINT workspace_content_operation_mappings_source_id_check CHECK ((((source_id)::text <> ''::text) AND ((source_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_mappings_source_kind_check CHECK ((source_kind IN ('document', 'database', 'collection', 'folder', 'tag', 'blob'))),
    CONSTRAINT workspace_content_operation_mappings_target_id_check CHECK ((((target_id)::text <> ''::text) AND ((target_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_mappings_target_kind_check CHECK ((target_kind IN ('document', 'database', 'collection', 'folder', 'tag', 'blob')))
);


--
-- Name: workspace_content_operation_recipient_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_recipient_outbox (
    id bigint NOT NULL,
    operation_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    event_kind character varying(64) NOT NULL,
    resource_count integer NOT NULL,
    recipient_snapshot_revision character varying(128) NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    dispatched_at timestamp with time zone,
    last_error character varying(512),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    visible_resource_kinds text[] DEFAULT '{}'::text[] NOT NULL,
    lease_expires_at timestamp with time zone,
    source_workspace_id uuid NOT NULL,
    source_workspace_name character varying(256) NOT NULL,
    actor_id uuid NOT NULL,
    published_at timestamp with time zone NOT NULL,
    CONSTRAINT chk_workspace_content_recipient_resource_count CHECK ((resource_count >= 0)),
    CONSTRAINT chk_workspace_content_recipient_resource_kinds CHECK (((visible_resource_kinds <@ ARRAY['document'::text, 'database'::text, 'collection'::text, 'folder'::text, 'tag'::text, 'blob'::text]) AND (cardinality(visible_resource_kinds) <= 6) AND (((resource_count = 0) AND (cardinality(visible_resource_kinds) = 0)) OR ((resource_count > 0) AND (cardinality(visible_resource_kinds) > 0))))),
    CONSTRAINT workspace_content_operation_r_recipient_snapshot_revision_check CHECK ((((recipient_snapshot_revision)::text <> ''::text) AND ((recipient_snapshot_revision)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_recipient_outbo_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT workspace_content_operation_recipient_outbox_event_kind_check CHECK ((((event_kind)::text <> ''::text) AND ((event_kind)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_recipient_outbox_last_error_check CHECK (((last_error IS NULL) OR ((last_error)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_recipient_outbox_status_check CHECK ((status IN ('pending', 'processing', 'dispatched', 'failed'))),
    CONSTRAINT workspace_content_operation_recipient_source_name_check CHECK ((((source_workspace_name)::text <> ''::text) AND ((source_workspace_name)::text = TRIM(BOTH FROM source_workspace_name)) AND ((source_workspace_name)::text !~ '[[:cntrl:]]'::text)))
);


--
-- Name: workspace_content_operation_recipient_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_content_operation_recipient_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_content_operation_recipient_outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_content_operation_recipient_outbox_id_seq OWNED BY public.workspace_content_operation_recipient_outbox.id;


--
-- Name: workspace_content_operation_redirects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_redirects (
    operation_id uuid NOT NULL,
    source_workspace_id uuid NOT NULL,
    source_kind character varying(32) NOT NULL,
    source_id character varying(512) NOT NULL,
    target_workspace_id uuid NOT NULL,
    target_kind character varying(32) NOT NULL,
    target_id character varying(512) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operation_redirects_check CHECK (((source_kind)::text = (target_kind)::text)),
    CONSTRAINT workspace_content_operation_redirects_source_id_check CHECK ((((source_id)::text <> ''::text) AND ((source_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_redirects_source_kind_check CHECK ((source_kind IN ('document', 'database', 'collection', 'folder', 'tag', 'blob'))),
    CONSTRAINT workspace_content_operation_redirects_target_id_check CHECK ((((target_id)::text <> ''::text) AND ((target_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_redirects_target_kind_check CHECK ((target_kind IN ('document', 'database', 'collection', 'folder', 'tag', 'blob')))
);


--
-- Name: workspace_content_operation_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_requests (
    operation_id uuid NOT NULL,
    request jsonb NOT NULL,
    execution_memberships jsonb DEFAULT '[]'::jsonb NOT NULL,
    origin_operation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operation_request_execution_memberships_check CHECK ((jsonb_typeof(execution_memberships) = 'array'::text)),
    CONSTRAINT workspace_content_operation_requests_check CHECK (((origin_operation_id IS NULL) OR (origin_operation_id <> operation_id))),
    CONSTRAINT workspace_content_operation_requests_request_check CHECK ((jsonb_typeof(request) = 'object'::text))
);


--
-- Name: workspace_content_operation_staging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operation_staging (
    operation_id uuid NOT NULL,
    sequence integer NOT NULL,
    resource_workspace_id uuid NOT NULL,
    resource_kind character varying(32) NOT NULL,
    resource_id character varying(512) NOT NULL,
    object_key character varying(1024) NOT NULL,
    content_hash character(64) NOT NULL,
    size_bytes bigint NOT NULL,
    publication_status character varying(32) DEFAULT 'staged'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operation_staging_content_hash_check CHECK ((content_hash ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT workspace_content_operation_staging_object_key_check CHECK ((((object_key)::text <> ''::text) AND ((object_key)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_staging_publication_status_check CHECK ((publication_status IN ('staged', 'published', 'cleanup_required', 'deleted'))),
    CONSTRAINT workspace_content_operation_staging_resource_id_check CHECK ((((resource_id)::text <> ''::text) AND ((resource_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operation_staging_resource_kind_check CHECK ((resource_kind IN ('document', 'database', 'collection', 'folder', 'tag', 'blob'))),
    CONSTRAINT workspace_content_operation_staging_sequence_check CHECK ((sequence >= 0)),
    CONSTRAINT workspace_content_operation_staging_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= '8589934592'::bigint)))
);


--
-- Name: workspace_content_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_content_operations (
    id uuid NOT NULL,
    idempotency_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    kind character varying(32) NOT NULL,
    source_workspace_id uuid NOT NULL,
    target_workspace_id uuid,
    status character varying(32) NOT NULL,
    preview_revision character varying(128),
    manifest_hash character(64) NOT NULL,
    error_code character varying(64),
    error_message character varying(512),
    diagnostic_instance_id character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_content_operations_check CHECK (((target_workspace_id IS NULL) OR (target_workspace_id <> source_workspace_id))),
    CONSTRAINT workspace_content_operations_check1 CHECK (((error_code IS NULL) = (error_message IS NULL))),
    CONSTRAINT workspace_content_operations_diagnostic_instance_id_check CHECK (((diagnostic_instance_id IS NULL) OR ((diagnostic_instance_id)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operations_error_code_check CHECK ((error_code IN ('XWS_PREFLIGHT_STALE', 'XWS_WORKSPACE_NAME_CONFLICT', 'XWS_OWNERSHIP_UNSUPPORTED', 'XWS_WORKER_EXECUTION_FAILED'))),
    CONSTRAINT workspace_content_operations_kind_check CHECK ((kind IN ('move', 'copy', 'link', 'extract_folder'))),
    CONSTRAINT workspace_content_operations_manifest_hash_check CHECK ((manifest_hash ~ '^[0-9A-Fa-f]{64}$'::text)),
    CONSTRAINT workspace_content_operations_preview_revision_check CHECK (((preview_revision IS NULL) OR ((preview_revision)::text !~ '[[:cntrl:]]'::text))),
    CONSTRAINT workspace_content_operations_status_check CHECK ((status IN ('draft', 'previewed', 'queued', 'running', 'succeeded', 'cancelled', 'failed', 'cleanup_required')))
);


--
-- Name: workspace_database_csv_mapping_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_csv_mapping_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    is_current boolean DEFAULT true NOT NULL,
    dialect_json jsonb NOT NULL,
    first_row_is_header boolean DEFAULT true NOT NULL,
    mapping_json jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_database_formula_dependencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_formula_dependencies (
    formula_field_id uuid NOT NULL,
    dependency_field_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_database_formula_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_formula_values (
    database_id uuid NOT NULL,
    row_id uuid NOT NULL,
    field_id uuid NOT NULL,
    value_json jsonb,
    source_hash text,
    stale_state text DEFAULT 'stale'::text NOT NULL,
    computed_at timestamp with time zone,
    failed_at timestamp with time zone,
    error_code text,
    error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_database_formula_values_check CHECK ((((stale_state = 'failed'::text) AND (failed_at IS NOT NULL)) OR (stale_state <> 'failed'::text))),
    CONSTRAINT workspace_database_formula_values_stale_state_check CHECK ((stale_state = ANY (ARRAY['current'::text, 'stale'::text, 'queued'::text, 'failed'::text, 'recompute_pending'::text])))
);


--
-- Name: workspace_database_relation_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_relation_edges (
    source_database_id uuid NOT NULL,
    source_row_id uuid NOT NULL,
    source_field_id uuid NOT NULL,
    target_database_id uuid NOT NULL,
    target_row_id uuid NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_database_relation_edges_position_check CHECK (("position" >= 0))
);


--
-- Name: workspace_database_rollup_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_rollup_values (
    database_id uuid NOT NULL,
    row_id uuid NOT NULL,
    field_id uuid NOT NULL,
    value_json jsonb,
    source_hash text,
    stale_state text DEFAULT 'stale'::text NOT NULL,
    computed_at timestamp with time zone,
    failed_at timestamp with time zone,
    error_code text,
    error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_database_rollup_values_check CHECK ((((stale_state = 'failed'::text) AND (failed_at IS NOT NULL)) OR (stale_state <> 'failed'::text))),
    CONSTRAINT workspace_database_rollup_values_stale_state_check CHECK ((stale_state = ANY (ARRAY['current'::text, 'stale'::text, 'queued'::text, 'failed'::text, 'recompute_pending'::text])))
);


--
-- Name: workspace_database_row_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_row_search (
    workspace_id uuid NOT NULL,
    database_id uuid NOT NULL,
    row_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    tsv tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('simple'::regconfig, title), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, ((search_text || ' '::text) || (workspace_tags)::text)), 'B'::"char"))) STORED
);


--
-- Name: workspace_database_row_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_row_templates (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    database_id uuid NOT NULL,
    template_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    "position" integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    initial_cell_values_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_kind text DEFAULT 'record'::text NOT NULL,
    CONSTRAINT workspace_database_row_templates_description_valid CHECK (((description IS NULL) OR ((description = btrim(description)) AND (length(description) <= 1024)))),
    CONSTRAINT workspace_database_row_templates_initial_values_object CHECK ((jsonb_typeof(initial_cell_values_json) = 'object'::text)),
    CONSTRAINT workspace_database_row_templates_name_valid CHECK ((length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name))),
    CONSTRAINT workspace_database_row_templates_position_non_negative CHECK (("position" >= 0)),
    CONSTRAINT workspace_database_row_templates_row_kind_valid CHECK ((row_kind = ANY (ARRAY['record'::text, 'task'::text, 'phase'::text, 'milestone'::text])))
);


--
-- Name: workspace_database_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_database_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid NOT NULL,
    name text NOT NULL,
    view_kind text NOT NULL,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    edit_revision bigint DEFAULT 1 NOT NULL,
    icon_json jsonb,
    CONSTRAINT workspace_database_views_edit_revision_positive CHECK ((edit_revision > 0)),
    CONSTRAINT workspace_database_views_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT workspace_database_views_position_check CHECK (("position" >= 0)),
    CONSTRAINT workspace_database_views_view_kind_check CHECK ((view_kind = ANY (ARRAY['table'::text, 'kanban'::text, 'list'::text, 'gallery'::text, 'calendar'::text, 'timeline'::text, 'progress'::text])))
);


--
-- Name: workspace_doc_view_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_doc_view_daily (
    workspace_id uuid NOT NULL,
    doc_id text NOT NULL,
    date date NOT NULL,
    total_views bigint DEFAULT 0 NOT NULL,
    unique_views bigint DEFAULT 0 NOT NULL,
    guest_views bigint DEFAULT 0 NOT NULL,
    last_accessed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_document_audience_default; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_document_audience_default (
    workspace_id uuid NOT NULL,
    audience_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: workspace_document_metadata_epoch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_document_metadata_epoch (
    workspace_id uuid NOT NULL,
    epoch_name text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_document_metadata_epoch_name_check CHECK ((epoch_name = 'defaults'::text)),
    CONSTRAINT workspace_document_metadata_epoch_revision_check CHECK ((revision >= 0))
);


--
-- Name: workspace_import_compensations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_import_compensations (
    id bigint NOT NULL,
    import_id uuid NOT NULL,
    sequence bigint NOT NULL,
    kind text NOT NULL,
    target_id text NOT NULL,
    completed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_import_compensations_kind_check CHECK ((kind = ANY (ARRAY['workspace'::text, 'document'::text, 'database'::text, 'asset'::text]))),
    CONSTRAINT workspace_import_compensations_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: workspace_import_compensations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_import_compensations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_import_compensations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_import_compensations_id_seq OWNED BY public.workspace_import_compensations.id;


--
-- Name: workspace_import_id_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_import_id_mappings (
    import_id uuid NOT NULL,
    kind text NOT NULL,
    source_id text NOT NULL,
    target_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_import_id_mappings_kind_check CHECK ((kind = ANY (ARRAY['workspace'::text, 'document'::text, 'database'::text, 'view'::text, 'field'::text, 'row'::text, 'asset'::text])))
);


--
-- Name: workspace_import_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_import_parts (
    import_id uuid NOT NULL,
    part_number integer NOT NULL,
    object_key text NOT NULL,
    size_bytes bigint NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_import_parts_part_number_check CHECK ((part_number >= 1)),
    CONSTRAINT workspace_import_parts_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: workspace_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_imports (
    id uuid NOT NULL,
    actor_id uuid NOT NULL,
    status text NOT NULL,
    staging_object_key text NOT NULL,
    source_hash text DEFAULT ''::text NOT NULL,
    source_size_bytes bigint DEFAULT 0 NOT NULL,
    config_fingerprint text NOT NULL,
    preview jsonb,
    target_workspace_id uuid,
    queued_operation text,
    progress_stage text,
    progress_stage_rank smallint DEFAULT 0 NOT NULL,
    progress_current bigint DEFAULT 0 NOT NULL,
    progress_total bigint DEFAULT 0 NOT NULL,
    cancel_requested boolean DEFAULT false NOT NULL,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT workspace_imports_progress_current_check CHECK ((progress_current >= 0)),
    CONSTRAINT workspace_imports_progress_stage_check CHECK ((progress_stage = ANY (ARRAY['validation'::text, 'document_decode'::text, 'asset_planning'::text, 'database_planning'::text, 'target_creation'::text, 'document_materialization'::text, 'database_materialization'::text, 'reference_rewrite'::text, 'final_validation'::text, 'publication'::text, 'compensation'::text]))),
    CONSTRAINT workspace_imports_progress_stage_rank_check CHECK (((progress_stage_rank >= 0) AND (progress_stage_rank <= 11))),
    CONSTRAINT workspace_imports_progress_total_check CHECK ((progress_total >= 0)),
    CONSTRAINT workspace_imports_queued_operation_check CHECK ((queued_operation = ANY (ARRAY['preview'::text, 'apply'::text, 'cleanup'::text]))),
    CONSTRAINT workspace_imports_source_size_bytes_check CHECK ((source_size_bytes >= 0)),
    CONSTRAINT workspace_imports_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'previewed'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'cleanup_required'::text, 'expired'::text])))
);


--
-- Name: workspace_invite_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invite_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_member_last_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_member_last_access (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    last_doc_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_memberships (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    invited_by_user_id uuid,
    joined_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid(),
    CONSTRAINT workspace_memberships_role_check CHECK ((role = ANY (ARRAY['External'::text, 'Reader'::text, 'Commenter'::text, 'Collaborator'::text, 'Manager'::text, 'Admin'::text, 'Owner'::text])))
);


--
-- Name: workspace_storage_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_storage_stats (
    workspace_id uuid NOT NULL,
    snapshot_size bigint DEFAULT 0 NOT NULL,
    blob_size bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_storage_stats_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_storage_stats_daily (
    workspace_id uuid NOT NULL,
    day date NOT NULL,
    snapshot_size bigint DEFAULT 0 NOT NULL,
    blob_size bigint DEFAULT 0 NOT NULL
);


--
-- Name: workspace_tag_document_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tag_document_assignments (
    workspace_id uuid NOT NULL,
    doc_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT workspace_tag_document_position_nonnegative CHECK (("position" >= 0))
);


--
-- Name: workspace_tag_legacy_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tag_legacy_ids (
    workspace_id uuid NOT NULL,
    legacy_id text NOT NULL,
    tag_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tags (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    color_role text NOT NULL,
    description text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT workspace_tags_color_role_valid CHECK ((color_role = ANY (ARRAY['tag.red'::text, 'tag.magenta'::text, 'tag.orange'::text, 'tag.yellow'::text, 'tag.green'::text, 'tag.teal'::text, 'tag.blue'::text, 'tag.purple'::text, 'tag.grey'::text]))),
    CONSTRAINT workspace_tags_name_not_blank CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80))),
    CONSTRAINT workspace_tags_slug_valid CHECK ((slug ~ '^[[:alnum:]]+(-[[:alnum:]]+)*$'::text))
);


--
-- Name: workspace_template_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_template_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    template_id uuid NOT NULL,
    revision_id uuid,
    workspace_doc_id uuid,
    state text DEFAULT 'ok'::text NOT NULL,
    last_applied_hash text,
    current_hash text,
    last_synced_at timestamp with time zone,
    detached_at timestamp with time zone,
    retired_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_hash text,
    locale_hash text,
    workspace_doc_key text,
    CONSTRAINT chk_workspace_template_instances_doc_key_nonempty CHECK (((workspace_doc_key IS NULL) OR (btrim(workspace_doc_key) <> ''::text))),
    CONSTRAINT workspace_template_instances_state_check CHECK ((state = ANY (ARRAY['ok'::text, 'update_available'::text, 'detached'::text, 'retired'::text, 'error'::text])))
);


--
-- Name: workspace_template_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_template_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    template_id uuid NOT NULL,
    selection_mode text DEFAULT 'published'::text NOT NULL,
    selected_revision_id uuid,
    provisioning_mode text DEFAULT 'managed_until_local_edit'::text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_template_policies_provisioning_mode_check CHECK ((provisioning_mode = ANY (ARRAY['seed_once'::text, 'managed_until_local_edit'::text, 'manual_update'::text]))),
    CONSTRAINT workspace_template_policies_selection_mode_check CHECK ((selection_mode = ANY (ARRAY['published'::text, 'pinned_revision'::text])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid,
    name text DEFAULT ''::text NOT NULL,
    avatar_key text,
    public boolean DEFAULT false NOT NULL,
    enable_ai boolean DEFAULT false NOT NULL,
    enable_sharing boolean DEFAULT true NOT NULL,
    enable_url_preview boolean DEFAULT true NOT NULL,
    enable_doc_embedding boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    storage_quota_bytes bigint,
    owner_principal_type public.owner_principal_type NOT NULL,
    owner_principal_id uuid,
    management_unit_id uuid,
    created_by_user_id uuid,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    is_personal_workspace boolean DEFAULT false NOT NULL,
    name_normalized text,
    lifecycle_owner_kind text,
    lifecycle_owner_id uuid,
    CONSTRAINT workspaces_lifecycle_owner_check CHECK ((((lifecycle_state = 'active'::text) AND (lifecycle_owner_kind IS NULL) AND (lifecycle_owner_id IS NULL)) OR ((lifecycle_state = 'importing'::text) AND (lifecycle_owner_kind = 'import'::text) AND (lifecycle_owner_id IS NOT NULL)) OR ((lifecycle_state = 'extracting'::text) AND (lifecycle_owner_kind = 'workspace_content'::text) AND (lifecycle_owner_id IS NOT NULL)))),
    CONSTRAINT workspaces_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['active'::text, 'importing'::text, 'extracting'::text]))),
    CONSTRAINT workspaces_name_normalized_shape CHECK (((name_normalized IS NULL) OR ((name_normalized = btrim(name_normalized)) AND (name_normalized <> ''::text) AND (char_length(name_normalized) <= 120)))),
    CONSTRAINT workspaces_owner_principal_consistency CHECK ((((owner_principal_type = 'user'::public.owner_principal_type) AND (owner_user_id IS NOT NULL) AND (owner_principal_id = owner_user_id)) OR ((owner_principal_type = 'ou'::public.owner_principal_type) AND (owner_user_id IS NULL) AND (owner_principal_id IS NOT NULL)) OR ((owner_principal_type = 'system'::public.owner_principal_type) AND (owner_user_id IS NULL) AND (owner_principal_id IS NULL)))),
    CONSTRAINT workspaces_personal_owner_consistency CHECK (((NOT is_personal_workspace) OR (owner_principal_type = 'user'::public.owner_principal_type)))
);


--
-- Name: cache_tuning_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache_tuning_metrics ALTER COLUMN id SET DEFAULT nextval('public.cache_tuning_metrics_id_seq'::regclass);


--
-- Name: config_changelog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_changelog ALTER COLUMN id SET DEFAULT nextval('public.config_changelog_id_seq'::regclass);


--
-- Name: metrics_raw id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_raw ALTER COLUMN id SET DEFAULT nextval('public.metrics_raw_id_seq'::regclass);


--
-- Name: workspace_content_operation_compensations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_compensations ALTER COLUMN id SET DEFAULT nextval('public.workspace_content_operation_compensations_id_seq'::regclass);


--
-- Name: workspace_content_operation_recipient_outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox ALTER COLUMN id SET DEFAULT nextval('public.workspace_content_operation_recipient_outbox_id_seq'::regclass);


--
-- Name: workspace_import_compensations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_compensations ALTER COLUMN id SET DEFAULT nextval('public.workspace_import_compensations_id_seq'::regclass);


--
-- PostgreSQL database dump complete
--

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: app_configs; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_configs VALUES
	('document_versioning.default_enabled', 'true', '2026-08-11 16:58:45.976946+00', '2026-08-11 16:58:45.976946+00', NULL),
	('document_versioning.default_auto_version_on_pdf_export', 'true', '2026-08-11 16:58:45.976946+00', '2026-08-11 16:58:45.976946+00', NULL),
	('i18n.default_locale', '"en"', '2026-08-11 16:58:45.86402+00', '2026-08-11 16:58:45.86402+00', NULL);


--
-- Data for Name: app_server_branding; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.app_server_branding VALUES
	(true, NULL, NULL, NULL, '2026-08-11 16:58:42.759066+00', '2026-08-11 16:58:42.759066+00', NULL);


--
-- Data for Name: document_audience_definition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_audience_definition VALUES
	('ad580ec8-270e-4157-a482-28a33d859cac', 'internal', 'Intern', NULL, NULL, NULL, 10, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('149e5746-fef9-4fd2-9452-d1252995ddd8', 'operations', 'Betrieb', NULL, NULL, NULL, 20, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('deac52d8-4594-4106-a1c0-df4adcde99e6', 'engineering', 'Entwicklung', NULL, NULL, NULL, 30, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('64362f25-b89c-4ac1-9941-20b016254931', 'management', 'Management', NULL, NULL, NULL, 40, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('b4fc1d6f-6f87-4277-b0c6-6bfe6aadd8e0', 'customer', 'Kunden', NULL, NULL, NULL, 50, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00');


--
-- Data for Name: document_classification_definition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_classification_definition VALUES
	('47db41f9-cb1a-41e4-8859-e568645ef030', 'public', 'Öffentlich', NULL, NULL, NULL, 10, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('e8d9687e-c0c9-4f23-859e-6af1b900c415', 'internal', 'Intern', NULL, NULL, NULL, 20, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('8feb2d55-4e05-4444-92f0-8ec0a8430029', 'confidential', 'Vertraulich', NULL, NULL, NULL, 30, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('26392d29-cbc6-4bc7-887b-393241afd6f5', 'restricted', 'Streng vertraulich', NULL, NULL, NULL, 40, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00');


--
-- Data for Name: document_metadata_field_definition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_metadata_field_definition VALUES
	('documentType', 'lifecycle', 'uuid', 'docs.document_type_id', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Document type', 'docs', 'document_type_id', 'inherited', 'document_type_source', 'document_metadata', 'both'),
	('classification', 'classification', 'uuid', 'docs.classification_id', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Classification', 'docs', 'classification_id', 'inherited', 'classification_source', 'document_metadata', 'both'),
	('reviewDueAt', 'responsibility', 'timestamp', 'docs.review_due_at', false, false, 'organization_admin', 'workspace_admin', 'responsible_user', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:45.468088+00', 'Review due at', 'docs', 'review_due_at', 'document_only', NULL, 'document_metadata', 'both'),
	('validUntil', 'lifecycle', 'timestamp', 'docs.valid_until', false, false, 'organization_admin', 'workspace_admin', 'responsible_user', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:45.468088+00', 'Valid until', 'docs', 'valid_until', 'document_only', NULL, 'document_metadata', 'both'),
	('retentionPolicy', 'retention', 'uuid', 'docs.retention_policy_id', false, false, 'organization_admin', 'workspace_admin', 'workspace_admin', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:45.468088+00', 'Retention policy', 'docs', 'retention_policy_id', 'inherited', 'retention_policy_source', 'document_metadata', 'both'),
	('language', 'lifecycle', 'uuid', 'docs.language_id', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Language', 'docs', 'language_id', 'inherited', 'language_source', 'document_metadata', 'both'),
	('responsible', 'responsibility', 'uuid', 'docs.responsible_user_id', false, false, 'organization_admin', 'workspace_admin', 'responsible_user', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Responsible', 'docs', 'responsible_user_id', 'inherited', 'responsible_source', 'document_metadata', 'both'),
	('validFrom', 'lifecycle', 'timestamp', 'docs.valid_from', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Valid from', 'docs', 'valid_from', 'document_only', NULL, 'document_metadata', 'both'),
	('documentNumber', 'system', 'text', 'docs.document_number', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Document number', 'docs', 'document_number', 'document_only', NULL, 'document_metadata', 'both'),
	('status', 'lifecycle', 'uuid', 'docs.status_id', false, false, 'system_only', 'system_only', 'system_only', 'never', true, true, true, 'optional', '{"write": "transition_only"}', NULL, '2026-08-11 16:58:43.56981+00', 'Status', 'docs', 'status_id', 'inherited', 'status_source', 'status_transition', 'both'),
	('audience', 'audience', 'relation', 'doc_audience_assignment', false, true, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Audience', 'relation_table', 'doc_audience_assignment', 'relation_inherited', 'audience_source', 'document_metadata', 'both'),
	('createdAt', 'system', 'timestamp', 'docs.created_at', true, false, 'system_only', 'system_only', 'system_only', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'createdAt', 'system_fact', 'created_at', 'system_readonly', NULL, 'readonly', 'both'),
	('updatedAt', 'system', 'timestamp', 'docs.updated_at', true, false, 'system_only', 'system_only', 'system_only', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'updatedAt', 'system_fact', 'updated_at', 'system_readonly', NULL, 'readonly', 'both'),
	('createdBy', 'system', 'uuid', 'docs.created_by', true, false, 'system_only', 'system_only', 'system_only', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'createdBy', 'system_fact', 'created_by', 'system_readonly', NULL, 'readonly', 'both'),
	('updatedBy', 'system', 'uuid', 'docs.updated_by', true, false, 'system_only', 'system_only', 'system_only', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'updatedBy', 'system_fact', 'updated_by', 'system_readonly', NULL, 'readonly', 'both'),
	('metadataRevision', 'system', 'text', 'docs.metadata_revision', true, false, 'system_only', 'system_only', 'system_only', 'never', false, false, false, 'hidden', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'metadataRevision', 'system_fact', 'metadata_revision', 'system_readonly', NULL, 'readonly', 'myoxus_native'),
	('version', 'lifecycle', 'uuid', 'docs.current_version_id', true, false, 'system_only', 'system_only', 'system_only', 'never', true, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'Version', 'docs', 'current_version_id', 'system_readonly', NULL, 'readonly', 'both'),
	('journalDate', 'journal', 'date', 'docs.journal_date', true, false, 'system_only', 'system_only', 'system_only', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:43.56981+00', 'journalDate', 'journal_calendar_subsystem', 'journal_date', 'system_readonly', NULL, 'journal_calendar', 'both'),
	('templateState', 'template', 'relation', 'document_template_state', true, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'optional', '{}', NULL, '2026-08-11 16:58:45.677106+00', 'templateState', 'template_state', 'document_template_state', 'specialized_subsystem', NULL, 'template_state', 'both'),
	('primaryMode', 'presentation', 'text', 'document_presentation_state.primary_mode', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'hidden', '{}', NULL, '2026-08-11 16:58:45.677106+00', 'Primary mode', 'presentation_setting', 'primary_mode', 'specialized_subsystem', NULL, 'presentation_setting', 'both'),
	('pageWidth', 'presentation', 'text', 'document_presentation_state.page_width', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'hidden', '{}', NULL, '2026-08-11 16:58:45.677106+00', 'Page width', 'presentation_setting', 'page_width', 'specialized_subsystem', NULL, 'presentation_setting', 'both'),
	('edgelessColorTheme', 'presentation', 'text', 'document_presentation_state.edgeless_color_theme', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'hidden', '{}', NULL, '2026-08-11 16:58:45.677106+00', 'Edgeless color theme', 'presentation_setting', 'edgeless_color_theme', 'specialized_subsystem', NULL, 'presentation_setting', 'both'),
	('integrationType', 'integration', 'text', 'document_integration_state.integration_type', false, false, 'organization_admin', 'workspace_admin', 'document_editor', 'never', false, true, true, 'hidden', '{}', NULL, '2026-08-11 16:58:45.677106+00', 'Integration type', 'integration_subsystem', 'integration_type', 'specialized_subsystem', NULL, 'integration_subsystem', 'both');


--
-- Data for Name: document_metadata_global_epoch; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_metadata_global_epoch VALUES
	('field_definition', 35, NULL, '2026-08-11 16:58:45.677106+00'),
	('reference_values', 39, NULL, '2026-08-11 16:58:52.688564+00');


--
-- Data for Name: document_retention_policy_definition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_retention_policy_definition VALUES
	('7e0e3ffc-bebf-4981-b3e7-6a4ad927dde4', 'standard', 'Standard', NULL, NULL, NULL, 10, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('9a939422-09e6-4839-86ba-ad27c5d5fa92', 'short_lived', 'Kurzlebig', NULL, NULL, NULL, 20, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('1d2f91e7-c134-41f0-a61c-0ca655ffd88b', 'long_term', 'Langzeit', NULL, NULL, NULL, 30, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00'),
	('16ed68d8-438a-41fb-b16d-e893036369cb', 'archive', 'Archiv', NULL, NULL, NULL, 40, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:43.56981+00');


--
-- Data for Name: document_status_schema; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_status_schema VALUES
	('2f07f8b3-29df-4b0e-9939-e9fff2432f21', 'simple', 'Einfach', 'Kleines Statusschema fuer kleine Teams und persoenliche Arbeitsbereiche.', 'simple', true, true, '{}', NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('1af1c2ea-5d14-42cc-973c-b96eaa8850f0', 'review', 'Freigabe', 'Review-/Freigabe-Schema ohne komplexe Governance.', 'review', true, true, '{}', NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('a6332809-0467-466d-b3c9-66c77bae68f2', 'controlled', 'Kontrolliert', 'Schema fuer Betriebs-, Compliance- und QM-nahe Dokumente.', 'controlled', true, true, '{}', NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00');


--
-- Data for Name: document_status_transition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_status_transition VALUES
	('d349f307-8798-42e6-bcd4-6d49f7a321b6', '309df525-f0a2-47e1-976b-1ad09f268eaf', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('fe07b6f6-eb4b-4bdb-b92e-948bffe6c5af', 'd349f307-8798-42e6-bcd4-6d49f7a321b6', '{}', '{}', 'never', NULL, 'warn', '{}'),
	('fe07b6f6-eb4b-4bdb-b92e-948bffe6c5af', '309df525-f0a2-47e1-976b-1ad09f268eaf', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('3ca4f1d5-0aa3-4efd-bee0-cdefe321f30a', 'fe07b6f6-eb4b-4bdb-b92e-948bffe6c5af', '{}', '{}', 'never', NULL, 'warn', '{}'),
	('309df525-f0a2-47e1-976b-1ad09f268eaf', '3ca4f1d5-0aa3-4efd-bee0-cdefe321f30a', '{}', '{}', 'optional', 'milestone', 'warn', '{}'),
	('84b353af-cebc-44bd-b0ce-b59e7dffde03', '96f09505-5e7e-40a3-b8a5-7bc1e724eccf', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('d6bb710f-d58e-45d5-abc6-5718ec8cb16b', '84b353af-cebc-44bd-b0ce-b59e7dffde03', '{}', '{}', 'never', NULL, 'warn', '{}'),
	('96f09505-5e7e-40a3-b8a5-7bc1e724eccf', '384c9963-7b78-4e48-ab80-7e5f3cfe53bd', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('d6bb710f-d58e-45d5-abc6-5718ec8cb16b', '96f09505-5e7e-40a3-b8a5-7bc1e724eccf', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('384c9963-7b78-4e48-ab80-7e5f3cfe53bd', 'fd72703f-a4e7-4513-a1b6-b659d83310a9', '{}', '{}', 'never', NULL, 'warn', '{}'),
	('384c9963-7b78-4e48-ab80-7e5f3cfe53bd', 'd6bb710f-d58e-45d5-abc6-5718ec8cb16b', '{}', '{}', 'required', 'published', 'warn', '{}'),
	('fd72703f-a4e7-4513-a1b6-b659d83310a9', '384c9963-7b78-4e48-ab80-7e5f3cfe53bd', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('ce2fd22b-eb80-4580-95a8-664722d4db4a', '54532737-b096-4afa-911f-20a9e74d6d04', '{}', '{}', 'never', NULL, 'warn', '{}'),
	('b86cd7d8-a79e-4f5f-b280-0a4513d9b2a5', 'ce2fd22b-eb80-4580-95a8-664722d4db4a', '{}', '{}', 'never', NULL, 'warn', '{}'),
	('f7f29cfe-68f2-4e07-a315-38755ce1bac4', 'b86cd7d8-a79e-4f5f-b280-0a4513d9b2a5', '{}', '{}', 'required', 'published', 'warn', '{}'),
	('46a1564e-c0e7-46b7-afa4-ad5ed0bcd600', 'b6131183-f277-4917-831f-bb14d5a9b3fc', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('f7f29cfe-68f2-4e07-a315-38755ce1bac4', '46a1564e-c0e7-46b7-afa4-ad5ed0bcd600', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}'),
	('6d0a5fc4-2e42-417e-a1b3-ed13f6298450', 'f7f29cfe-68f2-4e07-a315-38755ce1bac4', '{}', '{}', 'optional', 'milestone', 'warn', '{}'),
	('9580d81e-7b0f-4650-b6d2-26f01816cfea', '6d0a5fc4-2e42-417e-a1b3-ed13f6298450', '{}', '{}', 'required', 'published', 'warn', '{}'),
	('b6131183-f277-4917-831f-bb14d5a9b3fc', '9580d81e-7b0f-4650-b6d2-26f01816cfea', '{}', '{}', 'optional', 'milestone', 'warn', '{}'),
	('c139ca5b-9015-43c6-a6e4-7a782573e7de', 'b6131183-f277-4917-831f-bb14d5a9b3fc', '{}', '{}', 'optional', 'checkpoint', 'warn', '{}');


--
-- Data for Name: document_status_value; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_status_value VALUES
	('d349f307-8798-42e6-bcd4-6d49f7a321b6', '2f07f8b3-29df-4b0e-9939-e9fff2432f21', 'archived', 'Archiviert', NULL, NULL, NULL, 40, true, true, '{}'),
	('fe07b6f6-eb4b-4bdb-b92e-948bffe6c5af', '2f07f8b3-29df-4b0e-9939-e9fff2432f21', 'outdated', 'Veraltet', NULL, NULL, NULL, 30, false, true, '{}'),
	('3ca4f1d5-0aa3-4efd-bee0-cdefe321f30a', '2f07f8b3-29df-4b0e-9939-e9fff2432f21', 'current', 'Aktuell', NULL, NULL, NULL, 20, false, true, '{}'),
	('309df525-f0a2-47e1-976b-1ad09f268eaf', '2f07f8b3-29df-4b0e-9939-e9fff2432f21', 'in_progress', 'In Arbeit', NULL, NULL, NULL, 10, false, true, '{}'),
	('84b353af-cebc-44bd-b0ce-b59e7dffde03', '1af1c2ea-5d14-42cc-973c-b96eaa8850f0', 'archived', 'Archiviert', NULL, NULL, NULL, 50, true, true, '{}'),
	('96f09505-5e7e-40a3-b8a5-7bc1e724eccf', '1af1c2ea-5d14-42cc-973c-b96eaa8850f0', 'in_revision', 'In Revision', NULL, NULL, NULL, 40, false, true, '{}'),
	('d6bb710f-d58e-45d5-abc6-5718ec8cb16b', '1af1c2ea-5d14-42cc-973c-b96eaa8850f0', 'approved', 'Freigegeben', NULL, NULL, NULL, 30, false, true, '{}'),
	('384c9963-7b78-4e48-ab80-7e5f3cfe53bd', '1af1c2ea-5d14-42cc-973c-b96eaa8850f0', 'in_review', 'Zur Freigabe', NULL, NULL, NULL, 20, false, true, '{}'),
	('fd72703f-a4e7-4513-a1b6-b659d83310a9', '1af1c2ea-5d14-42cc-973c-b96eaa8850f0', 'draft', 'Entwurf', NULL, NULL, NULL, 10, false, true, '{}'),
	('54532737-b096-4afa-911f-20a9e74d6d04', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'archived', 'Archiviert', NULL, NULL, NULL, 90, true, true, '{}'),
	('ce2fd22b-eb80-4580-95a8-664722d4db4a', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'obsolete', 'Veraltet', NULL, NULL, NULL, 80, false, true, '{}'),
	('b86cd7d8-a79e-4f5f-b280-0a4513d9b2a5', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'superseded', 'Ersetzt', NULL, NULL, NULL, 70, false, true, '{}'),
	('46a1564e-c0e7-46b7-afa4-ad5ed0bcd600', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'under_revision', 'In Revision', NULL, NULL, NULL, 60, false, true, '{}'),
	('f7f29cfe-68f2-4e07-a315-38755ce1bac4', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'active', 'Gueltig', NULL, NULL, NULL, 50, false, true, '{}'),
	('6d0a5fc4-2e42-417e-a1b3-ed13f6298450', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'released', 'Freigegeben', NULL, NULL, NULL, 40, false, true, '{}'),
	('9580d81e-7b0f-4650-b6d2-26f01816cfea', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'approval_pending', 'Freigabe ausstehend', NULL, NULL, NULL, 30, false, true, '{}'),
	('b6131183-f277-4917-831f-bb14d5a9b3fc', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'technical_review', 'Fachpruefung', NULL, NULL, NULL, 20, false, true, '{}'),
	('c139ca5b-9015-43c6-a6e4-7a782573e7de', 'a6332809-0467-466d-b3c9-66c77bae68f2', 'draft', 'Entwurf', NULL, NULL, NULL, 10, false, true, '{}');


--
-- Data for Name: document_type_definition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_type_definition VALUES
	('531365af-2048-447c-8a9a-78c98e54d2c4', 'documentation', 'Dokumentation', 'Allgemeine Dokumentation.', NULL, NULL, true, false, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('dda09407-1252-4728-a725-f8cf2ba9de62', 'concept', 'Konzept', 'Konzept- und Entwurfsdokument.', NULL, NULL, true, false, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('8a531b5f-1d78-422e-923d-85c53485194b', 'guideline', 'Leitlinie', 'Leitlinie oder verbindliche Orientierung.', NULL, NULL, true, false, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('7d527e84-4461-44dc-8cf6-d2fb27edd328', 'standard', 'Standard', 'Standardisierte Vorgabe.', NULL, NULL, true, false, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('b99fc862-dd73-4cb2-8804-52a8dda99a3e', 'operations_manual', 'Betriebshandbuch', 'Betriebsnahes Handbuch.', NULL, NULL, true, false, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('3ab4e49e-219d-4939-8696-6d4bb8ee9a51', 'internal_documentation', 'Interne Dokumentation', 'Interne Wissensdokumentation.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('82bfc9af-06c9-4395-8e20-6595ba70b42f', 'idea_collection', 'Ideensammlung', 'Sammlung offener Ideen.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('26ec0999-eead-4007-95b2-bc5ddab33647', 'decision_record', 'Entscheidungsprotokoll', 'Nachvollziehbare Entscheidung.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('1d661439-a929-4d4e-95e1-9dddff8df764', 'meeting_notes', 'Besprechungsnotiz', 'Protokoll oder Meeting-Notizen.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('1a097837-1002-4289-a973-6fb4850b6b62', 'process', 'Prozessbeschreibung', 'Beschreibung eines Prozesses.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('1fff3403-3ec9-42f1-b7a0-4df1d8731985', 'policy', 'Richtlinie', 'Formale Richtlinie.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('b90e46ff-8a68-494e-b7fe-2d6241401eca', 'runbook', 'Runbook', 'Operatives Runbook.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('89ff6d1f-f2c3-4b60-b3e1-3605914369b1', 'specification', 'Spezifikation', 'Technische oder fachliche Spezifikation.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('e3d22ed7-088b-4604-aec8-aed12700286e', 'report', 'Bericht', 'Bericht oder Auswertung.', NULL, NULL, true, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:41.142691+00'),
	('cb01c9f9-2535-410c-a180-e5561547d1ab', 'template', 'Vorlage', 'Vorlage fuer neue Dokumente.', NULL, NULL, false, true, NULL, '2026-08-11 16:58:41.142691+00', NULL, '2026-08-11 16:58:43.56981+00');


--
-- Data for Name: document_version_policy; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_version_policy VALUES
	('715b1ee8-a0b4-45e4-86fb-578cc9295053', 'global', NULL, 'Global default', true, true, 'simple_counter', NULL, 'utc', '{on-pdf-export}', 10, false, true, true, false, '{}', NULL, '2026-08-11 16:58:41.310695+00', NULL, '2026-08-11 16:58:45.976946+00');


--
-- Data for Name: language_definition; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.language_definition VALUES
	('85358ae5-b158-40ea-b117-6292db3c07e1', 'en', 'English', 'English', 10, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('9b485b77-380d-4dba-8f04-196f117b2753', 'de', 'German', 'Deutsch', 20, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('0e85bf55-0839-4ad3-b895-811c146ce1a2', 'fr', 'French', 'français', 30, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('b8929515-ec1e-4960-b201-e7b127a62eaf', 'it', 'Italian', 'italiano', 40, true, '{}', NULL, '2026-08-11 16:58:44.864117+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('80e00f88-9dee-4812-b168-da38b63c1e94', 'es', 'Spanish', 'español', 50, true, '{}', NULL, '2026-08-11 16:58:43.56981+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('047b340e-dbde-4a9c-b9c4-c3c8d2df6f0e', 'es-AR', 'Spanish (Argentina)', 'español (Argentina)', 60, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('c61bd6f0-cb02-430b-b69a-1c67c732c671', 'es-CL', 'Spanish (Chile)', 'español (Chile)', 70, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('63f0d607-af05-4832-ad19-cdaa80e1bc8b', 'pl', 'Polish', 'Polski', 80, true, '{}', NULL, '2026-08-11 16:58:44.864117+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('c5d5b5bc-8213-4f42-baaa-c973e8df8fd6', 'uk', 'Ukrainian', 'українська', 90, true, '{}', NULL, '2026-08-11 16:58:44.864117+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('5571ffbe-1774-459b-83d7-6dbc7be883d4', 'nl', 'Dutch', 'Nederlands', 100, true, '{}', NULL, '2026-08-11 16:58:44.864117+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('ee92d3ec-48ed-4651-b792-6eab1ee64df0', 'pt-BR', 'Portuguese (Brazil)', 'português (Brasil)', 110, true, '{}', NULL, '2026-08-11 16:58:44.864117+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('9f31ee48-120b-46de-8de9-fb907b385367', 'el-GR', 'Greek', 'Ελληνικά', 120, true, '{}', NULL, '2026-08-11 16:58:44.864117+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('7ef57db8-ea61-4fad-9156-f0d5fb223793', 'zh-Hans', 'Chinese (Simplified)', '简体中文', 130, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('272b7893-7660-406f-bd75-99136c591f90', 'zh-Hant', 'Chinese (Traditional)', '繁體中文', 140, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('eedceb93-0401-480b-adfe-b233ff6975fb', 'ru', 'Russian', 'русский', 150, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('8b6c9c72-832a-44d0-91ff-8fc055013590', 'ja', 'Japanese', '日本語', 160, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('5d26282c-a444-4d6f-b418-1abf5d7429b2', 'ca', 'Catalan', 'català', 170, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('b1d7c53f-96bf-4f86-a1fa-b306829431c4', 'sv-SE', 'Swedish (Sweden)', 'svenska (Sverige)', 180, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('fd933597-5726-42ca-9abf-8874402ca89a', 'ar', 'Arabic', 'العربية', 190, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('5a682b56-99ab-4132-a584-abe2b9982ae9', 'fa', 'Persian', 'فارسی', 200, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('6618facc-993f-4aee-99f9-e4d3a989df1f', 'ko', 'Korean (South Korea)', '한국어(대한민국)', 210, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('80bdd955-6186-4112-aa54-b6830a6d0ece', 'nb-NO', 'Norwegian (Bokmål)', 'Norsk (Bokmål)', 220, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('3d8873ba-829f-49b0-b18d-fbb7bbd7b2a9', 'cs', 'Czech', 'Čeština', 230, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('017c3f8e-9dcd-45c8-a1c4-6fada07acfeb', 'hu', 'Hungarian', 'magyar', 240, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('91660852-f5c8-41e1-8291-738258d73cd2', 'sk', 'Slovak', 'slovenčina', 250, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('289c3324-d397-4fec-8cb8-2cc45aaa790c', 'ro', 'Romanian', 'română', 260, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('65d6f195-8a98-40ab-918f-03be4a390732', 'hr', 'Croatian', 'hrvatski', 270, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00'),
	('ea1e8180-09e5-443d-9b54-941802010af1', 'sr', 'Serbian (Latin)', 'srpski (latinica)', 280, true, '{}', NULL, '2026-08-11 16:58:52.688564+00', NULL, '2026-08-11 16:58:52.688564+00');


--
-- Data for Name: organization; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization VALUES
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'myoxus', 'Myoxus Organisation', 'myoxus', '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:43.290632+00');


--
-- Data for Name: organization_document_audience_default; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_document_audience_default VALUES
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'ad580ec8-270e-4157-a482-28a33d859cac', 10);


--
-- Data for Name: organization_document_metadata_epoch; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_document_metadata_epoch VALUES
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'policy', 4, NULL, '2026-08-11 16:58:44.864117+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'defaults', 3, NULL, '2026-08-11 16:58:46.771661+00');


--
-- Data for Name: organization_document_metadata_policy; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_document_metadata_policy VALUES
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'createdAt', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'updatedAt', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'createdBy', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'updatedBy', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'metadataRevision', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'status', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'documentType', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'version', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'responsible', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'reviewDueAt', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'validFrom', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'validUntil', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'classification', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'documentNumber', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'language', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'audience', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'retentionPolicy', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'templateState', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'journalDate', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:43.56981+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'primaryMode', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:44.864117+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'pageWidth', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:44.864117+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'edgelessColorTheme', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:44.864117+00'),
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'integrationType', true, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-08-11 16:58:44.864117+00');


--
-- Data for Name: organization_document_settings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_document_settings VALUES
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', '2f07f8b3-29df-4b0e-9939-e9fff2432f21', '309df525-f0a2-47e1-976b-1ad09f268eaf', '531365af-2048-447c-8a9a-78c98e54d2c4', '47db41f9-cb1a-41e4-8859-e568645ef030', '7e0e3ffc-bebf-4981-b3e7-6a4ad927dde4', '85358ae5-b158-40ea-b117-6292db3c07e1', NULL, 0, NULL, '2026-08-11 16:58:46.771661+00');


--
-- Data for Name: organization_identity; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_identity VALUES
	(true, NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, '2026-08-11 16:58:42.759066+00', '2026-08-11 16:58:42.759066+00', NULL);


--
-- Data for Name: organization_policy; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_policy VALUES
	('f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'requires_approval', 'allowed', true, true, true, '{}', NULL, '2026-08-11 16:58:41.660067+00');


--
-- Data for Name: organization_unit_type; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.organization_unit_type VALUES
	('844d6db6-f492-44f7-8790-2d109b478f2b', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'team', 'Team', 'Operatives Team — leaf-default (kein Produkt-Team-Modul, vgl. Konzept § Festgelegte Produktentscheidungen)', NULL, NULL, true, true, true, false, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:41.660067+00'),
	('35606eaf-d06b-40fa-9b5b-0c852f25e4b2', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'standort', 'Standort', 'Geographische Niederlassung', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:41.660067+00'),
	('7c1b7e3e-b956-4ce2-bf77-c0dabfe37894', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'projekt', 'Projekt', 'Cross-unit Projekt mit eigenem Workspace', NULL, NULL, true, true, false, false, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:41.660067+00'),
	('7344d832-4efb-4e72-a79d-264d6a28cba9', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.dienststelle', 'Dienststelle', 'Aussenstelle / Dienststelle', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('fe989ab0-13f7-46ad-a555-304a8ddf3cf3', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.standort', 'Standort', 'Geographischer Standort', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('61e9e837-e6a2-418d-a52f-45f8eb1c6fbb', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.stabsstelle', 'Stabsstelle', 'Leitungs-Stabsstelle (querliegend)', NULL, NULL, true, true, false, true, false, false, false, true, true, true, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('658344f7-d141-4689-a035-a9531d59401c', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.projekt', 'Projekt', 'Cross-unit Projekt', NULL, NULL, true, true, false, false, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('6f12ebd6-dcc6-4492-a0e5-416916df8e9a', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.dienststelle', 'Dienststelle', 'Aussenstelle', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('6afd8055-5324-4cdd-9d58-3e729b9b7e1c', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.standort', 'Standort', 'Standort', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('d1b80877-4292-4a68-a82e-0138f89db31c', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.stabsstelle', 'Stabsstelle', 'Leitungs-Stabsstelle', NULL, NULL, true, true, false, true, false, false, false, true, true, true, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('af2bfcc2-b511-4700-ba14-f6d714f96fd7', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.projekt', 'Projekt', 'Cross-unit Projekt', NULL, NULL, true, true, false, false, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('1d09f115-7a6b-4efd-a142-76097d0ad250', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.standort', 'Standort', 'Standort', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('aa189e7f-8afb-43e6-be7b-476fe1d5b6ac', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.tochtergesellschaft', 'Tochtergesellschaft', 'Konsolidierte Tochter', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('498cd677-32b7-4458-b179-3dfcfbb3a645', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.beteiligung', 'Beteiligung', 'Equity-Beteiligung', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('612d237d-3a1e-4566-a0a5-f3b474edf13c', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.stabsstelle', 'Stabsstelle', 'Stabsstelle', NULL, NULL, true, true, false, true, false, false, false, true, true, true, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('8d687707-6687-4962-99d2-4f2124035ecf', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.projekt', 'Projekt', 'Cross-unit Projekt', NULL, NULL, true, true, false, false, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('c4fa185d-3a6b-401e-baa4-b7293f5b4f89', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.projekt', 'Projekt', 'Cross-unit Projekt (Matrix)', NULL, NULL, true, true, false, false, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:41.845556+00'),
	('30bb1fd8-a122-4749-ba27-c9d5e50ff562', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'organisation', 'Organisation', 'Top-level organisation root', NULL, NULL, true, true, true, true, true, false, false, true, false, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:56.168514+00'),
	('6a1696f3-d593-4df7-9bc8-1ea968bdd45b', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'bereich', 'Bereich', 'Linienbereich', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:56.168514+00'),
	('523f29c6-c83a-4105-857c-2e81081749b0', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'arbeitsgruppe', 'Arbeitsgruppe', 'Cross-unit Arbeitsgruppe', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:56.168514+00'),
	('1cc87c64-ba75-44cf-80a0-cc1d144c63af', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'initiative', 'Initiative', 'Cross-unit Initiative', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.660067+00', '2026-08-11 16:58:56.168514+00'),
	('304f9c18-88f5-4a32-b617-c4f28e5f28b1', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.gesamtorganisation', 'Gesamtorganisation', 'Wurzel der Verwaltung', NULL, NULL, true, true, true, true, true, false, false, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('ee1dd8fb-d11c-4325-b27b-a811912b6cf9', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.geschaeftskreis', 'Geschäftskreis', 'Politische Leitungseinheit', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('388fefad-f715-4769-b23c-039d060dd0ea', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.referat', 'Referat', 'Fachreferat', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('4c2f0ab9-47c7-4b0c-86d1-4258be349a81', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.amt', 'Amt', 'Verwaltungsamt', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('acf90e67-4b10-45e2-8126-7f465a13cff2', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.eigenbetrieb', 'Eigenbetrieb', 'Wirtschaftlich selbstaendiger Betrieb', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('82f51c65-7e54-45dc-b2db-31ed514a56a0', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.abteilung', 'Abteilung', 'Abteilung innerhalb eines Amts', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('8449725f-b318-4bca-aaf2-5cc94dd081d7', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.sachgebiet', 'Sachgebiet', 'Sachgebiet innerhalb einer Abteilung', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('0ec873b0-665e-4b22-88ac-bb2b8b9b758f', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.team', 'Team', 'Operatives Team (fachlich, nicht Produkt-Team)', NULL, NULL, true, true, true, false, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('d0daeefe-c4a8-43f7-8cb2-1be65ff9673e', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.arbeitsgruppe', 'Arbeitsgruppe', 'Cross-unit Arbeitsgruppe', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('6f91c41a-35a9-4b8c-9ad3-65a678a1eb9f', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.gremium', 'Gremium', 'Sitzungsgremium', NULL, NULL, true, true, false, false, true, false, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('a0f66cab-da8d-44e1-809f-7eedba36ed43', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvg.programm', 'Programm', 'Programm mit Unterprojekten', NULL, NULL, true, true, false, true, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('c3ee35e5-d3d1-4315-89df-ac5fc42e4958', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.gesamtorganisation', 'Gesamtorganisation', 'Wurzel der Verwaltung', NULL, NULL, true, true, true, true, true, false, false, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('774cadef-40e2-4e2c-92c8-bdd0e5248168', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.dezernat', 'Dezernat', 'Dezernatsleitung', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('65cdc9f9-fbb4-4235-9fa6-6d6cb0140795', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.fachbereich', 'Fachbereich', 'Fachbereich', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('d37b72fc-655b-493a-bc96-c8298708dc7c', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.amt', 'Amt', 'Amt', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('9add4af7-e112-4076-979c-d95270133d7a', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.bereich', 'Bereich', 'Bereich', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('2fa6a253-bfc6-498e-9a49-6dc1f637640d', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.sachgebiet', 'Sachgebiet', 'Sachgebiet', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('db4d72de-ad30-45df-bdce-e362d9ef6d09', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.team', 'Team', 'Operatives Team', NULL, NULL, true, true, true, false, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('cf684e98-53d5-4368-92e8-4361e41c995f', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.arbeitsgruppe', 'Arbeitsgruppe', 'Cross-unit Arbeitsgruppe', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('d0e47506-b71e-4502-8db2-47886681f28d', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'kvk.gremium', 'Gremium', 'Sitzungsgremium', NULL, NULL, true, true, false, false, true, false, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('8376c7ac-f4c7-45aa-89fb-0b2f5a2d148e', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.organisation', 'Organisation', 'Holding / Top-Level', NULL, NULL, true, true, true, true, true, false, false, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('7bdb5594-9f18-4142-8ce5-b165e2280c72', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.geschaeftsbereich', 'Geschäftsbereich', 'Strategischer Geschaeftsbereich', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('c7e73671-90f2-43be-bcaa-50c0d98e2dfd', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.bereich', 'Bereich', 'Bereich', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('60354955-6887-4aa5-8775-955a0ff6e6e5', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.abteilung', 'Abteilung', 'Abteilung', NULL, NULL, true, true, true, true, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('8a7c6c40-174f-4958-b059-aabe56e43628', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.team', 'Team', 'Operatives Team', NULL, NULL, true, true, true, false, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('95887f61-33f4-43ee-8bd9-b4b8222e7f7b', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.programm', 'Programm', 'Programm mit Unterprojekten', NULL, NULL, true, true, false, true, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('39b783ed-dd90-4685-a772-aa5b8629e43b', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.arbeitsgruppe', 'Arbeitsgruppe', 'Cross-unit Arbeitsgruppe', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('c361971c-6c0d-4844-9813-bbf249fb9a5e', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'wt.committee', 'Committee', 'Steering / Audit Committee', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('9de38996-dd94-4de4-9f35-c6e0a23cb1cd', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.organisation', 'Organisation', 'Wurzel', NULL, NULL, true, true, true, true, true, false, false, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('54c238c9-c899-41be-aec8-e6cc793d1f08', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.fachbereich', 'Fachbereich', 'Linien-Fachbereich', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('3ed18f22-aa07-40ae-9760-232f47cd1b81', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.linie', 'Linie', 'Linienorganisation', NULL, NULL, true, true, true, true, true, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('fe551a1c-8567-43d9-8469-673d7644c7c8', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.team', 'Team', 'Linien-Team', NULL, NULL, true, true, true, false, false, false, false, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('2aa5fb51-b552-46a6-b81a-30253ea6c63e', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.programm', 'Programm', 'Programm (Matrix)', NULL, NULL, true, true, false, true, true, true, true, true, true, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('250b5d2f-e44b-45bf-9b13-5d0c92d54904', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.arbeitsgruppe', 'Arbeitsgruppe', 'Cross-unit Arbeitsgruppe', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('f3a91502-f0d4-4f9c-b25e-c985d362b9e2', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.community_of_practice', 'Community of Practice', 'Cross-unit CoP', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00'),
	('10794fb8-64e6-4c92-918d-012c0650205b', 'f844cd73-9fa9-4dc2-acdc-8558cba7b058', 'mx.gremium', 'Gremium', 'Sitzungsgremium', NULL, NULL, true, true, false, false, true, true, true, true, false, false, false, '{}', '2026-08-11 16:58:41.845556+00', '2026-08-11 16:58:56.168514+00');


--
-- Data for Name: template_catalog_entries; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.template_catalog_entries VALUES
	('e47543cd-55e5-46c3-a436-76450bef993f', 'welcome-myoxus', 'Welcome to Myoxus', 'Introduction to Myoxus features and getting started guide', 'onboarding', '{welcome,onboarding,getting-started}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('964ad000-caa9-4405-b5f2-d262d044eb98', 'getting-started-myoxus', 'Getting Started with Myoxus', 'Step-by-step guide to set up your first workspace', 'onboarding', '{onboarding,setup,guide}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('1b8e1940-c073-42ea-976b-34a2a12c8493', 'business-daily', 'Business Daily', 'Daily business planning with priorities and follow-ups', 'journal-daily', '{daily,planning,business}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('fc9b7fee-44ca-47f7-8f94-a90cf0db2a46', 'time-blocking', 'Time Blocking', 'Schedule your day in focused time blocks', 'journal-daily', '{time-management,scheduling,focus}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('11815dfa-5eac-4cc6-8394-e001f467773d', 'eisenhower', 'Eisenhower Matrix', 'Prioritize tasks by urgency and importance', 'journal-daily', '{prioritization,task-management,decision-making}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('5556a459-b1b1-40f0-9257-e63a7a7a04f7', 'agile-standup', 'Agile Standup', 'Daily standup notes: done, doing, blockers', 'journal-daily', '{agile,standup,engineering}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('d2ccb641-8da9-443c-892f-736c0550790e', 'personal-journal', 'Personal Journal', 'Daily journaling with mood tracking and reflections', 'journal-daily', '{journal,reflection,personal}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('89ed2474-23ed-402f-8ef9-903a025d75af', 'meeting-notes', 'Meeting Notes', 'Structured meeting notes with agenda, decisions, and action items', 'meeting', '{meetings,notes,collaboration}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('f297c184-f3f8-40fb-a4a0-ba5d1fdb1935', 'gtd-weekly-review', 'GTD Weekly Review', 'Getting Things Done weekly review checklist', 'review-weekly', '{gtd,weekly,review,productivity}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('a067ee5f-431f-4703-b29f-0427ebcad7f9', 'agile-retro', 'Agile Retrospective', 'Sprint retrospective: what went well, what to improve, action items', 'review-sprint', '{agile,retrospective,engineering}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('ea341e83-57a6-4f2c-ad0c-6891b25e0d73', 'hybrid-day-sprint', 'Hybrid Day Sprint', 'Plan a hybrid work day with remote and in-office blocks', 'hybrid', '{hybrid,remote,planning}', 'active', NULL, '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0),
	('43e3775d-0fd9-43af-afbb-8511bd9e5ca0', 'using-folders-myoxus', 'Using Folders in Myoxus', 'Guide to organizing documents with folders, tags and collections', 'onboarding', '{onboarding,folders,organization}', 'active', NULL, '2026-08-11 16:58:47.792522+00', '2026-08-11 16:58:53.015303+00', NULL, 'builtin', 2, 0);


--
-- Data for Name: template_default_policies; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.template_default_policies VALUES
	('1b8e1940-c073-42ea-976b-34a2a12c8493', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('fc9b7fee-44ca-47f7-8f94-a90cf0db2a46', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('11815dfa-5eac-4cc6-8394-e001f467773d', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('5556a459-b1b1-40f0-9257-e63a7a7a04f7', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('d2ccb641-8da9-443c-892f-736c0550790e', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('89ed2474-23ed-402f-8ef9-903a025d75af', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('f297c184-f3f8-40fb-a4a0-ba5d1fdb1935', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('a067ee5f-431f-4703-b29f-0427ebcad7f9', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('ea341e83-57a6-4f2c-ad0c-6891b25e0d73', true, 'published', 'managed_until_local_edit', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('e47543cd-55e5-46c3-a436-76450bef993f', true, 'published', 'seed_once', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('964ad000-caa9-4405-b5f2-d262d044eb98', true, 'published', 'seed_once', '2026-08-11 16:58:38.98105+00', '2026-08-11 16:58:38.98105+00'),
	('43e3775d-0fd9-43af-afbb-8511bd9e5ca0', true, 'published', 'seed_once', '2026-08-11 16:58:47.792522+00', '2026-08-11 16:58:47.792522+00');


--
-- PostgreSQL database dump complete
--


--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: access_tokens access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_pkey PRIMARY KEY (id);


--
-- Name: access_tokens access_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: ai_workspace_doc_embeddings ai_workspace_doc_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_doc_embeddings
    ADD CONSTRAINT ai_workspace_doc_embeddings_pkey PRIMARY KEY (workspace_id, doc_id, chunk);


--
-- Name: ai_workspace_file_embeddings ai_workspace_file_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_file_embeddings
    ADD CONSTRAINT ai_workspace_file_embeddings_pkey PRIMARY KEY (workspace_id, file_id, chunk);


--
-- Name: ai_workspace_files ai_workspace_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_files
    ADD CONSTRAINT ai_workspace_files_pkey PRIMARY KEY (workspace_id, file_id);


--
-- Name: ai_workspace_ignored_docs ai_workspace_ignored_docs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_ignored_docs
    ADD CONSTRAINT ai_workspace_ignored_docs_pkey PRIMARY KEY (workspace_id, doc_id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_configs app_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_configs
    ADD CONSTRAINT app_configs_pkey PRIMARY KEY (id);


--
-- Name: app_server_branding app_server_branding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_server_branding
    ADD CONSTRAINT app_server_branding_pkey PRIMARY KEY (id);


--
-- Name: blobs blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (workspace_id, key);


--
-- Name: brand_assets brand_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_assets
    ADD CONSTRAINT brand_assets_pkey PRIMARY KEY (id);


--
-- Name: brand_identity_cutover_findings brand_identity_cutover_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_identity_cutover_findings
    ADD CONSTRAINT brand_identity_cutover_findings_pkey PRIMARY KEY (finding_key);


--
-- Name: branding_assets branding_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_pkey PRIMARY KEY (id);


--
-- Name: branding_assets branding_assets_profile_id_asset_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_profile_id_asset_type_key UNIQUE (profile_id, asset_type);


--
-- Name: branding_profiles branding_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_profiles
    ADD CONSTRAINT branding_profiles_pkey PRIMARY KEY (id);


--
-- Name: cache_tuning_metrics cache_tuning_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache_tuning_metrics
    ADD CONSTRAINT cache_tuning_metrics_pkey PRIMARY KEY (id);


--
-- Name: calendar_accounts calendar_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_accounts
    ADD CONSTRAINT calendar_accounts_pkey PRIMARY KEY (id);


--
-- Name: calendar_accounts calendar_accounts_provider_remote_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_accounts
    ADD CONSTRAINT calendar_accounts_provider_remote_account_id_key UNIQUE (provider, remote_account_id);


--
-- Name: calendar_event_instances calendar_event_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_instances
    ADD CONSTRAINT calendar_event_instances_pkey PRIMARY KEY (id);


--
-- Name: calendar_event_participants calendar_event_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_pkey PRIMARY KEY (id);


--
-- Name: calendar_event_source_links calendar_event_source_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_source_links
    ADD CONSTRAINT calendar_event_source_links_pkey PRIMARY KEY (id);


--
-- Name: calendar_event_tags calendar_event_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_tags
    ADD CONSTRAINT calendar_event_tags_pkey PRIMARY KEY (id);


--
-- Name: calendar_event_tags calendar_event_tags_workspace_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_tags
    ADD CONSTRAINT calendar_event_tags_workspace_id_name_key UNIQUE (workspace_id, name);


--
-- Name: calendar_events calendar_events_account_id_remote_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_account_id_remote_event_id_key UNIQUE (account_id, remote_event_id);


--
-- Name: calendar_events calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);


--
-- Name: calendar_pending_writes calendar_pending_writes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_pending_writes
    ADD CONSTRAINT calendar_pending_writes_pkey PRIMARY KEY (id);


--
-- Name: calendar_reminder_dispatch_log calendar_reminder_dispatch_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminder_dispatch_log
    ADD CONSTRAINT calendar_reminder_dispatch_log_pkey PRIMARY KEY (reminder_id);


--
-- Name: calendar_reminders calendar_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminders
    ADD CONSTRAINT calendar_reminders_pkey PRIMARY KEY (id);


--
-- Name: calendar_subscriptions calendar_subscriptions_account_id_remote_calendar_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_subscriptions
    ADD CONSTRAINT calendar_subscriptions_account_id_remote_calendar_id_key UNIQUE (account_id, remote_calendar_id);


--
-- Name: calendar_subscriptions calendar_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_subscriptions
    ADD CONSTRAINT calendar_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: color_schema_values color_schema_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_schema_values
    ADD CONSTRAINT color_schema_values_pkey PRIMARY KEY (schema_id, mode, token_key);


--
-- Name: color_schemas color_schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_schemas
    ADD CONSTRAINT color_schemas_pkey PRIMARY KEY (id);


--
-- Name: color_schemas color_schemas_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_schemas
    ADD CONSTRAINT color_schemas_slug_key UNIQUE (slug);


--
-- Name: comment_attachments comment_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_attachments
    ADD CONSTRAINT comment_attachments_pkey PRIMARY KEY (id);


--
-- Name: comment_edit_history comment_edit_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_edit_history
    ADD CONSTRAINT comment_edit_history_pkey PRIMARY KEY (id);


--
-- Name: comment_thread_read_state comment_thread_read_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_thread_read_state
    ADD CONSTRAINT comment_thread_read_state_pkey PRIMARY KEY (user_id, thread_comment_id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: config_changelog config_changelog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_changelog
    ADD CONSTRAINT config_changelog_pkey PRIMARY KEY (id);


--
-- Name: connected_accounts connected_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_pkey PRIMARY KEY (id);


--
-- Name: connected_accounts connected_accounts_provider_provider_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_provider_provider_account_id_key UNIQUE (provider, provider_account_id);


--
-- Name: copilot_context_items copilot_context_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_context_items
    ADD CONSTRAINT copilot_context_items_pkey PRIMARY KEY (id);


--
-- Name: copilot_contexts copilot_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_contexts
    ADD CONSTRAINT copilot_contexts_pkey PRIMARY KEY (id);


--
-- Name: copilot_embeddings copilot_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_embeddings
    ADD CONSTRAINT copilot_embeddings_pkey PRIMARY KEY (id);


--
-- Name: copilot_embeddings copilot_embeddings_workspace_id_source_type_source_id_chunk_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_embeddings
    ADD CONSTRAINT copilot_embeddings_workspace_id_source_type_source_id_chunk_key UNIQUE (workspace_id, source_type, source_id, chunk_index, model);


--
-- Name: copilot_jobs copilot_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_jobs
    ADD CONSTRAINT copilot_jobs_pkey PRIMARY KEY (id);


--
-- Name: copilot_message_revisions copilot_message_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_message_revisions
    ADD CONSTRAINT copilot_message_revisions_pkey PRIMARY KEY (id);


--
-- Name: copilot_messages copilot_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_messages
    ADD CONSTRAINT copilot_messages_pkey PRIMARY KEY (id);


--
-- Name: copilot_sessions copilot_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_sessions
    ADD CONSTRAINT copilot_sessions_pkey PRIMARY KEY (id);


--
-- Name: copilot_transcripts copilot_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_transcripts
    ADD CONSTRAINT copilot_transcripts_pkey PRIMARY KEY (id);


--
-- Name: copilot_transcripts copilot_transcripts_workspace_id_source_type_source_id_mode_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_transcripts
    ADD CONSTRAINT copilot_transcripts_workspace_id_source_type_source_id_mode_key UNIQUE (workspace_id, source_type, source_id, model);


--
-- Name: copilot_workspaces copilot_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_workspaces
    ADD CONSTRAINT copilot_workspaces_pkey PRIMARY KEY (workspace_id);


--
-- Name: database_activity_events database_activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_activity_events
    ADD CONSTRAINT database_activity_events_pkey PRIMARY KEY (id);


--
-- Name: database_import_jobs database_import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_import_jobs
    ADD CONSTRAINT database_import_jobs_pkey PRIMARY KEY (id);


--
-- Name: database_profiles database_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_profiles
    ADD CONSTRAINT database_profiles_pkey PRIMARY KEY (database_id);


--
-- Name: database_row_reminders database_row_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT database_row_reminders_pkey PRIMARY KEY (id);


--
-- Name: database_unique_id_sequences database_unique_id_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_unique_id_sequences
    ADD CONSTRAINT database_unique_id_sequences_pkey PRIMARY KEY (field_id);


--
-- Name: database_view_roles database_view_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_view_roles
    ADD CONSTRAINT database_view_roles_pkey PRIMARY KEY (database_id, role_key);


--
-- Name: database_view_user_states database_view_user_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_view_user_states
    ADD CONSTRAINT database_view_user_states_pkey PRIMARY KEY (view_id, user_id);


--
-- Name: doc_audience_assignment doc_audience_assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_audience_assignment
    ADD CONSTRAINT doc_audience_assignment_pkey PRIMARY KEY (doc_id, audience_id);


--
-- Name: doc_histories doc_histories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_histories
    ADD CONSTRAINT doc_histories_pkey PRIMARY KEY (id);


--
-- Name: doc_snapshots doc_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_pkey PRIMARY KEY (doc_id);


--
-- Name: doc_updates doc_updates_doc_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_doc_id_sequence_key UNIQUE (doc_id, sequence);


--
-- Name: doc_updates doc_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_pkey PRIMARY KEY (id);


--
-- Name: doc_user_permissions doc_user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_user_permissions
    ADD CONSTRAINT doc_user_permissions_pkey PRIMARY KEY (user_id, doc_id);


--
-- Name: docs docs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_pkey PRIMARY KEY (id);


--
-- Name: document_audience_definition document_audience_definition_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_audience_definition
    ADD CONSTRAINT document_audience_definition_key_key UNIQUE (key);


--
-- Name: document_audience_definition document_audience_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_audience_definition
    ADD CONSTRAINT document_audience_definition_pkey PRIMARY KEY (id);


--
-- Name: document_brand_profiles document_brand_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_brand_profiles
    ADD CONSTRAINT document_brand_profiles_pkey PRIMARY KEY (id);


--
-- Name: document_classification_definition document_classification_definition_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_classification_definition
    ADD CONSTRAINT document_classification_definition_key_key UNIQUE (key);


--
-- Name: document_classification_definition document_classification_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_classification_definition
    ADD CONSTRAINT document_classification_definition_pkey PRIMARY KEY (id);


--
-- Name: document_graph_index_state document_graph_index_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_index_state
    ADD CONSTRAINT document_graph_index_state_pkey PRIMARY KEY (workspace_id, doc_id);


--
-- Name: document_graph_occurrences document_graph_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_occurrences
    ADD CONSTRAINT document_graph_occurrences_pkey PRIMARY KEY (id);


--
-- Name: document_initial_sync_audit document_initial_sync_audit_doc_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_doc_id_idempotency_key_key UNIQUE (doc_id, idempotency_key);


--
-- Name: document_initial_sync_audit document_initial_sync_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_pkey PRIMARY KEY (id);


--
-- Name: document_integration_state document_integration_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_integration_state
    ADD CONSTRAINT document_integration_state_pkey PRIMARY KEY (doc_id);


--
-- Name: document_metadata_field_definition document_metadata_field_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_metadata_field_definition
    ADD CONSTRAINT document_metadata_field_definition_pkey PRIMARY KEY (key);


--
-- Name: document_metadata_global_epoch document_metadata_global_epoch_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_metadata_global_epoch
    ADD CONSTRAINT document_metadata_global_epoch_pkey1 PRIMARY KEY (epoch_name);


--
-- Name: document_presentation_state document_presentation_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_presentation_state
    ADD CONSTRAINT document_presentation_state_pkey PRIMARY KEY (doc_id);


--
-- Name: document_retention_policy_definition document_retention_policy_definition_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retention_policy_definition
    ADD CONSTRAINT document_retention_policy_definition_key_key UNIQUE (key);


--
-- Name: document_retention_policy_definition document_retention_policy_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retention_policy_definition
    ADD CONSTRAINT document_retention_policy_definition_pkey PRIMARY KEY (id);


--
-- Name: document_status_schema document_status_schema_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_schema
    ADD CONSTRAINT document_status_schema_key_key UNIQUE (key);


--
-- Name: document_status_schema document_status_schema_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_schema
    ADD CONSTRAINT document_status_schema_pkey PRIMARY KEY (id);


--
-- Name: document_status_transition document_status_transition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_transition
    ADD CONSTRAINT document_status_transition_pkey PRIMARY KEY (from_status_id, to_status_id);


--
-- Name: document_status_value document_status_value_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_value
    ADD CONSTRAINT document_status_value_pkey PRIMARY KEY (id);


--
-- Name: document_status_value document_status_value_schema_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_value
    ADD CONSTRAINT document_status_value_schema_id_id_unique UNIQUE (schema_id, id);


--
-- Name: document_status_value document_status_value_schema_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_value
    ADD CONSTRAINT document_status_value_schema_id_key_key UNIQUE (schema_id, key);


--
-- Name: document_template_state document_template_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_template_state
    ADD CONSTRAINT document_template_state_pkey PRIMARY KEY (doc_id);


--
-- Name: document_theme_color_palettes document_theme_color_palettes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_theme_color_palettes
    ADD CONSTRAINT document_theme_color_palettes_pkey PRIMARY KEY (theme_id, palette_key);


--
-- Name: document_type_definition document_type_definition_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_definition
    ADD CONSTRAINT document_type_definition_key_key UNIQUE (key);


--
-- Name: document_type_definition document_type_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_definition
    ADD CONSTRAINT document_type_definition_pkey PRIMARY KEY (id);


--
-- Name: document_type_status_default document_type_status_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_status_default
    ADD CONSTRAINT document_type_status_default_pkey PRIMARY KEY (document_type_id, status_schema_id);


--
-- Name: document_version_artifact document_version_artifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_artifact
    ADD CONSTRAINT document_version_artifact_pkey PRIMARY KEY (id);


--
-- Name: document_version document_version_doc_id_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_doc_id_label_key UNIQUE (doc_id, label);


--
-- Name: document_version_label_counter document_version_label_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_label_counter
    ADD CONSTRAINT document_version_label_counter_pkey PRIMARY KEY (doc_id, counter_key);


--
-- Name: document_version document_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_pkey PRIMARY KEY (id);


--
-- Name: document_version_policy document_version_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_policy
    ADD CONSTRAINT document_version_policy_pkey PRIMARY KEY (id);


--
-- Name: document_version_relation document_version_relation_from_version_id_to_version_id_rel_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_relation
    ADD CONSTRAINT document_version_relation_from_version_id_to_version_id_rel_key UNIQUE (from_version_id, to_version_id, relation);


--
-- Name: document_version_relation document_version_relation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_relation
    ADD CONSTRAINT document_version_relation_pkey PRIMARY KEY (id);


--
-- Name: document_versioning_settings document_versioning_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versioning_settings
    ADD CONSTRAINT document_versioning_settings_pkey PRIMARY KEY (doc_id);


--
-- Name: document_versioning_workspace_settings document_versioning_workspace_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versioning_workspace_settings
    ADD CONSTRAINT document_versioning_workspace_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: document_workspace_settings document_workspace_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: font_assets font_assets_family_id_usage_format_style_weight_min_weight__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.font_assets
    ADD CONSTRAINT font_assets_family_id_usage_format_style_weight_min_weight__key UNIQUE (family_id, usage, format, style, weight_min, weight_max, asset_key);


--
-- Name: font_assets font_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.font_assets
    ADD CONSTRAINT font_assets_pkey PRIMARY KEY (id);


--
-- Name: font_families font_families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.font_families
    ADD CONSTRAINT font_families_pkey PRIMARY KEY (id);


--
-- Name: font_families font_families_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.font_families
    ADD CONSTRAINT font_families_slug_key UNIQUE (slug);


--
-- Name: git_sync_baselines git_sync_baselines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_baselines
    ADD CONSTRAINT git_sync_baselines_pkey PRIMARY KEY (binding_id);


--
-- Name: git_sync_bindings git_sync_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_bindings
    ADD CONSTRAINT git_sync_bindings_pkey PRIMARY KEY (id);


--
-- Name: git_sync_blob_promotions git_sync_blob_promotions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_blob_promotions
    ADD CONSTRAINT git_sync_blob_promotions_pkey PRIMARY KEY (id);


--
-- Name: git_sync_blob_promotions git_sync_blob_promotions_run_id_final_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_blob_promotions
    ADD CONSTRAINT git_sync_blob_promotions_run_id_final_key_key UNIQUE (run_id, final_key);


--
-- Name: git_sync_bootstrap_attempts git_sync_bootstrap_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_bootstrap_attempts
    ADD CONSTRAINT git_sync_bootstrap_attempts_pkey PRIMARY KEY (id);


--
-- Name: git_sync_conflicts git_sync_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_conflicts
    ADD CONSTRAINT git_sync_conflicts_pkey PRIMARY KEY (id);


--
-- Name: git_sync_credentials git_sync_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_credentials
    ADD CONSTRAINT git_sync_credentials_pkey PRIMARY KEY (id);


--
-- Name: git_sync_file_baselines git_sync_file_baselines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_baselines
    ADD CONSTRAINT git_sync_file_baselines_pkey PRIMARY KEY (id);


--
-- Name: git_sync_file_baselines git_sync_file_baselines_profile_id_blob_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_baselines
    ADD CONSTRAINT git_sync_file_baselines_profile_id_blob_key_key UNIQUE (profile_id, blob_key);


--
-- Name: git_sync_file_bindings git_sync_file_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_bindings
    ADD CONSTRAINT git_sync_file_bindings_pkey PRIMARY KEY (id);


--
-- Name: git_sync_file_bindings git_sync_file_bindings_profile_id_repo_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_bindings
    ADD CONSTRAINT git_sync_file_bindings_profile_id_repo_path_key UNIQUE (profile_id, repo_path);


--
-- Name: git_sync_file_conflicts git_sync_file_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_conflicts
    ADD CONSTRAINT git_sync_file_conflicts_pkey PRIMARY KEY (id);


--
-- Name: git_sync_partial_items git_sync_partial_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_items
    ADD CONSTRAINT git_sync_partial_items_pkey PRIMARY KEY (id);


--
-- Name: git_sync_partial_sessions git_sync_partial_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_sessions
    ADD CONSTRAINT git_sync_partial_sessions_pkey PRIMARY KEY (id);


--
-- Name: git_sync_path_owners git_sync_path_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_path_owners
    ADD CONSTRAINT git_sync_path_owners_pkey PRIMARY KEY (profile_id, repo_path);


--
-- Name: git_sync_path_owners git_sync_path_owners_profile_id_owner_kind_owner_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_path_owners
    ADD CONSTRAINT git_sync_path_owners_profile_id_owner_kind_owner_id_key UNIQUE (profile_id, owner_kind, owner_id);


--
-- Name: git_sync_profiles git_sync_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_profiles
    ADD CONSTRAINT git_sync_profiles_pkey PRIMARY KEY (id);


--
-- Name: git_sync_runs git_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_runs
    ADD CONSTRAINT git_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: git_sync_ssh_host_keys git_sync_ssh_host_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_ssh_host_keys
    ADD CONSTRAINT git_sync_ssh_host_keys_pkey PRIMARY KEY (host, port, key_type);


--
-- Name: git_sync_version_links git_sync_version_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_version_links
    ADD CONSTRAINT git_sync_version_links_pkey PRIMARY KEY (id);


--
-- Name: git_sync_webhook_deliveries git_sync_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_webhook_deliveries
    ADD CONSTRAINT git_sync_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: git_sync_webhook_deliveries git_sync_webhook_deliveries_profile_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_webhook_deliveries
    ADD CONSTRAINT git_sync_webhook_deliveries_profile_id_dedupe_key_key UNIQUE (profile_id, dedupe_key);


--
-- Name: language_definition language_definition_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_definition
    ADD CONSTRAINT language_definition_key_key UNIQUE (key);


--
-- Name: language_definition language_definition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_definition
    ADD CONSTRAINT language_definition_pkey PRIMARY KEY (id);


--
-- Name: magic_link_otps magic_link_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_link_otps
    ADD CONSTRAINT magic_link_otps_pkey PRIMARY KEY (id);


--
-- Name: mcp_idempotency_keys mcp_idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_idempotency_keys
    ADD CONSTRAINT mcp_idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: metrics_daily metrics_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_daily
    ADD CONSTRAINT metrics_daily_pkey PRIMARY KEY (day, category, metric_name, labels);


--
-- Name: metrics_raw metrics_raw_bucket_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_raw
    ADD CONSTRAINT metrics_raw_bucket_unique UNIQUE (minute, category, metric_name, labels);


--
-- Name: metrics_raw metrics_raw_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_raw
    ADD CONSTRAINT metrics_raw_pkey PRIMARY KEY (id);


--
-- Name: multipart_blob_parts multipart_blob_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multipart_blob_parts
    ADD CONSTRAINT multipart_blob_parts_pkey PRIMARY KEY (workspace_id, key, upload_id, part_number);


--
-- Name: multipart_uploads multipart_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multipart_uploads
    ADD CONSTRAINT multipart_uploads_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: organization_document_audience_default organization_document_audience_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_audience_default
    ADD CONSTRAINT organization_document_audience_default_pkey PRIMARY KEY (organization_id, audience_id);


--
-- Name: organization_document_metadata_epoch organization_document_metadata_epoch_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_epoch
    ADD CONSTRAINT organization_document_metadata_epoch_pkey1 PRIMARY KEY (organization_id, epoch_name);


--
-- Name: organization_document_metadata_policy organization_document_metadata_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_policy
    ADD CONSTRAINT organization_document_metadata_policy_pkey PRIMARY KEY (organization_id, field_key);


--
-- Name: organization_document_settings organization_document_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_pkey PRIMARY KEY (organization_id);


--
-- Name: organization_identity organization_identity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_identity
    ADD CONSTRAINT organization_identity_pkey PRIMARY KEY (id);


--
-- Name: organization organization_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_key_unique UNIQUE (key);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization_policy organization_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_policy
    ADD CONSTRAINT organization_policy_pkey PRIMARY KEY (organization_id);


--
-- Name: organization_project_request organization_project_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_project_request
    ADD CONSTRAINT organization_project_request_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_slug_unique UNIQUE (slug);


--
-- Name: organization_unit_member organization_unit_member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_member
    ADD CONSTRAINT organization_unit_member_pkey PRIMARY KEY (unit_id, user_id);


--
-- Name: organization_unit organization_unit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit
    ADD CONSTRAINT organization_unit_pkey PRIMARY KEY (id);


--
-- Name: organization_unit_type organization_unit_type_org_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_type
    ADD CONSTRAINT organization_unit_type_org_key_unique UNIQUE (organization_id, key);


--
-- Name: organization_unit_type organization_unit_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_type
    ADD CONSTRAINT organization_unit_type_pkey PRIMARY KEY (id);


--
-- Name: organization_unit_workspace organization_unit_workspace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_workspace
    ADD CONSTRAINT organization_unit_workspace_pkey PRIMARY KEY (unit_id, workspace_id, relationship);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: pdf_export_jobs pdf_export_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_jobs
    ADD CONSTRAINT pdf_export_jobs_pkey PRIMARY KEY (id);


--
-- Name: pdf_export_render_audit pdf_export_render_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_render_audit
    ADD CONSTRAINT pdf_export_render_audit_pkey PRIMARY KEY (id);


--
-- Name: pdf_export_settings pdf_export_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_settings
    ADD CONSTRAINT pdf_export_settings_pkey PRIMARY KEY (id);


--
-- Name: pdf_fonts pdf_fonts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_fonts
    ADD CONSTRAINT pdf_fonts_pkey PRIMARY KEY (id);


--
-- Name: pdf_fonts pdf_fonts_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_fonts
    ADD CONSTRAINT pdf_fonts_sha256_key UNIQUE (sha256);


--
-- Name: pdf_icc_profiles pdf_icc_profiles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_icc_profiles
    ADD CONSTRAINT pdf_icc_profiles_name_key UNIQUE (name);


--
-- Name: pdf_icc_profiles pdf_icc_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_icc_profiles
    ADD CONSTRAINT pdf_icc_profiles_pkey PRIMARY KEY (id);


--
-- Name: pdf_icc_profiles pdf_icc_profiles_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_icc_profiles
    ADD CONSTRAINT pdf_icc_profiles_sha256_key UNIQUE (sha256);


--
-- Name: pdf_template_files pdf_template_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_template_files
    ADD CONSTRAINT pdf_template_files_pkey PRIMARY KEY (template_id, file_path);


--
-- Name: pdf_templates pdf_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_templates
    ADD CONSTRAINT pdf_templates_pkey PRIMARY KEY (id);


--
-- Name: pdf_workspace_template_assignments pdf_workspace_template_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_workspace_template_assignments
    ADD CONSTRAINT pdf_workspace_template_assignments_pkey PRIMARY KEY (workspace_id, template_id);


--
-- Name: public_asset_manifest public_asset_manifest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_asset_manifest
    ADD CONSTRAINT public_asset_manifest_pkey PRIMARY KEY (workspace_id, doc_id, asset_hash, filename);


--
-- Name: public_render_artifacts public_render_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_render_artifacts
    ADD CONSTRAINT public_render_artifacts_pkey PRIMARY KEY (id);


--
-- Name: search_content search_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_content
    ADD CONSTRAINT search_content_pkey PRIMARY KEY (workspace_id, doc_id);


--
-- Name: search_reindex_runs search_reindex_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_reindex_runs
    ADD CONSTRAINT search_reindex_runs_pkey PRIMARY KEY (id);


--
-- Name: session_links session_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_links
    ADD CONSTRAINT session_links_pkey PRIMARY KEY (session_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: telemetry_daily telemetry_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_daily
    ADD CONSTRAINT telemetry_daily_pkey PRIMARY KEY (day, category, event_name);


--
-- Name: telemetry_events telemetry_events_event_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_events_event_id_unique UNIQUE (event_id);


--
-- Name: telemetry_events telemetry_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_events_pkey PRIMARY KEY (id);


--
-- Name: template_catalog_entries template_catalog_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_catalog_entries
    ADD CONSTRAINT template_catalog_entries_pkey PRIMARY KEY (id);


--
-- Name: template_catalog_entries template_catalog_entries_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_catalog_entries
    ADD CONSTRAINT template_catalog_entries_slug_key UNIQUE (slug);


--
-- Name: template_default_policies template_default_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_default_policies
    ADD CONSTRAINT template_default_policies_pkey PRIMARY KEY (template_id);


--
-- Name: template_import_jobs template_import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_import_jobs
    ADD CONSTRAINT template_import_jobs_pkey PRIMARY KEY (id);


--
-- Name: template_reconcile_jobs template_reconcile_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_reconcile_jobs
    ADD CONSTRAINT template_reconcile_jobs_pkey PRIMARY KEY (id);


--
-- Name: template_registry_audit_events template_registry_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_pkey PRIMARY KEY (id);


--
-- Name: template_revisions template_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_revisions
    ADD CONSTRAINT template_revisions_pkey PRIMARY KEY (id);


--
-- Name: template_revisions template_revisions_template_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_revisions
    ADD CONSTRAINT template_revisions_template_id_version_key UNIQUE (template_id, version);


--
-- Name: theme_profiles theme_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.theme_profiles
    ADD CONSTRAINT theme_profiles_pkey PRIMARY KEY (id);


--
-- Name: themes themes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_pkey PRIMARY KEY (id);


--
-- Name: themes themes_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_slug_key UNIQUE (slug);


--
-- Name: typography_sets typography_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typography_sets
    ADD CONSTRAINT typography_sets_pkey PRIMARY KEY (id);


--
-- Name: typography_sets typography_sets_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typography_sets
    ADD CONSTRAINT typography_sets_slug_key UNIQUE (slug);


--
-- Name: typography_styles typography_styles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typography_styles
    ADD CONSTRAINT typography_styles_pkey PRIMARY KEY (typography_id, style_key);


--
-- Name: calendar_event_instances uq_cal_evt_inst_event_start; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_instances
    ADD CONSTRAINT uq_cal_evt_inst_event_start UNIQUE (event_id, instance_start);


--
-- Name: user_features user_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_features
    ADD CONSTRAINT user_features_pkey PRIMARY KEY (user_id, feature_name);


--
-- Name: user_preferences user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verification_tokens verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: verification_tokens verification_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: workspace_analytics_minute workspace_analytics_minute_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_analytics_minute
    ADD CONSTRAINT workspace_analytics_minute_pkey PRIMARY KEY (workspace_id, bucket_at);


--
-- Name: workspace_automation_actions workspace_automation_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_actions
    ADD CONSTRAINT workspace_automation_actions_pkey PRIMARY KEY (id);


--
-- Name: workspace_automation_runs workspace_automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_runs
    ADD CONSTRAINT workspace_automation_runs_pkey PRIMARY KEY (id);


--
-- Name: workspace_automation_runs workspace_automation_runs_workspace_id_automation_id_idempo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_runs
    ADD CONSTRAINT workspace_automation_runs_workspace_id_automation_id_idempo_key UNIQUE (workspace_id, automation_id, idempotency_key);


--
-- Name: workspace_automation_webhook_deliveries workspace_automation_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_webhook_deliveries
    ADD CONSTRAINT workspace_automation_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: workspace_automations workspace_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automations
    ADD CONSTRAINT workspace_automations_pkey PRIMARY KEY (id);


--
-- Name: workspace_calendar_settings workspace_calendar_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_calendar_settings
    ADD CONSTRAINT workspace_calendar_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_calendars workspace_calendars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_calendars
    ADD CONSTRAINT workspace_calendars_pkey PRIMARY KEY (workspace_id, account_id, remote_calendar_id);


--
-- Name: workspace_content_copy_publications workspace_content_copy_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_copy_publications
    ADD CONSTRAINT workspace_content_copy_publications_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_extract_publications workspace_content_extract_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_publications
    ADD CONSTRAINT workspace_content_extract_publications_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_extract_targets workspace_content_extract_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_targets
    ADD CONSTRAINT workspace_content_extract_targets_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_extract_targets workspace_content_extract_targets_target_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_targets
    ADD CONSTRAINT workspace_content_extract_targets_target_workspace_id_key UNIQUE (target_workspace_id);


--
-- Name: workspace_content_link_publications workspace_content_link_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_link_publications
    ADD CONSTRAINT workspace_content_link_publications_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_move_publications workspace_content_move_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_move_publications
    ADD CONSTRAINT workspace_content_move_publications_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_move_revision_manifests workspace_content_move_revision_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_move_revision_manifests
    ADD CONSTRAINT workspace_content_move_revision_manifests_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_operation_compensations workspace_content_operation_c_operation_id_kind_target_work_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_compensations
    ADD CONSTRAINT workspace_content_operation_c_operation_id_kind_target_work_key UNIQUE (operation_id, kind, target_workspace_id, target_kind, target_id);


--
-- Name: workspace_content_operation_compensations workspace_content_operation_compensat_operation_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_compensations
    ADD CONSTRAINT workspace_content_operation_compensat_operation_id_sequence_key UNIQUE (operation_id, sequence);


--
-- Name: workspace_content_operation_compensations workspace_content_operation_compensations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_compensations
    ADD CONSTRAINT workspace_content_operation_compensations_pkey PRIMARY KEY (id);


--
-- Name: workspace_content_operation_link_intents workspace_content_operation_link_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_link_intents
    ADD CONSTRAINT workspace_content_operation_link_intents_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_operation_mappings workspace_content_operation_m_operation_id_target_workspace_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_mappings
    ADD CONSTRAINT workspace_content_operation_m_operation_id_target_workspace_key UNIQUE (operation_id, target_workspace_id, target_kind, target_id);


--
-- Name: workspace_content_operation_mappings workspace_content_operation_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_mappings
    ADD CONSTRAINT workspace_content_operation_mappings_pkey PRIMARY KEY (operation_id, source_workspace_id, source_kind, source_id);


--
-- Name: workspace_content_operation_recipient_outbox workspace_content_operation_r_operation_id_recipient_id_eve_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox
    ADD CONSTRAINT workspace_content_operation_r_operation_id_recipient_id_eve_key UNIQUE (operation_id, recipient_id, event_kind);


--
-- Name: workspace_content_operation_redirects workspace_content_operation_r_operation_id_source_workspace_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_redirects
    ADD CONSTRAINT workspace_content_operation_r_operation_id_source_workspace_key UNIQUE (operation_id, source_workspace_id, source_kind, source_id);


--
-- Name: workspace_content_operation_recipient_outbox workspace_content_operation_recipient_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox
    ADD CONSTRAINT workspace_content_operation_recipient_outbox_pkey PRIMARY KEY (id);


--
-- Name: workspace_content_operation_redirects workspace_content_operation_redirects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_redirects
    ADD CONSTRAINT workspace_content_operation_redirects_pkey PRIMARY KEY (source_workspace_id, source_kind, source_id);


--
-- Name: workspace_content_operation_requests workspace_content_operation_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_requests
    ADD CONSTRAINT workspace_content_operation_requests_pkey PRIMARY KEY (operation_id);


--
-- Name: workspace_content_operation_staging workspace_content_operation_s_operation_id_resource_workspa_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_staging
    ADD CONSTRAINT workspace_content_operation_s_operation_id_resource_workspa_key UNIQUE (operation_id, resource_workspace_id, resource_kind, resource_id);


--
-- Name: workspace_content_operation_staging workspace_content_operation_staging_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_staging
    ADD CONSTRAINT workspace_content_operation_staging_object_key_key UNIQUE (object_key);


--
-- Name: workspace_content_operation_staging workspace_content_operation_staging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_staging
    ADD CONSTRAINT workspace_content_operation_staging_pkey PRIMARY KEY (operation_id, sequence);


--
-- Name: workspace_content_operations workspace_content_operations_idempotency_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operations
    ADD CONSTRAINT workspace_content_operations_idempotency_id_key UNIQUE (idempotency_id);


--
-- Name: workspace_content_operations workspace_content_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operations
    ADD CONSTRAINT workspace_content_operations_pkey PRIMARY KEY (id);


--
-- Name: workspace_database_cell_values workspace_database_cell_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT workspace_database_cell_values_pkey PRIMARY KEY (row_id, field_id);


--
-- Name: workspace_database_csv_mapping_templates workspace_database_csv_mapping_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_csv_mapping_templates
    ADD CONSTRAINT workspace_database_csv_mapping_templates_pkey PRIMARY KEY (id);


--
-- Name: workspace_database_fields workspace_database_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_fields
    ADD CONSTRAINT workspace_database_fields_pkey PRIMARY KEY (id);


--
-- Name: workspace_database_formula_dependencies workspace_database_formula_dependencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_dependencies
    ADD CONSTRAINT workspace_database_formula_dependencies_pkey PRIMARY KEY (formula_field_id, dependency_field_id);


--
-- Name: workspace_database_formula_values workspace_database_formula_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_values
    ADD CONSTRAINT workspace_database_formula_values_pkey PRIMARY KEY (row_id, field_id);


--
-- Name: workspace_database_relation_edges workspace_database_relation_e_source_row_id_source_field_i_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_e_source_row_id_source_field_i_key1 UNIQUE (source_row_id, source_field_id, "position");


--
-- Name: workspace_database_relation_edges workspace_database_relation_e_source_row_id_source_field_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_e_source_row_id_source_field_id_key UNIQUE (source_row_id, source_field_id, target_row_id);


--
-- Name: workspace_database_rollup_values workspace_database_rollup_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rollup_values
    ADD CONSTRAINT workspace_database_rollup_values_pkey PRIMARY KEY (row_id, field_id);


--
-- Name: workspace_database_row_search workspace_database_row_search_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_search
    ADD CONSTRAINT workspace_database_row_search_pkey PRIMARY KEY (row_id);


--
-- Name: workspace_database_row_templates workspace_database_row_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_templates
    ADD CONSTRAINT workspace_database_row_templates_pkey PRIMARY KEY (id);


--
-- Name: workspace_database_rows workspace_database_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rows
    ADD CONSTRAINT workspace_database_rows_pkey PRIMARY KEY (id);


--
-- Name: workspace_database_views workspace_database_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_views
    ADD CONSTRAINT workspace_database_views_pkey PRIMARY KEY (id);


--
-- Name: workspace_databases workspace_databases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_databases
    ADD CONSTRAINT workspace_databases_pkey PRIMARY KEY (id);


--
-- Name: workspace_doc_view_daily workspace_doc_view_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_doc_view_daily
    ADD CONSTRAINT workspace_doc_view_daily_pkey PRIMARY KEY (workspace_id, doc_id, date);


--
-- Name: workspace_document_audience_default workspace_document_audience_default_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_document_audience_default
    ADD CONSTRAINT workspace_document_audience_default_pkey PRIMARY KEY (workspace_id, audience_id);


--
-- Name: workspace_document_metadata_epoch workspace_document_metadata_epoch_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_document_metadata_epoch
    ADD CONSTRAINT workspace_document_metadata_epoch_pkey1 PRIMARY KEY (workspace_id, epoch_name);


--
-- Name: workspace_import_compensations workspace_import_compensations_import_id_kind_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_compensations
    ADD CONSTRAINT workspace_import_compensations_import_id_kind_target_id_key UNIQUE (import_id, kind, target_id);


--
-- Name: workspace_import_compensations workspace_import_compensations_import_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_compensations
    ADD CONSTRAINT workspace_import_compensations_import_id_sequence_key UNIQUE (import_id, sequence);


--
-- Name: workspace_import_compensations workspace_import_compensations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_compensations
    ADD CONSTRAINT workspace_import_compensations_pkey PRIMARY KEY (id);


--
-- Name: workspace_import_id_mappings workspace_import_id_mappings_import_id_kind_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_id_mappings
    ADD CONSTRAINT workspace_import_id_mappings_import_id_kind_target_id_key UNIQUE (import_id, kind, target_id);


--
-- Name: workspace_import_id_mappings workspace_import_id_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_id_mappings
    ADD CONSTRAINT workspace_import_id_mappings_pkey PRIMARY KEY (import_id, kind, source_id);


--
-- Name: workspace_import_parts workspace_import_parts_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_parts
    ADD CONSTRAINT workspace_import_parts_object_key_key UNIQUE (object_key);


--
-- Name: workspace_import_parts workspace_import_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_parts
    ADD CONSTRAINT workspace_import_parts_pkey PRIMARY KEY (import_id, part_number);


--
-- Name: workspace_imports workspace_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_pkey PRIMARY KEY (id);


--
-- Name: workspace_invite_links workspace_invite_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite_links
    ADD CONSTRAINT workspace_invite_links_pkey PRIMARY KEY (id);


--
-- Name: workspace_invite_links workspace_invite_links_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite_links
    ADD CONSTRAINT workspace_invite_links_token_hash_key UNIQUE (token_hash);


--
-- Name: workspace_member_last_access workspace_member_last_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_member_last_access
    ADD CONSTRAINT workspace_member_last_access_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_memberships workspace_memberships_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_id_unique UNIQUE (id);


--
-- Name: workspace_memberships workspace_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_storage_stats_daily workspace_storage_stats_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_storage_stats_daily
    ADD CONSTRAINT workspace_storage_stats_daily_pkey PRIMARY KEY (workspace_id, day);


--
-- Name: workspace_storage_stats workspace_storage_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_storage_stats
    ADD CONSTRAINT workspace_storage_stats_pkey PRIMARY KEY (workspace_id);


--
-- Name: workspace_tag_document_assignments workspace_tag_document_assignments_doc_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_document_assignments
    ADD CONSTRAINT workspace_tag_document_assignments_doc_id_position_key UNIQUE (doc_id, "position");


--
-- Name: workspace_tag_document_assignments workspace_tag_document_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_document_assignments
    ADD CONSTRAINT workspace_tag_document_assignments_pkey PRIMARY KEY (doc_id, tag_id);


--
-- Name: workspace_tag_legacy_ids workspace_tag_legacy_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_legacy_ids
    ADD CONSTRAINT workspace_tag_legacy_ids_pkey PRIMARY KEY (workspace_id, legacy_id);


--
-- Name: workspace_tag_legacy_ids workspace_tag_legacy_ids_workspace_id_tag_id_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_legacy_ids
    ADD CONSTRAINT workspace_tag_legacy_ids_workspace_id_tag_id_legacy_id_key UNIQUE (workspace_id, tag_id, legacy_id);


--
-- Name: workspace_tags workspace_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_pkey PRIMARY KEY (id);


--
-- Name: workspace_template_instances workspace_template_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_instances
    ADD CONSTRAINT workspace_template_instances_pkey PRIMARY KEY (id);


--
-- Name: workspace_template_instances workspace_template_instances_workspace_id_template_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_instances
    ADD CONSTRAINT workspace_template_instances_workspace_id_template_id_key UNIQUE (workspace_id, template_id);


--
-- Name: workspace_template_policies workspace_template_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_policies
    ADD CONSTRAINT workspace_template_policies_pkey PRIMARY KEY (id);


--
-- Name: workspace_template_policies workspace_template_policies_workspace_id_template_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_policies
    ADD CONSTRAINT workspace_template_policies_workspace_id_template_id_key UNIQUE (workspace_id, template_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_log_actor_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_actor_created_at_idx ON public.admin_audit_log USING btree (actor_user_id, created_at DESC, id DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: admin_audit_log_actor_kind_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_actor_kind_created_at_idx ON public.admin_audit_log USING btree (actor_kind, created_at DESC, id DESC);


--
-- Name: admin_audit_log_category_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_category_created_at_idx ON public.admin_audit_log USING btree (category, created_at DESC, id DESC);


--
-- Name: admin_audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_created_at_idx ON public.admin_audit_log USING btree (created_at DESC, id DESC);


--
-- Name: admin_audit_log_credential_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_credential_created_at_idx ON public.admin_audit_log USING btree (credential_type, credential_id, created_at DESC, id DESC) WHERE ((credential_type IS NOT NULL) AND (credential_id IS NOT NULL));


--
-- Name: admin_audit_log_event_key_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_event_key_created_at_idx ON public.admin_audit_log USING btree (event_key, created_at DESC, id DESC);


--
-- Name: admin_audit_log_target_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_target_created_at_idx ON public.admin_audit_log USING btree (target_type, target_id, created_at DESC, id DESC) WHERE (target_type IS NOT NULL);


--
-- Name: admin_audit_log_target_unit_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_target_unit_id_created_at_idx ON public.admin_audit_log USING btree (target_unit_id, created_at DESC, id DESC) WHERE (target_unit_id IS NOT NULL);


--
-- Name: database_document_references_document_link_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX database_document_references_document_link_unique ON public.database_document_references USING btree (workspace_id, database_id, row_id, field_id, raw_target_doc_id) WHERE (reference_kind = 'document_link_field'::text);


--
-- Name: database_document_references_raw_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX database_document_references_raw_target_idx ON public.database_document_references USING btree (workspace_id, raw_target_doc_id, reference_kind);


--
-- Name: database_document_references_resolved_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX database_document_references_resolved_target_idx ON public.database_document_references USING btree (workspace_id, resolved_target_doc_id, reference_kind) WHERE (resolved_target_doc_id IS NOT NULL);


--
-- Name: database_document_references_row_content_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX database_document_references_row_content_unique ON public.database_document_references USING btree (workspace_id, database_id, row_id) WHERE (reference_kind = 'row_content_document'::text);


--
-- Name: docs_userspace_external_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX docs_userspace_external_id_unique ON public.docs USING btree (userspace_owner_id, external_id) WHERE (userspace_owner_id IS NOT NULL);


--
-- Name: docs_workspace_external_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX docs_workspace_external_id_unique ON public.docs USING btree (workspace_id, external_id) WHERE (workspace_id IS NOT NULL);


--
-- Name: git_sync_bootstrap_attempts_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX git_sync_bootstrap_attempts_one_active ON public.git_sync_bootstrap_attempts USING btree (profile_id) WHERE (phase = ANY (ARRAY['Prepared'::text, 'RemoteApplied'::text]));


--
-- Name: git_sync_bootstrap_attempts_profile_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX git_sync_bootstrap_attempts_profile_created ON public.git_sync_bootstrap_attempts USING btree (profile_id, created_at DESC);


--
-- Name: git_sync_profiles_cron_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX git_sync_profiles_cron_due_idx ON public.git_sync_profiles USING btree (LEAST(cron_next_scheduled_at, COALESCE(cron_pending_misfire_scheduled_for, cron_next_scheduled_at)), id) WHERE ((enabled = true) AND (trigger_mode = 'Cron'::text));


--
-- Name: git_sync_runs_one_unfinished_per_profile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX git_sync_runs_one_unfinished_per_profile_idx ON public.git_sync_runs USING btree (profile_id) WHERE (status = ANY (ARRAY['Pending'::text, 'Running'::text]));


--
-- Name: git_sync_runs_scheduled_slot_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX git_sync_runs_scheduled_slot_unique ON public.git_sync_runs USING btree (profile_id, trigger_source, scheduled_for) WHERE (scheduled_for IS NOT NULL);


--
-- Name: idx_ai_workspace_doc_embeddings_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_workspace_doc_embeddings_vector ON public.ai_workspace_doc_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_ai_workspace_doc_embeddings_ws_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_workspace_doc_embeddings_ws_doc ON public.ai_workspace_doc_embeddings USING btree (workspace_id, doc_id);


--
-- Name: idx_ai_workspace_file_embeddings_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_workspace_file_embeddings_vector ON public.ai_workspace_file_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_api_keys_key_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_key_hash ON public.api_keys USING btree (key_hash);


--
-- Name: idx_api_keys_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_user_id ON public.api_keys USING btree (user_id);


--
-- Name: idx_blobs_blob_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_blobs_blob_id ON public.blobs USING btree (blob_id);


--
-- Name: idx_blobs_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blobs_deleted_at ON public.blobs USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_blobs_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blobs_workspace_id ON public.blobs USING btree (workspace_id);


--
-- Name: idx_brand_assets_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_assets_sha256 ON public.brand_assets USING btree (sha256);


--
-- Name: idx_branding_profiles_theme; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branding_profiles_theme ON public.branding_profiles USING btree (theme_id);


--
-- Name: idx_cache_tuning_metrics_cycle_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cache_tuning_metrics_cycle_at ON public.cache_tuning_metrics USING btree (cycle_type, measured_at);


--
-- Name: idx_cache_tuning_metrics_name_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cache_tuning_metrics_name_at ON public.cache_tuning_metrics USING btree (cache_name, measured_at DESC);


--
-- Name: idx_cal_evt_inst_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cal_evt_inst_lookup ON public.calendar_event_instances USING btree (event_id, instance_start, is_cancelled);


--
-- Name: idx_cal_pending_writes_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cal_pending_writes_due ON public.calendar_pending_writes USING btree (next_retry_at NULLS FIRST) WHERE (retry_count < 10);


--
-- Name: idx_calendar_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_accounts_user_id ON public.calendar_accounts USING btree (user_id);


--
-- Name: idx_calendar_event_participants_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_event_participants_event ON public.calendar_event_participants USING btree (event_id);


--
-- Name: idx_calendar_event_source_links_anchor_doc_block; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_event_source_links_anchor_doc_block ON public.calendar_event_source_links USING btree (source_doc_id, source_block_id, relation) WHERE (source_block_id IS NOT NULL);


--
-- Name: idx_calendar_event_source_links_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_event_source_links_doc ON public.calendar_event_source_links USING btree (source_doc_id, relation);


--
-- Name: idx_calendar_event_tags_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_event_tags_workspace ON public.calendar_event_tags USING btree (workspace_id);


--
-- Name: idx_calendar_events_account_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_events_account_window ON public.calendar_events USING btree (account_id, starts_at, ends_at);


--
-- Name: idx_calendar_events_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_events_origin ON public.calendar_events USING btree (workspace_id, origin);


--
-- Name: idx_calendar_events_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_events_parent ON public.calendar_events USING btree (recurrence_parent_id) WHERE (recurrence_parent_id IS NOT NULL);


--
-- Name: idx_calendar_events_workspace_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_events_workspace_window ON public.calendar_events USING btree (workspace_id, starts_at, ends_at);


--
-- Name: idx_calendar_reminder_dispatch_log_dispatched_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_reminder_dispatch_log_dispatched_at ON public.calendar_reminder_dispatch_log USING btree (dispatched_at DESC);


--
-- Name: idx_calendar_reminders_event_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_reminders_event_schedule ON public.calendar_reminders USING btree (event_id, scheduled_for);


--
-- Name: idx_calendar_subscriptions_webhook_channel_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_subscriptions_webhook_channel_id ON public.calendar_subscriptions USING btree (((webhook_channel_json ->> 'channel_id'::text))) WHERE (webhook_channel_json IS NOT NULL);


--
-- Name: idx_comment_attachments_workspace_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comment_attachments_workspace_doc ON public.comment_attachments USING btree (workspace_id, doc_id);


--
-- Name: idx_comment_edit_history_comment_edited_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comment_edit_history_comment_edited_at ON public.comment_edit_history USING btree (comment_id, edited_at DESC);


--
-- Name: idx_comment_thread_read_state_user_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comment_thread_read_state_user_updated ON public.comment_thread_read_state USING btree (user_id, updated_at DESC);


--
-- Name: idx_comments_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_author_id ON public.comments USING btree (author_id);


--
-- Name: idx_comments_doc_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_doc_id_created_at ON public.comments USING btree (doc_id, created_at DESC);


--
-- Name: idx_comments_doc_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_doc_parent ON public.comments USING btree (doc_id, parent_comment_id);


--
-- Name: idx_comments_parent_comment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_parent_comment_id ON public.comments USING btree (parent_comment_id) WHERE (parent_comment_id IS NOT NULL);


--
-- Name: idx_comments_resolved_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comments_resolved_at ON public.comments USING btree (resolved_at DESC) WHERE (resolved_at IS NOT NULL);


--
-- Name: idx_config_changelog_changed_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_config_changelog_changed_at_desc ON public.config_changelog USING btree (changed_at DESC);


--
-- Name: idx_config_changelog_changed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_config_changelog_changed_by ON public.config_changelog USING btree (changed_by);


--
-- Name: idx_config_changelog_config_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_config_changelog_config_key ON public.config_changelog USING btree (config_key);


--
-- Name: idx_copilot_embeddings_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_embeddings_hnsw ON public.copilot_embeddings USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_copilot_embeddings_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_embeddings_source ON public.copilot_embeddings USING btree (workspace_id, source_type, source_id);


--
-- Name: idx_copilot_embeddings_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_embeddings_workspace ON public.copilot_embeddings USING btree (workspace_id);


--
-- Name: idx_copilot_jobs_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_jobs_state ON public.copilot_jobs USING btree (state, updated_at);


--
-- Name: idx_copilot_message_revisions_message_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_message_revisions_message_order ON public.copilot_message_revisions USING btree (message_id, revision_created_at, id);


--
-- Name: idx_copilot_messages_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_messages_session_id ON public.copilot_messages USING btree (session_id, created_at);


--
-- Name: idx_copilot_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_sessions_user_id ON public.copilot_sessions USING btree (user_id);


--
-- Name: idx_copilot_transcripts_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_transcripts_source ON public.copilot_transcripts USING btree (workspace_id, source_type, source_id);


--
-- Name: idx_copilot_transcripts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_transcripts_status ON public.copilot_transcripts USING btree (status) WHERE (status <> 'completed'::text);


--
-- Name: idx_copilot_transcripts_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_copilot_transcripts_workspace ON public.copilot_transcripts USING btree (workspace_id);


--
-- Name: idx_database_activity_events_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_activity_events_actor ON public.database_activity_events USING btree (workspace_id, actor_user_id, created_at DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: idx_database_activity_events_database_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_activity_events_database_created ON public.database_activity_events USING btree (database_id, created_at DESC, id DESC);


--
-- Name: idx_database_activity_events_row_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_activity_events_row_created ON public.database_activity_events USING btree (workspace_id, row_id, created_at DESC, id DESC) WHERE (row_id IS NOT NULL);


--
-- Name: idx_database_activity_events_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_activity_events_workspace_created ON public.database_activity_events USING btree (workspace_id, created_at DESC, id DESC);


--
-- Name: idx_database_field_roles_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_field_roles_field ON public.database_field_roles USING btree (field_id);


--
-- Name: idx_database_import_jobs_database; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_import_jobs_database ON public.database_import_jobs USING btree (database_id, created_at DESC, id DESC) WHERE (database_id IS NOT NULL);


--
-- Name: idx_database_import_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_import_jobs_status ON public.database_import_jobs USING btree (status, created_at DESC, id DESC) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: idx_database_import_jobs_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_import_jobs_workspace_created ON public.database_import_jobs USING btree (workspace_id, created_at DESC, id DESC);


--
-- Name: idx_database_row_reminders_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_row_reminders_due ON public.database_row_reminders USING btree (trigger_at, id) WHERE (status = 'scheduled'::text);


--
-- Name: idx_database_row_reminders_expired_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_row_reminders_expired_claim ON public.database_row_reminders USING btree (claim_expires_at, id) WHERE (status = 'claimed'::text);


--
-- Name: idx_database_row_reminders_owner_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_row_reminders_owner_target ON public.database_row_reminders USING btree (user_id, database_id, row_id, field_id, trigger_at);


--
-- Name: idx_database_row_search_workspace_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_row_search_workspace_tags ON public.workspace_database_row_search USING gin (workspace_tags);


--
-- Name: idx_database_unique_id_sequences_database; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_unique_id_sequences_database ON public.database_unique_id_sequences USING btree (database_id);


--
-- Name: idx_database_view_roles_view; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_view_roles_view ON public.database_view_roles USING btree (view_id);


--
-- Name: idx_database_view_user_states_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_database_view_user_states_user ON public.database_view_user_states USING btree (user_id, view_id);


--
-- Name: idx_doc_audience_assignment_audience; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_audience_assignment_audience ON public.doc_audience_assignment USING btree (audience_id, doc_id);


--
-- Name: idx_doc_histories_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_histories_created_at ON public.doc_histories USING btree (created_at);


--
-- Name: idx_doc_histories_doc_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_histories_doc_id_created_at ON public.doc_histories USING btree (doc_id, created_at DESC);


--
-- Name: idx_doc_snapshots_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_snapshots_workspace_id ON public.doc_snapshots USING btree (workspace_id);


--
-- Name: idx_doc_snapshots_ws_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_snapshots_ws_doc ON public.doc_snapshots USING btree (workspace_id, doc_id);


--
-- Name: idx_doc_updates_doc_id_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_updates_doc_id_sequence ON public.doc_updates USING btree (doc_id, sequence DESC);


--
-- Name: idx_doc_updates_doc_payload_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_doc_updates_doc_payload_sha256 ON public.doc_updates USING btree (doc_id, payload_sha256) WHERE (payload_sha256 IS NOT NULL);


--
-- Name: idx_doc_updates_ws_doc_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_updates_ws_doc_seq ON public.doc_updates USING btree (workspace_id, doc_id, sequence);


--
-- Name: idx_doc_user_permissions_doc_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_user_permissions_doc_id ON public.doc_user_permissions USING btree (doc_id);


--
-- Name: idx_doc_user_permissions_doc_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_user_permissions_doc_user ON public.doc_user_permissions USING btree (doc_id, user_id);


--
-- Name: idx_doc_user_permissions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_user_permissions_user_id ON public.doc_user_permissions USING btree (user_id);


--
-- Name: idx_doc_view_daily_ws_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_doc_view_daily_ws_date ON public.workspace_doc_view_daily USING btree (workspace_id, date);


--
-- Name: idx_docs_journal_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_journal_date ON public.docs USING btree (workspace_id, journal_date) WHERE ((deleted_at IS NULL) AND (journal_date IS NOT NULL));


--
-- Name: idx_docs_metadata_classification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_metadata_classification ON public.docs USING btree (workspace_id, classification_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_docs_metadata_review_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_metadata_review_due ON public.docs USING btree (workspace_id, review_due_at) WHERE ((deleted_at IS NULL) AND (review_due_at IS NOT NULL));


--
-- Name: idx_docs_metadata_revision; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_metadata_revision ON public.docs USING btree (workspace_id, metadata_revision) WHERE (deleted_at IS NULL);


--
-- Name: idx_docs_metadata_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_metadata_status ON public.docs USING btree (workspace_id, status_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_docs_metadata_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_metadata_type ON public.docs USING btree (workspace_id, document_type_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_docs_metadata_valid_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_metadata_valid_until ON public.docs USING btree (workspace_id, valid_until) WHERE ((deleted_at IS NULL) AND (valid_until IS NOT NULL));


--
-- Name: idx_docs_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_updated_at ON public.docs USING btree (updated_at DESC);


--
-- Name: idx_docs_userspace_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_userspace_owner_id ON public.docs USING btree (userspace_owner_id);


--
-- Name: idx_docs_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_docs_workspace_id ON public.docs USING btree (workspace_id);


--
-- Name: idx_document_audience_definition_active_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_audience_definition_active_sort ON public.document_audience_definition USING btree (is_active, sort_order, key);


--
-- Name: idx_document_classification_definition_active_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_classification_definition_active_sort ON public.document_classification_definition USING btree (is_active, sort_order, key);


--
-- Name: idx_document_graph_index_state_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_graph_index_state_queue ON public.document_graph_index_state USING btree (workspace_id, stale_state, queued_at, failed_at);


--
-- Name: idx_document_graph_index_state_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_graph_index_state_stale ON public.document_graph_index_state USING btree (workspace_id, stale_state, indexed_at);


--
-- Name: idx_document_graph_occurrences_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_graph_occurrences_source ON public.document_graph_occurrences USING btree (workspace_id, source_doc_id, link_kind, raw_target_doc_id);


--
-- Name: idx_document_graph_occurrences_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_graph_occurrences_target ON public.document_graph_occurrences USING btree (workspace_id, target_doc_id, link_kind, source_doc_id) WHERE (target_doc_id IS NOT NULL);


--
-- Name: idx_document_initial_sync_audit_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_initial_sync_audit_actor ON public.document_initial_sync_audit USING btree (actor_user_id, created_at DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: idx_document_initial_sync_audit_workspace_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_initial_sync_audit_workspace_doc ON public.document_initial_sync_audit USING btree (workspace_id, doc_id, created_at DESC);


--
-- Name: idx_document_retention_policy_definition_active_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_retention_policy_definition_active_sort ON public.document_retention_policy_definition USING btree (is_active, sort_order, key);


--
-- Name: idx_document_status_transition_to_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_status_transition_to_status ON public.document_status_transition USING btree (to_status_id);


--
-- Name: idx_document_status_value_schema_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_status_value_schema_sort ON public.document_status_value USING btree (schema_id, sort_order);


--
-- Name: idx_document_template_state_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_template_state_instance ON public.document_template_state USING btree (instance_id) WHERE (instance_id IS NOT NULL);


--
-- Name: idx_document_template_state_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_template_state_template ON public.document_template_state USING btree (template_id) WHERE (template_id IS NOT NULL);


--
-- Name: idx_document_type_status_default_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_type_status_default_status ON public.document_type_status_default USING btree (status_id);


--
-- Name: idx_document_version_artifact_kind_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_artifact_kind_created_at ON public.document_version_artifact USING btree (artifact_kind, created_at DESC);


--
-- Name: idx_document_version_artifact_version_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_artifact_version_created_at ON public.document_version_artifact USING btree (version_id, created_at DESC);


--
-- Name: idx_document_version_doc_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_doc_created_at ON public.document_version USING btree (doc_id, created_at);


--
-- Name: idx_document_version_doc_kind_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_doc_kind_created_at ON public.document_version USING btree (doc_id, kind, created_at DESC);


--
-- Name: idx_document_version_doc_pinned_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_doc_pinned_created_at ON public.document_version USING btree (doc_id, is_pinned, created_at DESC);


--
-- Name: idx_document_version_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_policy ON public.document_version USING btree (policy_id);


--
-- Name: idx_document_version_policy_scope_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_policy_scope_workspace ON public.document_version_policy USING btree (scope, workspace_id);


--
-- Name: idx_document_version_relation_from_relation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_relation_from_relation ON public.document_version_relation USING btree (from_version_id, relation);


--
-- Name: idx_document_version_relation_to_relation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_relation_to_relation ON public.document_version_relation USING btree (to_version_id, relation);


--
-- Name: idx_document_version_workspace_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_version_workspace_created_at ON public.document_version USING btree (workspace_id, created_at);


--
-- Name: idx_document_versioning_workspace_settings_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_versioning_workspace_settings_updated_at ON public.document_versioning_workspace_settings USING btree (updated_at DESC);


--
-- Name: idx_document_workspace_settings_status_schema; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_workspace_settings_status_schema ON public.document_workspace_settings USING btree (status_schema_id);


--
-- Name: idx_document_workspace_settings_version_policy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_workspace_settings_version_policy ON public.document_workspace_settings USING btree (version_policy_id);


--
-- Name: idx_file_conflicts_binding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_conflicts_binding ON public.git_sync_file_conflicts USING btree (binding_id) WHERE (binding_id IS NOT NULL);


--
-- Name: idx_file_conflicts_profile_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_file_conflicts_profile_path ON public.git_sync_file_conflicts USING btree (profile_id, repo_path);


--
-- Name: idx_font_assets_family_usage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_font_assets_family_usage ON public.font_assets USING btree (family_id, usage);


--
-- Name: idx_font_assets_sha256; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_font_assets_sha256 ON public.font_assets USING btree (sha256);


--
-- Name: idx_git_sync_bindings_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_bindings_doc ON public.git_sync_bindings USING btree (profile_id, doc_id);


--
-- Name: idx_git_sync_bindings_profile_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_bindings_profile_active ON public.git_sync_bindings USING btree (profile_id) WHERE (tombstone = false);


--
-- Name: idx_git_sync_bindings_sync_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_git_sync_bindings_sync_id ON public.git_sync_bindings USING btree (profile_id, sync_id) WHERE (tombstone = false);


--
-- Name: idx_git_sync_blob_promotions_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_blob_promotions_recovery ON public.git_sync_blob_promotions USING btree (created_at, run_id);


--
-- Name: idx_git_sync_conflicts_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_conflicts_profile ON public.git_sync_conflicts USING btree (profile_id, resolution);


--
-- Name: idx_git_sync_file_baselines_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_file_baselines_profile ON public.git_sync_file_baselines USING btree (profile_id);


--
-- Name: idx_git_sync_file_bindings_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_file_bindings_profile ON public.git_sync_file_bindings USING btree (profile_id) WHERE (NOT tombstoned);


--
-- Name: idx_git_sync_file_bindings_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_file_bindings_workspace ON public.git_sync_file_bindings USING btree (workspace_id);


--
-- Name: idx_git_sync_file_conflicts_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_file_conflicts_profile ON public.git_sync_file_conflicts USING btree (profile_id, resolution);


--
-- Name: idx_git_sync_file_conflicts_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_file_conflicts_run ON public.git_sync_file_conflicts USING btree (run_id);


--
-- Name: idx_git_sync_partial_items_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_partial_items_pending ON public.git_sync_partial_items USING btree (session_id, status, sort_key) WHERE (status = ANY (ARRAY['Pending'::text, 'Running'::text]));


--
-- Name: idx_git_sync_partial_items_session_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_git_sync_partial_items_session_key ON public.git_sync_partial_items USING btree (session_id, item_kind, item_key);


--
-- Name: idx_git_sync_partial_sessions_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_git_sync_partial_sessions_one_open ON public.git_sync_partial_sessions USING btree (profile_id) WHERE (status = 'Open'::text);


--
-- Name: idx_git_sync_partial_sessions_profile_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_partial_sessions_profile_created ON public.git_sync_partial_sessions USING btree (profile_id, created_at DESC);


--
-- Name: idx_git_sync_profiles_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_git_sync_profiles_workspace ON public.git_sync_profiles USING btree (workspace_id) WHERE (enabled = true);


--
-- Name: idx_git_sync_runs_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_runs_profile ON public.git_sync_runs USING btree (profile_id, started_at DESC);


--
-- Name: idx_git_sync_runs_reconciliation_required; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_runs_reconciliation_required ON public.git_sync_runs USING btree (profile_id, started_at DESC) WHERE (reconciliation_required = true);


--
-- Name: idx_git_sync_ssh_host_keys_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_ssh_host_keys_enabled ON public.git_sync_ssh_host_keys USING btree (host, port, enabled);


--
-- Name: idx_git_sync_webhook_deliveries_profile_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_webhook_deliveries_profile_received ON public.git_sync_webhook_deliveries USING btree (profile_id, received_at DESC);


--
-- Name: idx_git_sync_webhook_deliveries_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_git_sync_webhook_deliveries_run ON public.git_sync_webhook_deliveries USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: idx_language_definition_active_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_language_definition_active_sort ON public.language_definition USING btree (is_active, sort_order, key);


--
-- Name: idx_magic_link_otps_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_magic_link_otps_email ON public.magic_link_otps USING btree (email);


--
-- Name: idx_metrics_daily_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metrics_daily_day ON public.metrics_daily USING btree (day);


--
-- Name: idx_metrics_raw_cat_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metrics_raw_cat_name ON public.metrics_raw USING btree (category, metric_name);


--
-- Name: idx_metrics_raw_minute; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metrics_raw_minute ON public.metrics_raw USING btree (minute);


--
-- Name: idx_multipart_blob_parts_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_multipart_blob_parts_lookup ON public.multipart_blob_parts USING btree (workspace_id, key, upload_id);


--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at);


--
-- Name: idx_notifications_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notifications_idempotency_key ON public.notifications USING btree (idempotency_key);


--
-- Name: idx_notifications_user_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_created_at ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: idx_notifications_user_read_created_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_read_created_id ON public.notifications USING btree (user_id, read_at, created_at DESC, id DESC);


--
-- Name: idx_outbox_events_processed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_processed ON public.outbox_events USING btree (processed_at) WHERE (processed_at IS NOT NULL);


--
-- Name: idx_outbox_unprocessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_unprocessed ON public.outbox_events USING btree (processed_at, created_at);


--
-- Name: idx_outbox_workspace_content_published_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_workspace_content_published_pending ON public.outbox_events USING btree (created_at, id) WHERE ((processed_at IS NULL) AND (event_type = 'workspace_content_published'::text));


--
-- Name: idx_outbox_workspace_doc_broadcast_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_workspace_doc_broadcast_pending ON public.outbox_events USING btree (created_at, id) WHERE ((processed_at IS NULL) AND (event_type = 'workspace_doc_broadcast'::text));


--
-- Name: idx_pdf_export_jobs_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_jobs_expires ON public.pdf_export_jobs USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_pdf_export_jobs_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_jobs_idempotency ON public.pdf_export_jobs USING btree (workspace_id, doc_id, options_hash, created_at DESC);


--
-- Name: idx_pdf_export_jobs_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_jobs_workspace_created ON public.pdf_export_jobs USING btree (workspace_id, created_at DESC);


--
-- Name: idx_pdf_export_render_audit_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_render_audit_actor_created ON public.pdf_export_render_audit USING btree (actor_id, created_at DESC);


--
-- Name: idx_pdf_export_render_audit_doc_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_render_audit_doc_created ON public.pdf_export_render_audit USING btree (doc_id, created_at DESC);


--
-- Name: idx_pdf_export_render_audit_document_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_render_audit_document_version ON public.pdf_export_render_audit USING btree (document_version_id) WHERE (document_version_id IS NOT NULL);


--
-- Name: idx_pdf_export_render_audit_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_export_render_audit_workspace_created ON public.pdf_export_render_audit USING btree (workspace_id, created_at DESC);


--
-- Name: idx_pdf_templates_slug_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pdf_templates_slug_active ON public.pdf_templates USING btree (slug) WHERE (deleted_at IS NULL);


--
-- Name: idx_pdf_templates_slug_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pdf_templates_slug_deleted_at ON public.pdf_templates USING btree (slug, deleted_at);


--
-- Name: idx_public_asset_manifest_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_public_asset_manifest_doc ON public.public_asset_manifest USING btree (workspace_id, doc_id);


--
-- Name: idx_public_render_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_public_render_doc ON public.public_render_artifacts USING btree (workspace_id, doc_id) WHERE (doc_id IS NOT NULL);


--
-- Name: idx_public_render_workspace_root; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_public_render_workspace_root ON public.public_render_artifacts USING btree (workspace_id) WHERE (doc_id IS NULL);


--
-- Name: idx_search_content_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_content_updated_at ON public.search_content USING btree (updated_at DESC);


--
-- Name: idx_search_content_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_content_vector ON public.search_content USING gin (search_vector);


--
-- Name: idx_search_content_workspace_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_content_workspace_tags ON public.search_content USING gin (workspace_tags);


--
-- Name: idx_search_content_workspace_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_content_workspace_updated_at ON public.search_content USING btree (workspace_id, updated_at DESC);


--
-- Name: idx_search_reindex_runs_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_reindex_runs_status_updated ON public.search_reindex_runs USING btree (status, updated_at DESC);


--
-- Name: idx_session_links_root; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_links_root ON public.session_links USING btree (root_session_id);


--
-- Name: idx_session_links_root_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_links_root_user ON public.session_links USING btree (root_session_id, user_id);


--
-- Name: idx_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_expires_at ON public.sessions USING btree (expires_at);


--
-- Name: idx_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);


--
-- Name: idx_telemetry_daily_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_daily_day ON public.telemetry_daily USING btree (day);


--
-- Name: idx_telemetry_events_category_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_events_category_name ON public.telemetry_events USING btree (category, event_name);


--
-- Name: idx_telemetry_events_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_events_received ON public.telemetry_events USING btree (received_at);


--
-- Name: idx_telemetry_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_telemetry_events_user ON public.telemetry_events USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_template_catalog_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_catalog_category ON public.template_catalog_entries USING btree (category);


--
-- Name: idx_template_catalog_entries_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_catalog_entries_source ON public.template_catalog_entries USING btree (source);


--
-- Name: idx_template_catalog_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_catalog_status ON public.template_catalog_entries USING btree (status);


--
-- Name: idx_template_default_policies_apply_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_default_policies_apply_new ON public.template_default_policies USING btree (apply_to_new_workspaces) WHERE (apply_to_new_workspaces = true);


--
-- Name: idx_template_reconcile_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_reconcile_workspace ON public.template_reconcile_jobs USING btree (workspace_id);


--
-- Name: idx_template_registry_audit_events_action_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_action_created_at ON public.template_registry_audit_events USING btree (action, created_at DESC, id DESC);


--
-- Name: idx_template_registry_audit_events_actor_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_actor_created_at ON public.template_registry_audit_events USING btree (actor_user_id, created_at DESC, id DESC) WHERE (actor_user_id IS NOT NULL);


--
-- Name: idx_template_registry_audit_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_created_at ON public.template_registry_audit_events USING btree (created_at DESC, id DESC);


--
-- Name: idx_template_registry_audit_events_event_type_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_event_type_created_at ON public.template_registry_audit_events USING btree (event_type, created_at DESC, id DESC);


--
-- Name: idx_template_registry_audit_events_import_job_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_import_job_created_at ON public.template_registry_audit_events USING btree (import_job_id, created_at DESC, id DESC) WHERE (import_job_id IS NOT NULL);


--
-- Name: idx_template_registry_audit_events_template_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_template_created_at ON public.template_registry_audit_events USING btree (template_id, created_at DESC, id DESC) WHERE (template_id IS NOT NULL);


--
-- Name: idx_template_registry_audit_events_workspace_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_audit_events_workspace_created_at ON public.template_registry_audit_events USING btree (workspace_id, created_at DESC, id DESC) WHERE (workspace_id IS NOT NULL);


--
-- Name: idx_template_revisions_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_revisions_state ON public.template_revisions USING btree (state);


--
-- Name: idx_template_revisions_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_revisions_template ON public.template_revisions USING btree (template_id);


--
-- Name: idx_theme_profiles_theme; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_theme_profiles_theme ON public.theme_profiles USING btree (theme_id);


--
-- Name: idx_themes_preview_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_themes_preview_order ON public.themes USING btree (origin, preview_group, preview_order);


--
-- Name: idx_user_features_feature_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_features_feature_name ON public.user_features USING btree (feature_name) WHERE (activated = true);


--
-- Name: idx_users_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_users_email_lower ON public.users USING btree (lower(email));


--
-- Name: idx_users_is_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_is_admin ON public.users USING btree (is_admin) WHERE (is_admin = true);


--
-- Name: idx_verification_tokens_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verification_tokens_kind ON public.verification_tokens USING btree (kind);


--
-- Name: idx_version_links_commit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_version_links_commit ON public.git_sync_version_links USING btree (git_commit_oid) WHERE (git_commit_oid IS NOT NULL);


--
-- Name: idx_version_links_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_version_links_object ON public.git_sync_version_links USING btree (sync_object_kind, sync_object_id);


--
-- Name: idx_version_links_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_version_links_profile ON public.git_sync_version_links USING btree (profile_id);


--
-- Name: idx_version_links_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_version_links_run ON public.git_sync_version_links USING btree (run_id);


--
-- Name: idx_wm_last_access_ws_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wm_last_access_ws_doc ON public.workspace_member_last_access USING btree (workspace_id, last_doc_id);


--
-- Name: idx_wm_last_access_ws_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wm_last_access_ws_time ON public.workspace_member_last_access USING btree (workspace_id, last_accessed_at DESC);


--
-- Name: idx_workspace_analytics_minute_bucket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_analytics_minute_bucket ON public.workspace_analytics_minute USING btree (bucket_at DESC);


--
-- Name: idx_workspace_automation_actions_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_automation_actions_run ON public.workspace_automation_actions USING btree (run_id, "position", id);


--
-- Name: idx_workspace_automation_runs_dead_letter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_automation_runs_dead_letter ON public.workspace_automation_runs USING btree (dead_letter, queued_at DESC, id DESC) WHERE (dead_letter = true);


--
-- Name: idx_workspace_automation_runs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_automation_runs_workspace ON public.workspace_automation_runs USING btree (workspace_id, queued_at DESC, id DESC);


--
-- Name: idx_workspace_automation_webhook_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_automation_webhook_retry ON public.workspace_automation_webhook_deliveries USING btree (status, next_retry_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'failed'::text]));


--
-- Name: idx_workspace_automations_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_automations_trigger ON public.workspace_automations USING btree (workspace_id, trigger_type, status);


--
-- Name: idx_workspace_automations_workspace_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_automations_workspace_status ON public.workspace_automations USING btree (workspace_id, status, updated_at DESC, id);


--
-- Name: idx_workspace_content_operation_compensations_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_content_operation_compensations_pending ON public.workspace_content_operation_compensations USING btree (operation_id, sequence DESC) WHERE (completed_at IS NULL);


--
-- Name: idx_workspace_content_operation_recipient_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_content_operation_recipient_claim ON public.workspace_content_operation_recipient_outbox USING btree (status, lease_expires_at, created_at) WHERE status IN ('pending', 'processing', 'failed');


--
-- Name: idx_workspace_content_operation_recipient_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_content_operation_recipient_pending ON public.workspace_content_operation_recipient_outbox USING btree (status, created_at) WHERE status IN ('pending', 'failed');


--
-- Name: idx_workspace_content_operation_requests_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_content_operation_requests_origin ON public.workspace_content_operation_requests USING btree (origin_operation_id) WHERE (origin_operation_id IS NOT NULL);


--
-- Name: idx_workspace_content_operations_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_content_operations_actor_created ON public.workspace_content_operations USING btree (actor_id, created_at DESC);


--
-- Name: idx_workspace_content_operations_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_content_operations_recovery ON public.workspace_content_operations USING btree (status, updated_at) WHERE status IN ('queued', 'running', 'failed', 'cleanup_required');


--
-- Name: idx_workspace_database_cell_values_database_field_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_cell_values_database_field_row ON public.workspace_database_cell_values USING btree (database_id, field_id, row_id);


--
-- Name: idx_workspace_database_cell_values_field; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_cell_values_field ON public.workspace_database_cell_values USING btree (field_id);


--
-- Name: idx_workspace_database_cell_values_row_database; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_cell_values_row_database ON public.workspace_database_cell_values USING btree (row_id, database_id);


--
-- Name: idx_workspace_database_csv_mapping_templates_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_csv_mapping_templates_workspace ON public.workspace_database_csv_mapping_templates USING btree (workspace_id, updated_at DESC);


--
-- Name: idx_workspace_database_fields_database_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_fields_database_position ON public.workspace_database_fields USING btree (database_id, "position", id);


--
-- Name: idx_workspace_database_formula_dependencies_dependency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_formula_dependencies_dependency ON public.workspace_database_formula_dependencies USING btree (dependency_field_id, formula_field_id);


--
-- Name: idx_workspace_database_formula_values_stale_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_formula_values_stale_scan ON public.workspace_database_formula_values USING btree (stale_state, updated_at) WHERE (stale_state = ANY (ARRAY['stale'::text, 'failed'::text, 'recompute_pending'::text]));


--
-- Name: idx_workspace_database_formula_values_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_formula_values_state ON public.workspace_database_formula_values USING btree (database_id, field_id, stale_state, computed_at);


--
-- Name: idx_workspace_database_relation_edges_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_relation_edges_source ON public.workspace_database_relation_edges USING btree (source_database_id, source_field_id, "position");


--
-- Name: idx_workspace_database_relation_edges_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_relation_edges_target ON public.workspace_database_relation_edges USING btree (target_database_id, target_row_id);


--
-- Name: idx_workspace_database_rollup_values_stale_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rollup_values_stale_scan ON public.workspace_database_rollup_values USING btree (stale_state, updated_at) WHERE (stale_state = ANY (ARRAY['stale'::text, 'failed'::text, 'recompute_pending'::text]));


--
-- Name: idx_workspace_database_rollup_values_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rollup_values_state ON public.workspace_database_rollup_values USING btree (database_id, field_id, stale_state, computed_at);


--
-- Name: idx_workspace_database_row_search_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_row_search_tsv ON public.workspace_database_row_search USING gin (tsv);


--
-- Name: idx_workspace_database_row_search_workspace_db_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_row_search_workspace_db_updated ON public.workspace_database_row_search USING btree (workspace_id, database_id, updated_at DESC);


--
-- Name: idx_workspace_database_rows_database_alive; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rows_database_alive ON public.workspace_database_rows USING btree (database_id, "position", id) WHERE (deleted_at IS NULL);


--
-- Name: idx_workspace_database_rows_database_kind_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rows_database_kind_position ON public.workspace_database_rows USING btree (database_id, row_kind, "position", id);


--
-- Name: idx_workspace_database_rows_database_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rows_database_position ON public.workspace_database_rows USING btree (database_id, "position", id);


--
-- Name: idx_workspace_database_rows_database_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rows_database_updated ON public.workspace_database_rows USING btree (database_id, updated_at DESC);


--
-- Name: idx_workspace_database_rows_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rows_doc ON public.workspace_database_rows USING btree (doc_id) WHERE (doc_id IS NOT NULL);


--
-- Name: idx_workspace_database_rows_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_rows_job ON public.workspace_database_rows USING btree (created_by_job_id) WHERE (created_by_job_id IS NOT NULL);


--
-- Name: idx_workspace_database_views_database_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_database_views_database_position ON public.workspace_database_views USING btree (database_id, "position", id);


--
-- Name: idx_workspace_databases_active_inventory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_databases_active_inventory ON public.workspace_databases USING btree (workspace_id, updated_at DESC, id) WHERE (deleted_at IS NULL);


--
-- Name: idx_workspace_databases_trash_inventory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_databases_trash_inventory ON public.workspace_databases USING btree (workspace_id, deleted_at DESC, id) WHERE (deleted_at IS NOT NULL);


--
-- Name: idx_workspace_databases_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_databases_workspace_updated ON public.workspace_databases USING btree (workspace_id, updated_at DESC, id);


--
-- Name: idx_workspace_import_compensations_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_import_compensations_pending ON public.workspace_import_compensations USING btree (import_id, sequence DESC) WHERE (completed_at IS NULL);


--
-- Name: idx_workspace_imports_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_imports_actor_created ON public.workspace_imports USING btree (actor_id, created_at DESC);


--
-- Name: idx_workspace_imports_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_imports_cleanup ON public.workspace_imports USING btree (status, updated_at) WHERE (status = ANY (ARRAY['cleanup_required'::text, 'staged'::text, 'previewed'::text, 'failed'::text, 'cancelled'::text]));


--
-- Name: idx_workspace_invite_links_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_invite_links_workspace ON public.workspace_invite_links USING btree (workspace_id);


--
-- Name: idx_workspace_memberships_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_memberships_status ON public.workspace_memberships USING btree (status);


--
-- Name: idx_workspace_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_memberships_user ON public.workspace_memberships USING btree (user_id);


--
-- Name: idx_workspace_memberships_ws_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_memberships_ws_status ON public.workspace_memberships USING btree (workspace_id, status);


--
-- Name: idx_workspace_template_instances_doc_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_template_instances_doc_key ON public.workspace_template_instances USING btree (workspace_id, workspace_doc_key) WHERE (workspace_doc_key IS NOT NULL);


--
-- Name: idx_workspace_template_instances_expected_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_template_instances_expected_hash ON public.workspace_template_instances USING btree (workspace_id, expected_hash) WHERE (expected_hash IS NOT NULL);


--
-- Name: idx_workspaces_orphaned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_orphaned ON public.workspaces USING btree (created_at DESC) WHERE ((owner_user_id IS NULL) AND (deleted_at IS NULL));


--
-- Name: idx_ws_template_instances_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ws_template_instances_state ON public.workspace_template_instances USING btree (state);


--
-- Name: idx_ws_template_instances_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ws_template_instances_workspace ON public.workspace_template_instances USING btree (workspace_id);


--
-- Name: idx_ws_template_policies_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ws_template_policies_template ON public.workspace_template_policies USING btree (template_id);


--
-- Name: idx_ws_template_policies_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ws_template_policies_workspace ON public.workspace_template_policies USING btree (workspace_id);


--
-- Name: mcp_idempotency_keys_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_idempotency_keys_created_at_idx ON public.mcp_idempotency_keys USING btree (created_at DESC, id DESC);


--
-- Name: mcp_idempotency_keys_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_idempotency_keys_unique_idx ON public.mcp_idempotency_keys USING btree (api_key_id, tool_name, idempotency_key);


--
-- Name: organization_project_request_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_project_request_parent_idx ON public.organization_project_request USING btree (parent_unit_id) WHERE (parent_unit_id IS NOT NULL);


--
-- Name: organization_project_request_requestor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_project_request_requestor_idx ON public.organization_project_request USING btree (requested_by);


--
-- Name: organization_project_request_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_project_request_status_idx ON public.organization_project_request USING btree (organization_id, status);


--
-- Name: organization_unit_member_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_member_role_idx ON public.organization_unit_member USING btree (unit_id, role);


--
-- Name: organization_unit_member_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_member_user_idx ON public.organization_unit_member USING btree (user_id);


--
-- Name: organization_unit_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_org_status_idx ON public.organization_unit USING btree (organization_id, status);


--
-- Name: organization_unit_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_parent_idx ON public.organization_unit USING btree (parent_unit_id);


--
-- Name: organization_unit_slug_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX organization_unit_slug_unique_idx ON public.organization_unit USING btree (organization_id, COALESCE(parent_unit_id, organization_id), slug);


--
-- Name: organization_unit_type_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_type_active_idx ON public.organization_unit_type USING btree (organization_id, is_active);


--
-- Name: organization_unit_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_type_idx ON public.organization_unit USING btree (unit_type_id);


--
-- Name: organization_unit_workspace_owner_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX organization_unit_workspace_owner_unique_idx ON public.organization_unit_workspace USING btree (workspace_id) WHERE (relationship = 'owner'::public.organization_unit_workspace_relationship);


--
-- Name: organization_unit_workspace_unit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_workspace_unit_idx ON public.organization_unit_workspace USING btree (unit_id, relationship);


--
-- Name: organization_unit_workspace_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_unit_workspace_workspace_idx ON public.organization_unit_workspace USING btree (workspace_id);


--
-- Name: uniq_brand_assets_global_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_brand_assets_global_slot ON public.brand_assets USING btree (slot, variant, quality_class) WHERE (scope = 'global'::text);


--
-- Name: uniq_brand_assets_workspace_slot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_brand_assets_workspace_slot ON public.brand_assets USING btree (workspace_id, slot, variant, quality_class) WHERE (scope = 'workspace'::text);


--
-- Name: uniq_branding_profiles_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_branding_profiles_global ON public.branding_profiles USING btree (scope) WHERE (scope = 'global'::text);


--
-- Name: uniq_branding_profiles_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_branding_profiles_workspace ON public.branding_profiles USING btree (workspace_id) WHERE (scope = 'workspace'::text);


--
-- Name: uniq_database_import_jobs_live_idem; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_database_import_jobs_live_idem ON public.database_import_jobs USING btree (workspace_id, idempotency_key) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text]));


--
-- Name: uniq_default_per_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_default_per_ws ON public.pdf_workspace_template_assignments USING btree (workspace_id) WHERE (is_default = true);


--
-- Name: uniq_document_brand_profiles_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_brand_profiles_global ON public.document_brand_profiles USING btree (scope) WHERE (scope = 'global'::text);


--
-- Name: uniq_document_brand_profiles_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_brand_profiles_workspace ON public.document_brand_profiles USING btree (workspace_id) WHERE (scope = 'workspace'::text);


--
-- Name: uniq_document_palette_default_per_theme; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_palette_default_per_theme ON public.document_theme_color_palettes USING btree (theme_id) WHERE (is_default = true);


--
-- Name: uniq_document_version_artifact_checksum; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_version_artifact_checksum ON public.document_version_artifact USING btree (version_id, artifact_kind, checksum_sha256) WHERE (checksum_sha256 IS NOT NULL);


--
-- Name: uniq_document_version_doc_version_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_version_doc_version_no ON public.document_version USING btree (doc_id, version_no);


--
-- Name: uniq_document_version_policy_global_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_version_policy_global_default ON public.document_version_policy USING btree (is_default) WHERE ((scope = 'global'::text) AND (is_default = true));


--
-- Name: uniq_document_version_policy_workspace_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_document_version_policy_workspace_default ON public.document_version_policy USING btree (workspace_id) WHERE ((scope = 'workspace'::text) AND (is_default = true));


--
-- Name: uniq_pdf_export_settings_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_pdf_export_settings_global ON public.pdf_export_settings USING btree (scope) WHERE (scope = 'global'::text);


--
-- Name: uniq_pdf_export_settings_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_pdf_export_settings_workspace ON public.pdf_export_settings USING btree (workspace_id) WHERE (scope = 'workspace'::text);


--
-- Name: uniq_theme_profiles_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_theme_profiles_global ON public.theme_profiles USING btree (scope) WHERE (scope = 'global'::text);


--
-- Name: uniq_theme_profiles_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_theme_profiles_workspace ON public.theme_profiles USING btree (workspace_id) WHERE (scope = 'workspace'::text);


--
-- Name: uniq_themes_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_themes_one_default ON public.themes USING btree (is_default) WHERE (is_default = true);


--
-- Name: uniq_typography_styles_pdf_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_typography_styles_pdf_role ON public.typography_styles USING btree (typography_id, pdf_role) WHERE (pdf_role IS NOT NULL);


--
-- Name: uniq_workspace_database_csv_mapping_templates_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_workspace_database_csv_mapping_templates_name ON public.workspace_database_csv_mapping_templates USING btree (workspace_id, name) WHERE (is_current = true);


--
-- Name: uq_workspace_template_instances_active_doc_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_workspace_template_instances_active_doc_key ON public.workspace_template_instances USING btree (workspace_id, workspace_doc_key) WHERE ((workspace_doc_key IS NOT NULL) AND (retired_at IS NULL));


--
-- Name: ux_calendar_event_source_links_anchor; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_calendar_event_source_links_anchor ON public.calendar_event_source_links USING btree (event_id, source_doc_id, relation, COALESCE(source_block_id, ''::text), COALESCE(source_start_offset, '-1'::integer), COALESCE(source_end_offset, '-1'::integer), source_kind);


--
-- Name: ux_database_field_roles_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_database_field_roles_scope ON public.database_field_roles USING btree (database_id, profile_kind, role_key, COALESCE(row_kind_scope, ''::text));


--
-- Name: ux_database_fields_id_database; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_database_fields_id_database ON public.workspace_database_fields USING btree (id, database_id);


--
-- Name: ux_database_row_reminders_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_database_row_reminders_live ON public.database_row_reminders USING btree (user_id, row_id, field_id, offset_minutes) WHERE (status = ANY (ARRAY['scheduled'::text, 'claimed'::text]));


--
-- Name: ux_database_rows_id_database; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_database_rows_id_database ON public.workspace_database_rows USING btree (id, database_id);


--
-- Name: ux_document_graph_occurrence_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_document_graph_occurrence_identity ON public.document_graph_occurrences USING btree (workspace_id, source_doc_id, source_block_id, raw_target_doc_id, link_kind, params_key);


--
-- Name: ux_workspace_database_fields_database_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_workspace_database_fields_database_id_id ON public.workspace_database_fields USING btree (database_id, id);


--
-- Name: ux_workspace_database_fields_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_workspace_database_fields_name ON public.workspace_database_fields USING btree (database_id, lower(name));


--
-- Name: ux_workspace_database_fields_single_title; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_workspace_database_fields_single_title ON public.workspace_database_fields USING btree (database_id) WHERE (field_type = 'title'::text);


--
-- Name: ux_workspace_database_views_database_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_workspace_database_views_database_id_id ON public.workspace_database_views USING btree (database_id, id);


--
-- Name: ux_workspace_database_views_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_workspace_database_views_name ON public.workspace_database_views USING btree (database_id, lower(name));


--
-- Name: workspace_content_extract_targets_unpublished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_content_extract_targets_unpublished_idx ON public.workspace_content_extract_targets USING btree (created_at) WHERE (published_at IS NULL);


--
-- Name: workspace_database_row_templates_database_kind_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_database_row_templates_database_kind_position_idx ON public.workspace_database_row_templates USING btree (database_id, row_kind, "position", id);


--
-- Name: workspace_database_row_templates_database_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_database_row_templates_database_name_key ON public.workspace_database_row_templates USING btree (database_id, lower(name));


--
-- Name: workspace_database_row_templates_database_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_database_row_templates_database_position_idx ON public.workspace_database_row_templates USING btree (database_id, "position", id);


--
-- Name: workspace_database_row_templates_enabled_default_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_database_row_templates_enabled_default_key ON public.workspace_database_row_templates USING btree (database_id) WHERE (enabled AND is_default);


--
-- Name: workspace_database_row_templates_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_database_row_templates_template_idx ON public.workspace_database_row_templates USING btree (template_id);


--
-- Name: workspace_database_row_templates_workspace_database_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_database_row_templates_workspace_database_idx ON public.workspace_database_row_templates USING btree (workspace_id, database_id);


--
-- Name: workspace_tag_document_assignments_workspace_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_tag_document_assignments_workspace_tag ON public.workspace_tag_document_assignments USING btree (workspace_id, tag_id, doc_id);


--
-- Name: workspace_tags_active_slug_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_tags_active_slug_unique ON public.workspace_tags USING btree (workspace_id, slug) WHERE (archived_at IS NULL);


--
-- Name: workspace_tags_workspace_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_tags_workspace_id_unique ON public.workspace_tags USING btree (workspace_id, id);


--
-- Name: workspace_tags_workspace_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_tags_workspace_lookup ON public.workspace_tags USING btree (workspace_id, archived_at, lower(name), id);


--
-- Name: workspaces_management_unit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_management_unit_idx ON public.workspaces USING btree (management_unit_id);


--
-- Name: workspaces_nonactive_lifecycle_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_nonactive_lifecycle_owner_idx ON public.workspaces USING btree (lifecycle_owner_kind, lifecycle_owner_id) WHERE (lifecycle_state <> 'active'::text);


--
-- Name: workspaces_one_personal_per_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_one_personal_per_user_idx ON public.workspaces USING btree (owner_user_id) WHERE (is_personal_workspace AND (deleted_at IS NULL));


--
-- Name: workspaces_owner_principal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_owner_principal_idx ON public.workspaces USING btree (owner_principal_type, owner_principal_id);


--
-- Name: workspaces_owner_principal_name_normalized_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_owner_principal_name_normalized_idx ON public.workspaces USING btree (owner_principal_type, owner_principal_id, name_normalized) WHERE ((deleted_at IS NULL) AND (name_normalized IS NOT NULL));


--
-- Name: docs docs_materialize_external_id_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER docs_materialize_external_id_before_insert BEFORE INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_materialize_external_id();


--
-- Name: docs trg_docs_materialize_audience_defaults_on_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_docs_materialize_audience_defaults_on_insert AFTER INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_materialize_audience_defaults_on_insert();


--
-- Name: docs trg_docs_materialize_metadata_defaults_on_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_docs_materialize_metadata_defaults_on_insert BEFORE INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_materialize_metadata_defaults_on_insert();


--
-- Name: docs trg_docs_reject_template_document_type; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_docs_reject_template_document_type BEFORE INSERT OR UPDATE OF document_type_id ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_reject_template_document_type();


--
-- Name: docs trg_docs_touch_metadata_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_docs_touch_metadata_revision BEFORE UPDATE OF status_id, document_type_id, classification_id, retention_policy_id, language_id, responsible_user_id, document_number, review_due_at, valid_from, valid_until, journal_date, current_version_id, dirty_since_current_version, version_display_mode, last_versioned_at ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_touch_metadata_revision();


--
-- Name: document_audience_definition trg_document_audience_definition_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_audience_definition_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_audience_definition FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: document_classification_definition trg_document_classification_definition_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_classification_definition_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_classification_definition FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: document_integration_state trg_document_integration_state_metadata_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_integration_state_metadata_revision AFTER INSERT OR DELETE OR UPDATE ON public.document_integration_state FOR EACH ROW EXECUTE FUNCTION public.document_metadata_touch_subsystem_revision();


--
-- Name: document_metadata_field_definition trg_document_metadata_field_definition_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_field_definition_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_metadata_field_definition FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('field_definition');


--
-- Name: organization_document_settings trg_document_metadata_guard_organization_settings_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_guard_organization_settings_policy BEFORE INSERT OR UPDATE OF default_document_type_id, default_classification_id, default_retention_policy_id, default_language_id, default_responsible_user_id, updated_by ON public.organization_document_settings FOR EACH ROW EXECUTE FUNCTION public.document_metadata_guard_organization_settings_policy();


--
-- Name: organization_document_settings trg_document_metadata_organization_settings_rematerialize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_organization_settings_rematerialize AFTER INSERT OR UPDATE OF status_schema_id, default_status_id, default_document_type_id, default_classification_id, default_retention_policy_id, default_language_id, default_responsible_user_id, updated_by ON public.organization_document_settings FOR EACH ROW EXECUTE FUNCTION public.document_metadata_rematerialize_organization_settings_trigger();


--
-- Name: organization trg_document_metadata_seed_organization_defaults; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_seed_organization_defaults AFTER INSERT ON public.organization FOR EACH ROW EXECUTE FUNCTION public.document_metadata_seed_organization_defaults_on_insert();


--
-- Name: workspace_memberships trg_document_metadata_workspace_membership_rematerialize_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_workspace_membership_rematerialize_delete AFTER DELETE ON public.workspace_memberships FOR EACH ROW EXECUTE FUNCTION public.document_metadata_rematerialize_workspace_membership_trigger();


--
-- Name: workspace_memberships trg_document_metadata_workspace_membership_rematerialize_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_workspace_membership_rematerialize_insert AFTER INSERT ON public.workspace_memberships FOR EACH ROW EXECUTE FUNCTION public.document_metadata_rematerialize_workspace_membership_trigger();


--
-- Name: workspace_memberships trg_document_metadata_workspace_membership_rematerialize_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_workspace_membership_rematerialize_update AFTER UPDATE OF role, status ON public.workspace_memberships FOR EACH ROW WHEN (((old.role IS DISTINCT FROM new.role) OR (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION public.document_metadata_rematerialize_workspace_membership_trigger();


--
-- Name: workspaces trg_document_metadata_workspace_owner_rematerialize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_workspace_owner_rematerialize AFTER UPDATE OF owner_user_id ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.document_metadata_rematerialize_workspace_owner_trigger();


--
-- Name: document_workspace_settings trg_document_metadata_workspace_settings_rematerialize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_metadata_workspace_settings_rematerialize AFTER INSERT OR UPDATE OF status_schema_id, default_status_id, default_document_type_id, default_classification_id, default_retention_policy_id, default_language_id, default_responsible_user_id, updated_by ON public.document_workspace_settings FOR EACH ROW EXECUTE FUNCTION public.document_metadata_rematerialize_workspace_settings_trigger();


--
-- Name: document_presentation_state trg_document_presentation_state_metadata_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_presentation_state_metadata_revision AFTER INSERT OR DELETE OR UPDATE ON public.document_presentation_state FOR EACH ROW EXECUTE FUNCTION public.document_metadata_touch_subsystem_revision();


--
-- Name: document_retention_policy_definition trg_document_retention_policy_definition_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_retention_policy_definition_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_retention_policy_definition FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: document_status_schema trg_document_status_schema_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_status_schema_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_status_schema FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: document_status_value trg_document_status_value_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_status_value_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_status_value FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: document_template_state trg_document_template_state_metadata_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_template_state_metadata_revision AFTER INSERT OR DELETE OR UPDATE ON public.document_template_state FOR EACH ROW EXECUTE FUNCTION public.document_metadata_touch_subsystem_revision();


--
-- Name: document_type_definition trg_document_type_definition_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_type_definition_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_type_definition FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: document_version trg_document_version_assign_version_no; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_version_assign_version_no BEFORE INSERT ON public.document_version FOR EACH ROW EXECUTE FUNCTION public.document_version_assign_version_no();


--
-- Name: document_workspace_settings trg_document_workspace_settings_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_document_workspace_settings_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.document_workspace_settings FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_workspace_epoch_trigger('defaults');


--
-- Name: git_sync_bindings trg_git_sync_document_path_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_git_sync_document_path_owner AFTER INSERT OR DELETE OR UPDATE OF profile_id, repo_path, doc_id, tombstone ON public.git_sync_bindings FOR EACH ROW EXECUTE FUNCTION public.sync_git_sync_document_path_owner();


--
-- Name: git_sync_file_bindings trg_git_sync_file_path_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_git_sync_file_path_owner AFTER INSERT OR DELETE OR UPDATE OF profile_id, repo_path, id, tombstoned ON public.git_sync_file_bindings FOR EACH ROW EXECUTE FUNCTION public.sync_git_sync_file_path_owner();


--
-- Name: language_definition trg_language_definition_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_language_definition_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.language_definition FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_global_epoch_trigger('reference_values');


--
-- Name: organization_document_audience_default trg_organization_document_audience_default_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_organization_document_audience_default_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.organization_document_audience_default FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_organization_epoch_trigger('defaults');


--
-- Name: organization_document_metadata_policy trg_organization_document_metadata_policy_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_organization_document_metadata_policy_epoch AFTER INSERT OR DELETE OR UPDATE ON public.organization_document_metadata_policy FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_organization_epoch_trigger('policy');


--
-- Name: organization_document_settings trg_organization_document_settings_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_organization_document_settings_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.organization_document_settings FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_organization_epoch_trigger('defaults');


--
-- Name: database_view_roles trg_validate_database_view_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_database_view_role BEFORE INSERT OR UPDATE ON public.database_view_roles FOR EACH ROW EXECUTE FUNCTION public.validate_database_view_role();


--
-- Name: workspace_document_audience_default trg_workspace_document_audience_default_metadata_epoch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_workspace_document_audience_default_metadata_epoch AFTER INSERT OR DELETE OR UPDATE ON public.workspace_document_audience_default FOR EACH ROW EXECUTE FUNCTION public.document_metadata_bump_workspace_epoch_trigger('defaults');


--
-- Name: workspace_database_csv_mapping_templates workspace_database_csv_mapping_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_database_csv_mapping_templates_updated_at BEFORE UPDATE ON public.workspace_database_csv_mapping_templates FOR EACH ROW EXECUTE FUNCTION public.trg_workspace_database_csv_mapping_templates_updated_at();


--
-- Name: workspaces workspaces_assign_default_pdf_template; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspaces_assign_default_pdf_template AFTER INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.assign_default_pdf_template_to_new_workspace();


--
-- Name: workspaces workspaces_normalize_owner_principal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspaces_normalize_owner_principal BEFORE INSERT ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.normalize_workspace_owner_principal();


--
-- Name: access_tokens access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: admin_audit_log admin_audit_log_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: admin_audit_log admin_audit_log_target_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_target_unit_id_fkey FOREIGN KEY (target_unit_id) REFERENCES public.organization_unit(id) ON DELETE SET NULL;


--
-- Name: ai_workspace_doc_embeddings ai_workspace_doc_embeddings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_doc_embeddings
    ADD CONSTRAINT ai_workspace_doc_embeddings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ai_workspace_file_embeddings ai_workspace_file_embeddings_workspace_id_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_file_embeddings
    ADD CONSTRAINT ai_workspace_file_embeddings_workspace_id_file_id_fkey FOREIGN KEY (workspace_id, file_id) REFERENCES public.ai_workspace_files(workspace_id, file_id) ON DELETE CASCADE;


--
-- Name: ai_workspace_files ai_workspace_files_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_files
    ADD CONSTRAINT ai_workspace_files_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: ai_workspace_ignored_docs ai_workspace_ignored_docs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_workspace_ignored_docs
    ADD CONSTRAINT ai_workspace_ignored_docs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: app_configs app_configs_last_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_configs
    ADD CONSTRAINT app_configs_last_updated_by_fkey FOREIGN KEY (last_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: app_server_branding app_server_branding_favicon_pack_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_server_branding
    ADD CONSTRAINT app_server_branding_favicon_pack_asset_id_fkey FOREIGN KEY (favicon_pack_asset_id) REFERENCES public.brand_assets(id) ON DELETE SET NULL;


--
-- Name: app_server_branding app_server_branding_logo_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_server_branding
    ADD CONSTRAINT app_server_branding_logo_asset_id_fkey FOREIGN KEY (logo_asset_id) REFERENCES public.brand_assets(id) ON DELETE SET NULL;


--
-- Name: app_server_branding app_server_branding_product_mark_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_server_branding
    ADD CONSTRAINT app_server_branding_product_mark_asset_id_fkey FOREIGN KEY (product_mark_asset_id) REFERENCES public.brand_assets(id) ON DELETE SET NULL;


--
-- Name: app_server_branding app_server_branding_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_server_branding
    ADD CONSTRAINT app_server_branding_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: blobs blobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: brand_assets brand_assets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_assets
    ADD CONSTRAINT brand_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: brand_assets brand_assets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_assets
    ADD CONSTRAINT brand_assets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: branding_assets branding_assets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branding_assets branding_assets_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.branding_profiles(id) ON DELETE CASCADE;


--
-- Name: branding_profiles branding_profiles_default_color_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_profiles
    ADD CONSTRAINT branding_profiles_default_color_profile_id_fkey FOREIGN KEY (default_color_profile_id) REFERENCES public.pdf_icc_profiles(id) ON DELETE SET NULL;


--
-- Name: branding_profiles branding_profiles_default_pdf_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_profiles
    ADD CONSTRAINT branding_profiles_default_pdf_template_id_fkey FOREIGN KEY (default_pdf_template_id) REFERENCES public.pdf_templates(id) ON DELETE SET NULL;


--
-- Name: branding_profiles branding_profiles_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_profiles
    ADD CONSTRAINT branding_profiles_theme_id_fkey FOREIGN KEY (theme_id) REFERENCES public.themes(id) ON DELETE RESTRICT;


--
-- Name: branding_profiles branding_profiles_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_profiles
    ADD CONSTRAINT branding_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branding_profiles branding_profiles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branding_profiles
    ADD CONSTRAINT branding_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: calendar_accounts calendar_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_accounts
    ADD CONSTRAINT calendar_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: calendar_event_instances calendar_event_instances_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_instances
    ADD CONSTRAINT calendar_event_instances_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_event_participants calendar_event_participants_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_event_participants calendar_event_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_participants
    ADD CONSTRAINT calendar_event_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: calendar_event_source_links calendar_event_source_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_source_links
    ADD CONSTRAINT calendar_event_source_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: calendar_event_source_links calendar_event_source_links_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_source_links
    ADD CONSTRAINT calendar_event_source_links_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_event_source_links calendar_event_source_links_source_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_source_links
    ADD CONSTRAINT calendar_event_source_links_source_doc_id_fkey FOREIGN KEY (source_doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: calendar_event_tags calendar_event_tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_event_tags
    ADD CONSTRAINT calendar_event_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.calendar_accounts(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_recurrence_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_recurrence_parent_id_fkey FOREIGN KEY (recurrence_parent_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_events calendar_events_source_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_source_doc_id_fkey FOREIGN KEY (source_doc_id) REFERENCES public.docs(id) ON DELETE SET NULL;


--
-- Name: calendar_events calendar_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT calendar_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: calendar_pending_writes calendar_pending_writes_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_pending_writes
    ADD CONSTRAINT calendar_pending_writes_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_reminder_dispatch_log calendar_reminder_dispatch_log_reminder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminder_dispatch_log
    ADD CONSTRAINT calendar_reminder_dispatch_log_reminder_id_fkey FOREIGN KEY (reminder_id) REFERENCES public.calendar_reminders(id) ON DELETE CASCADE;


--
-- Name: calendar_reminders calendar_reminders_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminders
    ADD CONSTRAINT calendar_reminders_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.calendar_events(id) ON DELETE CASCADE;


--
-- Name: calendar_subscriptions calendar_subscriptions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_subscriptions
    ADD CONSTRAINT calendar_subscriptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.calendar_accounts(id) ON DELETE CASCADE;


--
-- Name: color_schema_values color_schema_values_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_schema_values
    ADD CONSTRAINT color_schema_values_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.color_schemas(id) ON DELETE CASCADE;


--
-- Name: color_schemas color_schemas_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.color_schemas
    ADD CONSTRAINT color_schemas_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: comment_attachments comment_attachments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_attachments
    ADD CONSTRAINT comment_attachments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: comment_attachments comment_attachments_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_attachments
    ADD CONSTRAINT comment_attachments_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: comment_attachments comment_attachments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_attachments
    ADD CONSTRAINT comment_attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: comment_edit_history comment_edit_history_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_edit_history
    ADD CONSTRAINT comment_edit_history_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: comment_edit_history comment_edit_history_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_edit_history
    ADD CONSTRAINT comment_edit_history_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES public.users(id);


--
-- Name: comment_thread_read_state comment_thread_read_state_thread_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_thread_read_state
    ADD CONSTRAINT comment_thread_read_state_thread_comment_id_fkey FOREIGN KEY (thread_comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: comment_thread_read_state comment_thread_read_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_thread_read_state
    ADD CONSTRAINT comment_thread_read_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: comments comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: comments comments_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id);


--
-- Name: comments comments_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: comments comments_last_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_last_edited_by_fkey FOREIGN KEY (last_edited_by) REFERENCES public.users(id);


--
-- Name: comments comments_parent_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: comments comments_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: comments comments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: config_changelog config_changelog_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_changelog
    ADD CONSTRAINT config_changelog_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: connected_accounts connected_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connected_accounts
    ADD CONSTRAINT connected_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: copilot_context_items copilot_context_items_context_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_context_items
    ADD CONSTRAINT copilot_context_items_context_id_fkey FOREIGN KEY (context_id) REFERENCES public.copilot_contexts(id) ON DELETE CASCADE;


--
-- Name: copilot_contexts copilot_contexts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_contexts
    ADD CONSTRAINT copilot_contexts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: copilot_contexts copilot_contexts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_contexts
    ADD CONSTRAINT copilot_contexts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: copilot_embeddings copilot_embeddings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_embeddings
    ADD CONSTRAINT copilot_embeddings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: copilot_jobs copilot_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_jobs
    ADD CONSTRAINT copilot_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: copilot_jobs copilot_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_jobs
    ADD CONSTRAINT copilot_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: copilot_message_revisions copilot_message_revisions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_message_revisions
    ADD CONSTRAINT copilot_message_revisions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.copilot_messages(id) ON DELETE CASCADE;


--
-- Name: copilot_message_revisions copilot_message_revisions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_message_revisions
    ADD CONSTRAINT copilot_message_revisions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.copilot_sessions(id) ON DELETE CASCADE;


--
-- Name: copilot_messages copilot_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_messages
    ADD CONSTRAINT copilot_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.copilot_sessions(id) ON DELETE CASCADE;


--
-- Name: copilot_sessions copilot_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_sessions
    ADD CONSTRAINT copilot_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: copilot_sessions copilot_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_sessions
    ADD CONSTRAINT copilot_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: copilot_transcripts copilot_transcripts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_transcripts
    ADD CONSTRAINT copilot_transcripts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: copilot_workspaces copilot_workspaces_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copilot_workspaces
    ADD CONSTRAINT copilot_workspaces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: database_activity_events database_activity_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_activity_events
    ADD CONSTRAINT database_activity_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: database_activity_events database_activity_events_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_activity_events
    ADD CONSTRAINT database_activity_events_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: database_activity_events database_activity_events_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_activity_events
    ADD CONSTRAINT database_activity_events_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE SET NULL;


--
-- Name: database_activity_events database_activity_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_activity_events
    ADD CONSTRAINT database_activity_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: database_document_references database_document_references_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_document_references
    ADD CONSTRAINT database_document_references_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: database_document_references database_document_references_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_document_references
    ADD CONSTRAINT database_document_references_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: database_document_references database_document_references_resolved_target_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_document_references
    ADD CONSTRAINT database_document_references_resolved_target_doc_id_fkey FOREIGN KEY (resolved_target_doc_id) REFERENCES public.docs(id) ON DELETE SET NULL;


--
-- Name: database_document_references database_document_references_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_document_references
    ADD CONSTRAINT database_document_references_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: database_document_references database_document_references_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_document_references
    ADD CONSTRAINT database_document_references_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: database_field_roles database_field_roles_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_field_roles
    ADD CONSTRAINT database_field_roles_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.database_profiles(database_id) ON DELETE CASCADE;


--
-- Name: database_field_roles database_field_roles_field_database_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_field_roles
    ADD CONSTRAINT database_field_roles_field_database_fk FOREIGN KEY (database_id, field_id) REFERENCES public.workspace_database_fields(database_id, id) ON DELETE RESTRICT;


--
-- Name: database_import_jobs database_import_jobs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_import_jobs
    ADD CONSTRAINT database_import_jobs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: database_import_jobs database_import_jobs_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_import_jobs
    ADD CONSTRAINT database_import_jobs_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE SET NULL;


--
-- Name: database_import_jobs database_import_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_import_jobs
    ADD CONSTRAINT database_import_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: database_profiles database_profiles_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_profiles
    ADD CONSTRAINT database_profiles_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: database_row_reminders database_row_reminders_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT database_row_reminders_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: database_row_reminders database_row_reminders_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT database_row_reminders_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: database_row_reminders database_row_reminders_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT database_row_reminders_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: database_row_reminders database_row_reminders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT database_row_reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: database_row_reminders database_row_reminders_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT database_row_reminders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: database_unique_id_sequences database_unique_id_sequences_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_unique_id_sequences
    ADD CONSTRAINT database_unique_id_sequences_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: database_unique_id_sequences database_unique_id_sequences_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_unique_id_sequences
    ADD CONSTRAINT database_unique_id_sequences_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: database_view_roles database_view_roles_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_view_roles
    ADD CONSTRAINT database_view_roles_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.database_profiles(database_id) ON DELETE CASCADE;


--
-- Name: database_view_roles database_view_roles_view_database_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_view_roles
    ADD CONSTRAINT database_view_roles_view_database_fk FOREIGN KEY (database_id, view_id) REFERENCES public.workspace_database_views(database_id, id) ON DELETE RESTRICT;


--
-- Name: database_view_user_states database_view_user_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_view_user_states
    ADD CONSTRAINT database_view_user_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: database_view_user_states database_view_user_states_view_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_view_user_states
    ADD CONSTRAINT database_view_user_states_view_id_fkey FOREIGN KEY (view_id) REFERENCES public.workspace_database_views(id) ON DELETE CASCADE;


--
-- Name: doc_audience_assignment doc_audience_assignment_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_audience_assignment
    ADD CONSTRAINT doc_audience_assignment_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: doc_audience_assignment doc_audience_assignment_audience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_audience_assignment
    ADD CONSTRAINT doc_audience_assignment_audience_id_fkey FOREIGN KEY (audience_id) REFERENCES public.document_audience_definition(id) ON DELETE RESTRICT;


--
-- Name: doc_audience_assignment doc_audience_assignment_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_audience_assignment
    ADD CONSTRAINT doc_audience_assignment_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: doc_histories doc_histories_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_histories
    ADD CONSTRAINT doc_histories_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: doc_histories doc_histories_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_histories
    ADD CONSTRAINT doc_histories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: doc_snapshots doc_snapshots_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: doc_snapshots doc_snapshots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: doc_updates doc_updates_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: doc_updates doc_updates_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: doc_user_permissions doc_user_permissions_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_user_permissions
    ADD CONSTRAINT doc_user_permissions_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: doc_user_permissions doc_user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doc_user_permissions
    ADD CONSTRAINT doc_user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: docs docs_classification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_classification_id_fkey FOREIGN KEY (classification_id) REFERENCES public.document_classification_definition(id) ON DELETE SET NULL;


--
-- Name: docs docs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: docs docs_current_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES public.document_version(id) ON DELETE SET NULL;


--
-- Name: docs docs_document_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_document_type_id_fkey FOREIGN KEY (document_type_id) REFERENCES public.document_type_definition(id) ON DELETE SET NULL;


--
-- Name: docs docs_language_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_language_id_fkey FOREIGN KEY (language_id) REFERENCES public.language_definition(id) ON DELETE SET NULL;


--
-- Name: docs docs_metadata_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_metadata_updated_by_fkey FOREIGN KEY (metadata_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: docs docs_responsible_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_responsible_user_id_fkey FOREIGN KEY (responsible_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: docs docs_retention_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_retention_policy_id_fkey FOREIGN KEY (retention_policy_id) REFERENCES public.document_retention_policy_definition(id) ON DELETE SET NULL;


--
-- Name: docs docs_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.document_status_value(id) ON DELETE SET NULL;


--
-- Name: docs docs_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: docs docs_userspace_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_userspace_owner_id_fkey FOREIGN KEY (userspace_owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: docs docs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_audience_definition document_audience_definition_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_audience_definition
    ADD CONSTRAINT document_audience_definition_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_audience_definition document_audience_definition_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_audience_definition
    ADD CONSTRAINT document_audience_definition_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_brand_profiles document_brand_profiles_logo_large_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_brand_profiles
    ADD CONSTRAINT document_brand_profiles_logo_large_asset_id_fkey FOREIGN KEY (logo_large_asset_id) REFERENCES public.brand_assets(id) ON DELETE SET NULL;


--
-- Name: document_brand_profiles document_brand_profiles_logo_small_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_brand_profiles
    ADD CONSTRAINT document_brand_profiles_logo_small_asset_id_fkey FOREIGN KEY (logo_small_asset_id) REFERENCES public.brand_assets(id) ON DELETE SET NULL;


--
-- Name: document_brand_profiles document_brand_profiles_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_brand_profiles
    ADD CONSTRAINT document_brand_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_brand_profiles document_brand_profiles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_brand_profiles
    ADD CONSTRAINT document_brand_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_classification_definition document_classification_definition_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_classification_definition
    ADD CONSTRAINT document_classification_definition_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_classification_definition document_classification_definition_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_classification_definition
    ADD CONSTRAINT document_classification_definition_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_graph_index_state document_graph_index_state_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_index_state
    ADD CONSTRAINT document_graph_index_state_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_graph_index_state document_graph_index_state_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_index_state
    ADD CONSTRAINT document_graph_index_state_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_graph_occurrences document_graph_occurrences_source_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_occurrences
    ADD CONSTRAINT document_graph_occurrences_source_doc_id_fkey FOREIGN KEY (source_doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_graph_occurrences document_graph_occurrences_target_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_occurrences
    ADD CONSTRAINT document_graph_occurrences_target_doc_id_fkey FOREIGN KEY (target_doc_id) REFERENCES public.docs(id) ON DELETE SET NULL;


--
-- Name: document_graph_occurrences document_graph_occurrences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_graph_occurrences
    ADD CONSTRAINT document_graph_occurrences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_initial_sync_audit document_initial_sync_audit_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_initial_sync_audit document_initial_sync_audit_applied_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_applied_created_by_fkey FOREIGN KEY (applied_created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_initial_sync_audit document_initial_sync_audit_applied_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_applied_updated_by_fkey FOREIGN KEY (applied_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_initial_sync_audit document_initial_sync_audit_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_initial_sync_audit document_initial_sync_audit_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_initial_sync_audit
    ADD CONSTRAINT document_initial_sync_audit_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_integration_state document_integration_state_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_integration_state
    ADD CONSTRAINT document_integration_state_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_integration_state document_integration_state_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_integration_state
    ADD CONSTRAINT document_integration_state_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_metadata_field_definition document_metadata_field_definition_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_metadata_field_definition
    ADD CONSTRAINT document_metadata_field_definition_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_metadata_global_epoch document_metadata_global_epoch_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_metadata_global_epoch
    ADD CONSTRAINT document_metadata_global_epoch_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_presentation_state document_presentation_state_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_presentation_state
    ADD CONSTRAINT document_presentation_state_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_presentation_state document_presentation_state_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_presentation_state
    ADD CONSTRAINT document_presentation_state_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_retention_policy_definition document_retention_policy_definition_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retention_policy_definition
    ADD CONSTRAINT document_retention_policy_definition_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_retention_policy_definition document_retention_policy_definition_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_retention_policy_definition
    ADD CONSTRAINT document_retention_policy_definition_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_status_schema document_status_schema_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_schema
    ADD CONSTRAINT document_status_schema_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_status_schema document_status_schema_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_schema
    ADD CONSTRAINT document_status_schema_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_status_transition document_status_transition_from_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_transition
    ADD CONSTRAINT document_status_transition_from_status_id_fkey FOREIGN KEY (from_status_id) REFERENCES public.document_status_value(id) ON DELETE CASCADE;


--
-- Name: document_status_transition document_status_transition_to_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_transition
    ADD CONSTRAINT document_status_transition_to_status_id_fkey FOREIGN KEY (to_status_id) REFERENCES public.document_status_value(id) ON DELETE CASCADE;


--
-- Name: document_status_value document_status_value_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_status_value
    ADD CONSTRAINT document_status_value_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.document_status_schema(id) ON DELETE CASCADE;


--
-- Name: document_template_state document_template_state_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_template_state
    ADD CONSTRAINT document_template_state_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_template_state document_template_state_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_template_state
    ADD CONSTRAINT document_template_state_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.workspace_template_instances(id) ON DELETE SET NULL;


--
-- Name: document_template_state document_template_state_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_template_state
    ADD CONSTRAINT document_template_state_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.template_revisions(id) ON DELETE SET NULL;


--
-- Name: document_template_state document_template_state_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_template_state
    ADD CONSTRAINT document_template_state_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE SET NULL;


--
-- Name: document_template_state document_template_state_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_template_state
    ADD CONSTRAINT document_template_state_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_theme_color_palettes document_theme_color_palettes_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_theme_color_palettes
    ADD CONSTRAINT document_theme_color_palettes_theme_id_fkey FOREIGN KEY (theme_id) REFERENCES public.themes(id) ON DELETE CASCADE;


--
-- Name: document_type_definition document_type_definition_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_definition
    ADD CONSTRAINT document_type_definition_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_type_definition document_type_definition_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_definition
    ADD CONSTRAINT document_type_definition_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_type_status_default document_type_status_default_document_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_status_default
    ADD CONSTRAINT document_type_status_default_document_type_id_fkey FOREIGN KEY (document_type_id) REFERENCES public.document_type_definition(id) ON DELETE CASCADE;


--
-- Name: document_type_status_default document_type_status_default_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_status_default
    ADD CONSTRAINT document_type_status_default_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.document_status_value(id) ON DELETE RESTRICT;


--
-- Name: document_type_status_default document_type_status_default_status_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_status_default
    ADD CONSTRAINT document_type_status_default_status_schema_id_fkey FOREIGN KEY (status_schema_id) REFERENCES public.document_status_schema(id) ON DELETE CASCADE;


--
-- Name: document_version_artifact document_version_artifact_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_artifact
    ADD CONSTRAINT document_version_artifact_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_version_artifact document_version_artifact_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_artifact
    ADD CONSTRAINT document_version_artifact_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.document_version(id) ON DELETE CASCADE;


--
-- Name: document_version document_version_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: document_version document_version_doc_history_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_doc_history_id_fkey FOREIGN KEY (doc_history_id) REFERENCES public.doc_histories(id) ON DELETE RESTRICT;


--
-- Name: document_version document_version_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_version_label_counter document_version_label_counter_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_label_counter
    ADD CONSTRAINT document_version_label_counter_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_version_policy document_version_policy_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_policy
    ADD CONSTRAINT document_version_policy_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_version document_version_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.document_version_policy(id) ON DELETE SET NULL;


--
-- Name: document_version_policy document_version_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_policy
    ADD CONSTRAINT document_version_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_version_policy document_version_policy_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_policy
    ADD CONSTRAINT document_version_policy_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_version_relation document_version_relation_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_relation
    ADD CONSTRAINT document_version_relation_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_version_relation document_version_relation_from_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_relation
    ADD CONSTRAINT document_version_relation_from_version_id_fkey FOREIGN KEY (from_version_id) REFERENCES public.document_version(id) ON DELETE CASCADE;


--
-- Name: document_version_relation document_version_relation_to_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version_relation
    ADD CONSTRAINT document_version_relation_to_version_id_fkey FOREIGN KEY (to_version_id) REFERENCES public.document_version(id) ON DELETE CASCADE;


--
-- Name: document_version document_version_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_version document_version_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_version
    ADD CONSTRAINT document_version_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_versioning_settings document_versioning_settings_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versioning_settings
    ADD CONSTRAINT document_versioning_settings_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: document_versioning_settings document_versioning_settings_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versioning_settings
    ADD CONSTRAINT document_versioning_settings_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.document_version_policy(id) ON DELETE SET NULL;


--
-- Name: document_versioning_workspace_settings document_versioning_workspace_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versioning_workspace_settings
    ADD CONSTRAINT document_versioning_workspace_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_versioning_workspace_settings document_versioning_workspace_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versioning_workspace_settings
    ADD CONSTRAINT document_versioning_workspace_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: document_workspace_settings document_workspace_settings_default_classification_typed_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_classification_typed_fkey FOREIGN KEY (default_classification_id) REFERENCES public.document_classification_definition(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_default_document_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_document_type_id_fkey FOREIGN KEY (default_document_type_id) REFERENCES public.document_type_definition(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_default_language_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_language_id_fkey FOREIGN KEY (default_language_id) REFERENCES public.language_definition(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_default_responsible_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_responsible_user_id_fkey FOREIGN KEY (default_responsible_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_default_retention_typed_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_retention_typed_fkey FOREIGN KEY (default_retention_policy_id) REFERENCES public.document_retention_policy_definition(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_default_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_status_id_fkey FOREIGN KEY (default_status_id) REFERENCES public.document_status_value(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_default_status_schema_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_default_status_schema_fkey FOREIGN KEY (status_schema_id, default_status_id) REFERENCES public.document_status_value(schema_id, id) ON DELETE RESTRICT;


--
-- Name: document_workspace_settings document_workspace_settings_status_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_status_schema_id_fkey FOREIGN KEY (status_schema_id) REFERENCES public.document_status_schema(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_version_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_version_policy_id_fkey FOREIGN KEY (version_policy_id) REFERENCES public.document_version_policy(id) ON DELETE SET NULL;


--
-- Name: document_workspace_settings document_workspace_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_workspace_settings
    ADD CONSTRAINT document_workspace_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: calendar_events fk_calendar_events_tag; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_events
    ADD CONSTRAINT fk_calendar_events_tag FOREIGN KEY (tag_id) REFERENCES public.calendar_event_tags(id) ON DELETE SET NULL;


--
-- Name: database_row_reminders fk_database_row_reminders_field_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT fk_database_row_reminders_field_database FOREIGN KEY (field_id, database_id) REFERENCES public.workspace_database_fields(id, database_id) ON DELETE CASCADE;


--
-- Name: database_row_reminders fk_database_row_reminders_row_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_row_reminders
    ADD CONSTRAINT fk_database_row_reminders_row_database FOREIGN KEY (row_id, database_id) REFERENCES public.workspace_database_rows(id, database_id) ON DELETE CASCADE;


--
-- Name: workspace_database_cell_values fk_workspace_database_cells_field_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT fk_workspace_database_cells_field_database FOREIGN KEY (field_id, database_id) REFERENCES public.workspace_database_fields(id, database_id) ON DELETE CASCADE;


--
-- Name: workspace_database_cell_values fk_workspace_database_cells_row_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT fk_workspace_database_cells_row_database FOREIGN KEY (row_id, database_id) REFERENCES public.workspace_database_rows(id, database_id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges fk_workspace_database_relations_source_field_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT fk_workspace_database_relations_source_field_database FOREIGN KEY (source_field_id, source_database_id) REFERENCES public.workspace_database_fields(id, database_id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges fk_workspace_database_relations_source_row_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT fk_workspace_database_relations_source_row_database FOREIGN KEY (source_row_id, source_database_id) REFERENCES public.workspace_database_rows(id, database_id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges fk_workspace_database_relations_target_row_database; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT fk_workspace_database_relations_target_row_database FOREIGN KEY (target_row_id, target_database_id) REFERENCES public.workspace_database_rows(id, database_id) ON DELETE CASCADE;


--
-- Name: font_assets font_assets_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.font_assets
    ADD CONSTRAINT font_assets_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.font_families(id) ON DELETE CASCADE;


--
-- Name: font_families font_families_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.font_families
    ADD CONSTRAINT font_families_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: git_sync_baselines git_sync_baselines_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_baselines
    ADD CONSTRAINT git_sync_baselines_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.git_sync_bindings(id) ON DELETE CASCADE;


--
-- Name: git_sync_bindings git_sync_bindings_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_bindings
    ADD CONSTRAINT git_sync_bindings_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_blob_promotions git_sync_blob_promotions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_blob_promotions
    ADD CONSTRAINT git_sync_blob_promotions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_blob_promotions git_sync_blob_promotions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_blob_promotions
    ADD CONSTRAINT git_sync_blob_promotions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.git_sync_runs(id) ON DELETE RESTRICT;


--
-- Name: git_sync_blob_promotions git_sync_blob_promotions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_blob_promotions
    ADD CONSTRAINT git_sync_blob_promotions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: git_sync_bootstrap_attempts git_sync_bootstrap_attempts_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_bootstrap_attempts
    ADD CONSTRAINT git_sync_bootstrap_attempts_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_conflicts git_sync_conflicts_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_conflicts
    ADD CONSTRAINT git_sync_conflicts_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.git_sync_bindings(id) ON DELETE CASCADE;


--
-- Name: git_sync_conflicts git_sync_conflicts_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_conflicts
    ADD CONSTRAINT git_sync_conflicts_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_conflicts git_sync_conflicts_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_conflicts
    ADD CONSTRAINT git_sync_conflicts_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: git_sync_credentials git_sync_credentials_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_credentials
    ADD CONSTRAINT git_sync_credentials_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_file_baselines git_sync_file_baselines_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_baselines
    ADD CONSTRAINT git_sync_file_baselines_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_file_bindings git_sync_file_bindings_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_bindings
    ADD CONSTRAINT git_sync_file_bindings_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_file_bindings git_sync_file_bindings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_bindings
    ADD CONSTRAINT git_sync_file_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: git_sync_file_conflicts git_sync_file_conflicts_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_conflicts
    ADD CONSTRAINT git_sync_file_conflicts_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.git_sync_file_bindings(id) ON DELETE SET NULL;


--
-- Name: git_sync_file_conflicts git_sync_file_conflicts_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_conflicts
    ADD CONSTRAINT git_sync_file_conflicts_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_file_conflicts git_sync_file_conflicts_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_conflicts
    ADD CONSTRAINT git_sync_file_conflicts_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: git_sync_file_conflicts git_sync_file_conflicts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_file_conflicts
    ADD CONSTRAINT git_sync_file_conflicts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.git_sync_runs(id) ON DELETE CASCADE;


--
-- Name: git_sync_partial_items git_sync_partial_items_last_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_items
    ADD CONSTRAINT git_sync_partial_items_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES public.git_sync_runs(id) ON DELETE SET NULL;


--
-- Name: git_sync_partial_items git_sync_partial_items_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_items
    ADD CONSTRAINT git_sync_partial_items_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_partial_items git_sync_partial_items_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_items
    ADD CONSTRAINT git_sync_partial_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.git_sync_partial_sessions(id) ON DELETE CASCADE;


--
-- Name: git_sync_partial_sessions git_sync_partial_sessions_created_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_sessions
    ADD CONSTRAINT git_sync_partial_sessions_created_run_id_fkey FOREIGN KEY (created_run_id) REFERENCES public.git_sync_runs(id) ON DELETE CASCADE;


--
-- Name: git_sync_partial_sessions git_sync_partial_sessions_last_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_sessions
    ADD CONSTRAINT git_sync_partial_sessions_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES public.git_sync_runs(id) ON DELETE SET NULL;


--
-- Name: git_sync_partial_sessions git_sync_partial_sessions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_partial_sessions
    ADD CONSTRAINT git_sync_partial_sessions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_path_owners git_sync_path_owners_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_path_owners
    ADD CONSTRAINT git_sync_path_owners_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_profiles git_sync_profiles_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_profiles
    ADD CONSTRAINT git_sync_profiles_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: git_sync_profiles git_sync_profiles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_profiles
    ADD CONSTRAINT git_sync_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: git_sync_runs git_sync_runs_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_runs
    ADD CONSTRAINT git_sync_runs_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_ssh_host_keys git_sync_ssh_host_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_ssh_host_keys
    ADD CONSTRAINT git_sync_ssh_host_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: git_sync_version_links git_sync_version_links_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_version_links
    ADD CONSTRAINT git_sync_version_links_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_version_links git_sync_version_links_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_version_links
    ADD CONSTRAINT git_sync_version_links_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.git_sync_runs(id) ON DELETE CASCADE;


--
-- Name: git_sync_webhook_deliveries git_sync_webhook_deliveries_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_webhook_deliveries
    ADD CONSTRAINT git_sync_webhook_deliveries_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.git_sync_profiles(id) ON DELETE CASCADE;


--
-- Name: git_sync_webhook_deliveries git_sync_webhook_deliveries_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_sync_webhook_deliveries
    ADD CONSTRAINT git_sync_webhook_deliveries_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.git_sync_runs(id) ON DELETE SET NULL;


--
-- Name: language_definition language_definition_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_definition
    ADD CONSTRAINT language_definition_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: language_definition language_definition_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.language_definition
    ADD CONSTRAINT language_definition_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: magic_link_otps magic_link_otps_verification_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.magic_link_otps
    ADD CONSTRAINT magic_link_otps_verification_token_id_fkey FOREIGN KEY (verification_token_id) REFERENCES public.verification_tokens(id) ON DELETE CASCADE;


--
-- Name: mcp_idempotency_keys mcp_idempotency_keys_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_idempotency_keys
    ADD CONSTRAINT mcp_idempotency_keys_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;


--
-- Name: mcp_idempotency_keys mcp_idempotency_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_idempotency_keys
    ADD CONSTRAINT mcp_idempotency_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: multipart_blob_parts multipart_blob_parts_workspace_id_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multipart_blob_parts
    ADD CONSTRAINT multipart_blob_parts_workspace_id_key_fkey FOREIGN KEY (workspace_id, key) REFERENCES public.blobs(workspace_id, key) ON DELETE CASCADE;


--
-- Name: multipart_uploads multipart_uploads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.multipart_uploads
    ADD CONSTRAINT multipart_uploads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: organization_document_audience_default organization_document_audience_default_audience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_audience_default
    ADD CONSTRAINT organization_document_audience_default_audience_id_fkey FOREIGN KEY (audience_id) REFERENCES public.document_audience_definition(id) ON DELETE RESTRICT;


--
-- Name: organization_document_audience_default organization_document_audience_default_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_audience_default
    ADD CONSTRAINT organization_document_audience_default_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_document_metadata_epoch organization_document_metadata_epoch_organization_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_epoch
    ADD CONSTRAINT organization_document_metadata_epoch_organization_id_fkey1 FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_document_metadata_epoch organization_document_metadata_epoch_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_epoch
    ADD CONSTRAINT organization_document_metadata_epoch_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_document_metadata_policy organization_document_metadata_policy_field_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_policy
    ADD CONSTRAINT organization_document_metadata_policy_field_key_fkey FOREIGN KEY (field_key) REFERENCES public.document_metadata_field_definition(key) ON DELETE CASCADE;


--
-- Name: organization_document_metadata_policy organization_document_metadata_policy_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_policy
    ADD CONSTRAINT organization_document_metadata_policy_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_document_metadata_policy organization_document_metadata_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_metadata_policy
    ADD CONSTRAINT organization_document_metadata_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_classification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_classification_id_fkey FOREIGN KEY (default_classification_id) REFERENCES public.document_classification_definition(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_document_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_document_type_id_fkey FOREIGN KEY (default_document_type_id) REFERENCES public.document_type_definition(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_language_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_language_id_fkey FOREIGN KEY (default_language_id) REFERENCES public.language_definition(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_responsible_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_responsible_user_id_fkey FOREIGN KEY (default_responsible_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_retention_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_retention_policy_id_fkey FOREIGN KEY (default_retention_policy_id) REFERENCES public.document_retention_policy_definition(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_status_id_fkey FOREIGN KEY (default_status_id) REFERENCES public.document_status_value(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_default_status_schema_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_default_status_schema_fkey FOREIGN KEY (status_schema_id, default_status_id) REFERENCES public.document_status_value(schema_id, id) ON DELETE RESTRICT;


--
-- Name: organization_document_settings organization_document_settings_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_document_settings organization_document_settings_status_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_status_schema_id_fkey FOREIGN KEY (status_schema_id) REFERENCES public.document_status_schema(id) ON DELETE SET NULL;


--
-- Name: organization_document_settings organization_document_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_document_settings
    ADD CONSTRAINT organization_document_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_identity organization_identity_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_identity
    ADD CONSTRAINT organization_identity_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_policy organization_policy_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_policy
    ADD CONSTRAINT organization_policy_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_policy organization_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_policy
    ADD CONSTRAINT organization_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_project_request organization_project_request_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_project_request
    ADD CONSTRAINT organization_project_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_project_request organization_project_request_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_project_request
    ADD CONSTRAINT organization_project_request_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_project_request organization_project_request_parent_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_project_request
    ADD CONSTRAINT organization_project_request_parent_unit_id_fkey FOREIGN KEY (parent_unit_id) REFERENCES public.organization_unit(id) ON DELETE SET NULL;


--
-- Name: organization_project_request organization_project_request_proposed_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_project_request
    ADD CONSTRAINT organization_project_request_proposed_type_id_fkey FOREIGN KEY (proposed_type_id) REFERENCES public.organization_unit_type(id) ON DELETE SET NULL;


--
-- Name: organization_project_request organization_project_request_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_project_request
    ADD CONSTRAINT organization_project_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: organization_unit organization_unit_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit
    ADD CONSTRAINT organization_unit_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_unit_member organization_unit_member_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_member
    ADD CONSTRAINT organization_unit_member_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.organization_unit(id) ON DELETE CASCADE;


--
-- Name: organization_unit_member organization_unit_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_member
    ADD CONSTRAINT organization_unit_member_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: organization_unit organization_unit_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit
    ADD CONSTRAINT organization_unit_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE RESTRICT;


--
-- Name: organization_unit organization_unit_parent_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit
    ADD CONSTRAINT organization_unit_parent_unit_id_fkey FOREIGN KEY (parent_unit_id) REFERENCES public.organization_unit(id) ON DELETE RESTRICT;


--
-- Name: organization_unit_type organization_unit_type_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_type
    ADD CONSTRAINT organization_unit_type_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: organization_unit organization_unit_unit_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit
    ADD CONSTRAINT organization_unit_unit_type_id_fkey FOREIGN KEY (unit_type_id) REFERENCES public.organization_unit_type(id) ON DELETE RESTRICT;


--
-- Name: organization_unit_workspace organization_unit_workspace_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_workspace
    ADD CONSTRAINT organization_unit_workspace_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.organization_unit(id) ON DELETE CASCADE;


--
-- Name: organization_unit_workspace organization_unit_workspace_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_unit_workspace
    ADD CONSTRAINT organization_unit_workspace_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pdf_export_settings pdf_export_settings_default_color_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_settings
    ADD CONSTRAINT pdf_export_settings_default_color_profile_id_fkey FOREIGN KEY (default_color_profile_id) REFERENCES public.pdf_icc_profiles(id) ON DELETE SET NULL;


--
-- Name: pdf_export_settings pdf_export_settings_default_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_settings
    ADD CONSTRAINT pdf_export_settings_default_template_id_fkey FOREIGN KEY (default_template_id) REFERENCES public.pdf_templates(id) ON DELETE SET NULL;


--
-- Name: pdf_export_settings pdf_export_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_settings
    ADD CONSTRAINT pdf_export_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: pdf_export_settings pdf_export_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_export_settings
    ADD CONSTRAINT pdf_export_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pdf_fonts pdf_fonts_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_fonts
    ADD CONSTRAINT pdf_fonts_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: pdf_fonts pdf_fonts_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_fonts
    ADD CONSTRAINT pdf_fonts_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: pdf_icc_profiles pdf_icc_profiles_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_icc_profiles
    ADD CONSTRAINT pdf_icc_profiles_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: pdf_template_files pdf_template_files_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_template_files
    ADD CONSTRAINT pdf_template_files_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.pdf_templates(id) ON DELETE CASCADE;


--
-- Name: pdf_templates pdf_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_templates
    ADD CONSTRAINT pdf_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: pdf_workspace_template_assignments pdf_workspace_template_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_workspace_template_assignments
    ADD CONSTRAINT pdf_workspace_template_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: pdf_workspace_template_assignments pdf_workspace_template_assignments_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_workspace_template_assignments
    ADD CONSTRAINT pdf_workspace_template_assignments_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.pdf_templates(id) ON DELETE RESTRICT;


--
-- Name: pdf_workspace_template_assignments pdf_workspace_template_assignments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_workspace_template_assignments
    ADD CONSTRAINT pdf_workspace_template_assignments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: public_asset_manifest public_asset_manifest_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_asset_manifest
    ADD CONSTRAINT public_asset_manifest_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: public_asset_manifest public_asset_manifest_workspace_id_blob_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_asset_manifest
    ADD CONSTRAINT public_asset_manifest_workspace_id_blob_key_fkey FOREIGN KEY (workspace_id, blob_key) REFERENCES public.blobs(workspace_id, key) ON DELETE CASCADE;


--
-- Name: public_asset_manifest public_asset_manifest_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_asset_manifest
    ADD CONSTRAINT public_asset_manifest_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: public_render_artifacts public_render_artifacts_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_render_artifacts
    ADD CONSTRAINT public_render_artifacts_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: public_render_artifacts public_render_artifacts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_render_artifacts
    ADD CONSTRAINT public_render_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: search_content search_content_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_content
    ADD CONSTRAINT search_content_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: search_content search_content_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_content
    ADD CONSTRAINT search_content_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: search_reindex_runs search_reindex_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_reindex_runs
    ADD CONSTRAINT search_reindex_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: session_links session_links_root_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_links
    ADD CONSTRAINT session_links_root_session_id_fkey FOREIGN KEY (root_session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: session_links session_links_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_links
    ADD CONSTRAINT session_links_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: session_links session_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_links
    ADD CONSTRAINT session_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telemetry_events telemetry_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: template_catalog_entries template_catalog_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_catalog_entries
    ADD CONSTRAINT template_catalog_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: template_default_policies template_default_policies_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_default_policies
    ADD CONSTRAINT template_default_policies_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE CASCADE;


--
-- Name: template_import_jobs template_import_jobs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_import_jobs
    ADD CONSTRAINT template_import_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: template_import_jobs template_import_jobs_result_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_import_jobs
    ADD CONSTRAINT template_import_jobs_result_revision_id_fkey FOREIGN KEY (result_revision_id) REFERENCES public.template_revisions(id) ON DELETE SET NULL;


--
-- Name: template_reconcile_jobs template_reconcile_jobs_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_reconcile_jobs
    ADD CONSTRAINT template_reconcile_jobs_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE CASCADE;


--
-- Name: template_reconcile_jobs template_reconcile_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_reconcile_jobs
    ADD CONSTRAINT template_reconcile_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: template_registry_audit_events template_registry_audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: template_registry_audit_events template_registry_audit_events_import_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_import_job_id_fkey FOREIGN KEY (import_job_id) REFERENCES public.template_import_jobs(id) ON DELETE SET NULL;


--
-- Name: template_registry_audit_events template_registry_audit_events_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.workspace_template_instances(id) ON DELETE SET NULL;


--
-- Name: template_registry_audit_events template_registry_audit_events_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.workspace_template_policies(id) ON DELETE SET NULL;


--
-- Name: template_registry_audit_events template_registry_audit_events_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.template_revisions(id) ON DELETE SET NULL;


--
-- Name: template_registry_audit_events template_registry_audit_events_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE SET NULL;


--
-- Name: template_registry_audit_events template_registry_audit_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry_audit_events
    ADD CONSTRAINT template_registry_audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: template_revisions template_revisions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_revisions
    ADD CONSTRAINT template_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: template_revisions template_revisions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_revisions
    ADD CONSTRAINT template_revisions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE CASCADE;


--
-- Name: theme_profiles theme_profiles_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.theme_profiles
    ADD CONSTRAINT theme_profiles_theme_id_fkey FOREIGN KEY (theme_id) REFERENCES public.themes(id) ON DELETE RESTRICT;


--
-- Name: theme_profiles theme_profiles_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.theme_profiles
    ADD CONSTRAINT theme_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: theme_profiles theme_profiles_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.theme_profiles
    ADD CONSTRAINT theme_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: themes themes_color_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_color_schema_id_fkey FOREIGN KEY (color_schema_id) REFERENCES public.color_schemas(id) ON DELETE RESTRICT;


--
-- Name: themes themes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: themes themes_typography_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.themes
    ADD CONSTRAINT themes_typography_id_fkey FOREIGN KEY (typography_id) REFERENCES public.typography_sets(id) ON DELETE RESTRICT;


--
-- Name: typography_sets typography_sets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typography_sets
    ADD CONSTRAINT typography_sets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: typography_styles typography_styles_font_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typography_styles
    ADD CONSTRAINT typography_styles_font_family_id_fkey FOREIGN KEY (font_family_id) REFERENCES public.font_families(id) ON DELETE RESTRICT;


--
-- Name: typography_styles typography_styles_typography_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.typography_styles
    ADD CONSTRAINT typography_styles_typography_id_fkey FOREIGN KEY (typography_id) REFERENCES public.typography_sets(id) ON DELETE CASCADE;


--
-- Name: user_features user_features_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_features
    ADD CONSTRAINT user_features_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: verification_tokens verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_analytics_minute workspace_analytics_minute_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_analytics_minute
    ADD CONSTRAINT workspace_analytics_minute_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_automation_actions workspace_automation_actions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_actions
    ADD CONSTRAINT workspace_automation_actions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workspace_automation_runs(id) ON DELETE CASCADE;


--
-- Name: workspace_automation_runs workspace_automation_runs_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_runs
    ADD CONSTRAINT workspace_automation_runs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.workspace_automations(id) ON DELETE CASCADE;


--
-- Name: workspace_automation_runs workspace_automation_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_runs
    ADD CONSTRAINT workspace_automation_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_automation_webhook_deliveries workspace_automation_webhook_deliveries_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_webhook_deliveries
    ADD CONSTRAINT workspace_automation_webhook_deliveries_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.workspace_automation_actions(id) ON DELETE CASCADE;


--
-- Name: workspace_automation_webhook_deliveries workspace_automation_webhook_deliveries_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automation_webhook_deliveries
    ADD CONSTRAINT workspace_automation_webhook_deliveries_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.workspace_automation_runs(id) ON DELETE CASCADE;


--
-- Name: workspace_automations workspace_automations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automations
    ADD CONSTRAINT workspace_automations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_automations workspace_automations_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automations
    ADD CONSTRAINT workspace_automations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_automations workspace_automations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_automations
    ADD CONSTRAINT workspace_automations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_calendar_settings workspace_calendar_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_calendar_settings
    ADD CONSTRAINT workspace_calendar_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_calendar_settings workspace_calendar_settings_writeback_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_calendar_settings
    ADD CONSTRAINT workspace_calendar_settings_writeback_subscription_id_fkey FOREIGN KEY (writeback_subscription_id) REFERENCES public.calendar_subscriptions(id) ON DELETE SET NULL;


--
-- Name: workspace_calendars workspace_calendars_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_calendars
    ADD CONSTRAINT workspace_calendars_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.calendar_accounts(id) ON DELETE CASCADE;


--
-- Name: workspace_calendars workspace_calendars_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_calendars
    ADD CONSTRAINT workspace_calendars_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_content_copy_publications workspace_content_copy_publications_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_copy_publications
    ADD CONSTRAINT workspace_content_copy_publications_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_copy_publications workspace_content_copy_publications_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_copy_publications
    ADD CONSTRAINT workspace_content_copy_publications_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_extract_publications workspace_content_extract_publications_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_publications
    ADD CONSTRAINT workspace_content_extract_publications_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_extract_targets workspace_content_extract_targets_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_targets
    ADD CONSTRAINT workspace_content_extract_targets_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_extract_targets workspace_content_extract_targets_source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_targets
    ADD CONSTRAINT workspace_content_extract_targets_source_workspace_id_fkey FOREIGN KEY (source_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_extract_targets workspace_content_extract_targets_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_extract_targets
    ADD CONSTRAINT workspace_content_extract_targets_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_link_publications workspace_content_link_publications_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_link_publications
    ADD CONSTRAINT workspace_content_link_publications_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_link_publications workspace_content_link_publications_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_link_publications
    ADD CONSTRAINT workspace_content_link_publications_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_move_publications workspace_content_move_publications_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_move_publications
    ADD CONSTRAINT workspace_content_move_publications_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_move_publications workspace_content_move_publications_source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_move_publications
    ADD CONSTRAINT workspace_content_move_publications_source_workspace_id_fkey FOREIGN KEY (source_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_move_publications workspace_content_move_publications_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_move_publications
    ADD CONSTRAINT workspace_content_move_publications_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_move_revision_manifests workspace_content_move_revision_manifests_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_move_revision_manifests
    ADD CONSTRAINT workspace_content_move_revision_manifests_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_compensations workspace_content_operation_compensati_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_compensations
    ADD CONSTRAINT workspace_content_operation_compensati_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_compensations workspace_content_operation_compensations_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_compensations
    ADD CONSTRAINT workspace_content_operation_compensations_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_link_intents workspace_content_operation_link_inten_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_link_intents
    ADD CONSTRAINT workspace_content_operation_link_inten_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_link_intents workspace_content_operation_link_intents_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_link_intents
    ADD CONSTRAINT workspace_content_operation_link_intents_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_mappings workspace_content_operation_mappings_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_mappings
    ADD CONSTRAINT workspace_content_operation_mappings_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_mappings workspace_content_operation_mappings_source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_mappings
    ADD CONSTRAINT workspace_content_operation_mappings_source_workspace_id_fkey FOREIGN KEY (source_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_mappings workspace_content_operation_mappings_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_mappings
    ADD CONSTRAINT workspace_content_operation_mappings_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_recipient_outbox workspace_content_operation_recipient__source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox
    ADD CONSTRAINT workspace_content_operation_recipient__source_workspace_id_fkey FOREIGN KEY (source_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_recipient_outbox workspace_content_operation_recipient_outbox_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox
    ADD CONSTRAINT workspace_content_operation_recipient_outbox_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_recipient_outbox workspace_content_operation_recipient_outbox_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox
    ADD CONSTRAINT workspace_content_operation_recipient_outbox_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_recipient_outbox workspace_content_operation_recipient_outbox_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_recipient_outbox
    ADD CONSTRAINT workspace_content_operation_recipient_outbox_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_redirects workspace_content_operation_redirects_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_redirects
    ADD CONSTRAINT workspace_content_operation_redirects_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_redirects workspace_content_operation_redirects_source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_redirects
    ADD CONSTRAINT workspace_content_operation_redirects_source_workspace_id_fkey FOREIGN KEY (source_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_redirects workspace_content_operation_redirects_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_redirects
    ADD CONSTRAINT workspace_content_operation_redirects_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_requests workspace_content_operation_requests_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_requests
    ADD CONSTRAINT workspace_content_operation_requests_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_requests workspace_content_operation_requests_origin_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_requests
    ADD CONSTRAINT workspace_content_operation_requests_origin_operation_id_fkey FOREIGN KEY (origin_operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operation_staging workspace_content_operation_staging_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_staging
    ADD CONSTRAINT workspace_content_operation_staging_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.workspace_content_operations(id) ON DELETE CASCADE;


--
-- Name: workspace_content_operation_staging workspace_content_operation_staging_resource_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operation_staging
    ADD CONSTRAINT workspace_content_operation_staging_resource_workspace_id_fkey FOREIGN KEY (resource_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operations workspace_content_operations_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operations
    ADD CONSTRAINT workspace_content_operations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operations workspace_content_operations_source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operations
    ADD CONSTRAINT workspace_content_operations_source_workspace_id_fkey FOREIGN KEY (source_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_content_operations workspace_content_operations_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_content_operations
    ADD CONSTRAINT workspace_content_operations_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;


--
-- Name: workspace_database_cell_values workspace_database_cell_values_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT workspace_database_cell_values_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_cell_values workspace_database_cell_values_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT workspace_database_cell_values_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: workspace_database_cell_values workspace_database_cell_values_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT workspace_database_cell_values_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: workspace_database_cell_values workspace_database_cell_values_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_cell_values
    ADD CONSTRAINT workspace_database_cell_values_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_database_csv_mapping_templates workspace_database_csv_mapping_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_csv_mapping_templates
    ADD CONSTRAINT workspace_database_csv_mapping_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: workspace_database_csv_mapping_templates workspace_database_csv_mapping_templates_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_csv_mapping_templates
    ADD CONSTRAINT workspace_database_csv_mapping_templates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_database_fields workspace_database_fields_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_fields
    ADD CONSTRAINT workspace_database_fields_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_formula_dependencies workspace_database_formula_dependencie_dependency_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_dependencies
    ADD CONSTRAINT workspace_database_formula_dependencie_dependency_field_id_fkey FOREIGN KEY (dependency_field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: workspace_database_formula_dependencies workspace_database_formula_dependencies_formula_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_dependencies
    ADD CONSTRAINT workspace_database_formula_dependencies_formula_field_id_fkey FOREIGN KEY (formula_field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: workspace_database_formula_values workspace_database_formula_values_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_values
    ADD CONSTRAINT workspace_database_formula_values_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_formula_values workspace_database_formula_values_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_values
    ADD CONSTRAINT workspace_database_formula_values_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: workspace_database_formula_values workspace_database_formula_values_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_formula_values
    ADD CONSTRAINT workspace_database_formula_values_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges workspace_database_relation_edges_source_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_edges_source_database_id_fkey FOREIGN KEY (source_database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges workspace_database_relation_edges_source_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_edges_source_field_id_fkey FOREIGN KEY (source_field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges workspace_database_relation_edges_source_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_edges_source_row_id_fkey FOREIGN KEY (source_row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges workspace_database_relation_edges_target_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_edges_target_database_id_fkey FOREIGN KEY (target_database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_relation_edges workspace_database_relation_edges_target_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_relation_edges
    ADD CONSTRAINT workspace_database_relation_edges_target_row_id_fkey FOREIGN KEY (target_row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: workspace_database_rollup_values workspace_database_rollup_values_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rollup_values
    ADD CONSTRAINT workspace_database_rollup_values_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_rollup_values workspace_database_rollup_values_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rollup_values
    ADD CONSTRAINT workspace_database_rollup_values_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.workspace_database_fields(id) ON DELETE CASCADE;


--
-- Name: workspace_database_rollup_values workspace_database_rollup_values_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rollup_values
    ADD CONSTRAINT workspace_database_rollup_values_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: workspace_database_row_search workspace_database_row_search_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_search
    ADD CONSTRAINT workspace_database_row_search_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_row_search workspace_database_row_search_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_search
    ADD CONSTRAINT workspace_database_row_search_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.workspace_database_rows(id) ON DELETE CASCADE;


--
-- Name: workspace_database_row_search workspace_database_row_search_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_search
    ADD CONSTRAINT workspace_database_row_search_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_database_row_templates workspace_database_row_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_templates
    ADD CONSTRAINT workspace_database_row_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_database_row_templates workspace_database_row_templates_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_templates
    ADD CONSTRAINT workspace_database_row_templates_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_row_templates workspace_database_row_templates_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_templates
    ADD CONSTRAINT workspace_database_row_templates_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE CASCADE;


--
-- Name: workspace_database_row_templates workspace_database_row_templates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_templates
    ADD CONSTRAINT workspace_database_row_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_database_row_templates workspace_database_row_templates_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_row_templates
    ADD CONSTRAINT workspace_database_row_templates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_database_rows workspace_database_rows_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rows
    ADD CONSTRAINT workspace_database_rows_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_database_rows workspace_database_rows_created_by_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rows
    ADD CONSTRAINT workspace_database_rows_created_by_job_id_fkey FOREIGN KEY (created_by_job_id) REFERENCES public.database_import_jobs(id) ON DELETE SET NULL;


--
-- Name: workspace_database_rows workspace_database_rows_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rows
    ADD CONSTRAINT workspace_database_rows_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_database_rows workspace_database_rows_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rows
    ADD CONSTRAINT workspace_database_rows_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE SET NULL;


--
-- Name: workspace_database_rows workspace_database_rows_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_rows
    ADD CONSTRAINT workspace_database_rows_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_database_views workspace_database_views_database_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_database_views
    ADD CONSTRAINT workspace_database_views_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.workspace_databases(id) ON DELETE CASCADE;


--
-- Name: workspace_databases workspace_databases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_databases
    ADD CONSTRAINT workspace_databases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_databases workspace_databases_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_databases
    ADD CONSTRAINT workspace_databases_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_databases workspace_databases_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_databases
    ADD CONSTRAINT workspace_databases_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_databases workspace_databases_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_databases
    ADD CONSTRAINT workspace_databases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_doc_view_daily workspace_doc_view_daily_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_doc_view_daily
    ADD CONSTRAINT workspace_doc_view_daily_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_document_audience_default workspace_document_audience_default_audience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_document_audience_default
    ADD CONSTRAINT workspace_document_audience_default_audience_id_fkey FOREIGN KEY (audience_id) REFERENCES public.document_audience_definition(id) ON DELETE RESTRICT;


--
-- Name: workspace_document_audience_default workspace_document_audience_default_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_document_audience_default
    ADD CONSTRAINT workspace_document_audience_default_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_document_metadata_epoch workspace_document_metadata_epoch_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_document_metadata_epoch
    ADD CONSTRAINT workspace_document_metadata_epoch_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_document_metadata_epoch workspace_document_metadata_epoch_workspace_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_document_metadata_epoch
    ADD CONSTRAINT workspace_document_metadata_epoch_workspace_id_fkey1 FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_import_compensations workspace_import_compensations_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_compensations
    ADD CONSTRAINT workspace_import_compensations_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.workspace_imports(id) ON DELETE CASCADE;


--
-- Name: workspace_import_id_mappings workspace_import_id_mappings_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_id_mappings
    ADD CONSTRAINT workspace_import_id_mappings_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.workspace_imports(id) ON DELETE CASCADE;


--
-- Name: workspace_import_parts workspace_import_parts_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_import_parts
    ADD CONSTRAINT workspace_import_parts_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.workspace_imports(id) ON DELETE CASCADE;


--
-- Name: workspace_imports workspace_imports_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_imports workspace_imports_target_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_imports
    ADD CONSTRAINT workspace_imports_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;


--
-- Name: workspace_invite_links workspace_invite_links_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite_links
    ADD CONSTRAINT workspace_invite_links_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: workspace_invite_links workspace_invite_links_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invite_links
    ADD CONSTRAINT workspace_invite_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_member_last_access workspace_member_last_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_member_last_access
    ADD CONSTRAINT workspace_member_last_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_member_last_access workspace_member_last_access_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_member_last_access
    ADD CONSTRAINT workspace_member_last_access_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_memberships workspace_memberships_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id);


--
-- Name: workspace_memberships workspace_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_memberships workspace_memberships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_storage_stats_daily workspace_storage_stats_daily_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_storage_stats_daily
    ADD CONSTRAINT workspace_storage_stats_daily_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_storage_stats workspace_storage_stats_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_storage_stats
    ADD CONSTRAINT workspace_storage_stats_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_tag_document_assignments workspace_tag_document_assignments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_document_assignments
    ADD CONSTRAINT workspace_tag_document_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_tag_document_assignments workspace_tag_document_assignments_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_document_assignments
    ADD CONSTRAINT workspace_tag_document_assignments_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;


--
-- Name: workspace_tag_document_assignments workspace_tag_document_assignments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_document_assignments
    ADD CONSTRAINT workspace_tag_document_assignments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_tag_document_assignments workspace_tag_document_assignments_workspace_id_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_document_assignments
    ADD CONSTRAINT workspace_tag_document_assignments_workspace_id_tag_id_fkey FOREIGN KEY (workspace_id, tag_id) REFERENCES public.workspace_tags(workspace_id, id) ON DELETE RESTRICT;


--
-- Name: workspace_tag_legacy_ids workspace_tag_legacy_ids_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_legacy_ids
    ADD CONSTRAINT workspace_tag_legacy_ids_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.workspace_tags(id) ON DELETE CASCADE;


--
-- Name: workspace_tag_legacy_ids workspace_tag_legacy_ids_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tag_legacy_ids
    ADD CONSTRAINT workspace_tag_legacy_ids_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_tags workspace_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_tags workspace_tags_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_tags workspace_tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_template_instances workspace_template_instances_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_instances
    ADD CONSTRAINT workspace_template_instances_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.template_revisions(id) ON DELETE RESTRICT;


--
-- Name: workspace_template_instances workspace_template_instances_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_instances
    ADD CONSTRAINT workspace_template_instances_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE CASCADE;


--
-- Name: workspace_template_instances workspace_template_instances_workspace_doc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_instances
    ADD CONSTRAINT workspace_template_instances_workspace_doc_id_fkey FOREIGN KEY (workspace_doc_id) REFERENCES public.docs(id) ON DELETE SET NULL;


--
-- Name: workspace_template_instances workspace_template_instances_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_instances
    ADD CONSTRAINT workspace_template_instances_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_template_policies workspace_template_policies_selected_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_policies
    ADD CONSTRAINT workspace_template_policies_selected_revision_id_fkey FOREIGN KEY (selected_revision_id) REFERENCES public.template_revisions(id) ON DELETE SET NULL;


--
-- Name: workspace_template_policies workspace_template_policies_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_policies
    ADD CONSTRAINT workspace_template_policies_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_catalog_entries(id) ON DELETE CASCADE;


--
-- Name: workspace_template_policies workspace_template_policies_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_template_policies
    ADD CONSTRAINT workspace_template_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_created_by_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_user_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspaces workspaces_management_unit_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_management_unit_fk FOREIGN KEY (management_unit_id) REFERENCES public.organization_unit(id) ON DELETE SET NULL;


--
-- Name: workspaces workspaces_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

-- The final pg_dump segment clears search_path. SQLx records the baseline on
-- the same session after executing this file, so restore the canonical path
-- before control returns to the migrator.
SET search_path TO public, pg_catalog;
