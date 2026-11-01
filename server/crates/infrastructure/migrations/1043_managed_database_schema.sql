-- Managed definitions are server-authored. User data is never adopted or reseeded.
ALTER TABLE workspace_databases
  ADD COLUMN system_role text CHECK (system_role IS NULL OR system_role = 'workspace_tasks'),
  ADD COLUMN managed_installation jsonb;
CREATE UNIQUE INDEX workspace_databases_one_workspace_tasks
  ON workspace_databases(workspace_id) WHERE system_role = 'workspace_tasks';
ALTER TABLE workspace_databases ADD CONSTRAINT managed_installation_object
  CHECK (managed_installation IS NULL OR jsonb_typeof(managed_installation) = 'object');

CREATE FUNCTION myoxus_database_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE db_id uuid; root workspace_databases; managed boolean;
BEGIN
  IF current_setting('myoxus.managed_schema_write', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME = 'workspace_databases' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.system_role IS NOT NULL OR NEW.managed_installation IS NOT NULL THEN
        RAISE EXCEPTION 'managed database metadata is server-owned' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    -- Workspace deletion owns the complete aggregate and remains permitted.
    IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
    IF TG_OP='DELETE' AND (OLD.managed_installation IS NOT NULL OR EXISTS(
      SELECT 1 FROM database_profiles WHERE database_id=OLD.id AND profile_kind='project'))
      AND NOT myoxus_database_source_admitted(OLD.managed_installation) THEN
      RAISE EXCEPTION 'managed database lifecycle is unavailable' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' AND OLD.system_role IS NOT NULL THEN
      RAISE EXCEPTION 'workspace tasks container is protected' USING ERRCODE='23514';
    ELSIF TG_OP='UPDATE' THEN
      IF NEW.system_role IS DISTINCT FROM OLD.system_role
        OR NEW.managed_installation IS DISTINCT FROM OLD.managed_installation THEN
        RAISE EXCEPTION 'managed database metadata is server-owned' USING ERRCODE='23514';
      END IF;
      IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
        OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
        AND EXISTS(SELECT 1 FROM database_profiles WHERE database_id=OLD.id AND profile_kind='project')
        AND NOT myoxus_database_source_admitted(OLD.managed_installation) THEN
        RAISE EXCEPTION 'managed database metadata or lifecycle is unavailable' USING ERRCODE='23514';
      END IF;
      IF OLD.system_role IS NOT NULL AND
        (NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description
         OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
        RAISE EXCEPTION 'workspace tasks container is protected' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSE
    IF TG_OP='DELETE' THEN db_id=OLD.database_id; ELSE db_id=NEW.database_id; END IF;
    SELECT * INTO root FROM workspace_databases WHERE id=db_id;
    -- Cascades from an authorized whole-container/workspace removal have no live parent.
    IF FOUND AND EXISTS(SELECT 1 FROM workspaces WHERE id=root.workspace_id)
      AND EXISTS(SELECT 1 FROM database_profiles WHERE database_id=db_id AND profile_kind='project')
      AND NOT (root.system_role IS NULL AND root.deleted_at IS NOT NULL
        AND COALESCE(current_setting('myoxus.database_cleanup_id',true),'')=db_id::text) THEN
      RAISE EXCEPTION 'managed database structure is protected' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='database_profiles' THEN
      IF TG_OP<>'DELETE' AND NEW.profile_kind='project' THEN RAISE EXCEPTION 'managed database installation is server-owned' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER managed_database_root_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_databases
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_definition_guard();
CREATE TRIGGER managed_database_field_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_database_fields
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_definition_guard();
CREATE TRIGGER managed_database_view_guard BEFORE INSERT OR UPDATE OR DELETE ON workspace_database_views
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_definition_guard();
CREATE TRIGGER managed_database_field_role_guard BEFORE INSERT OR UPDATE OR DELETE ON database_field_roles
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_definition_guard();
CREATE TRIGGER managed_database_view_role_guard BEFORE INSERT OR UPDATE OR DELETE ON database_view_roles
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_definition_guard();
CREATE TRIGGER managed_database_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON database_profiles
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_definition_guard();

-- Transaction-local current catalog pins are shared by reads and writes. A
-- persisted Ready flag alone never grants a node an unknown version.
CREATE FUNCTION myoxus_database_source_admitted(installed jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(installed->>'readiness'='ready' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(current_setting('myoxus.admitted_database_sources',true),''),'[]')::jsonb) source
    WHERE source->>0=installed->>'templateId' AND source->>1=installed->>'templateVersion' AND source->>2=installed->>'templateDigest'
  ),false)
$$;

-- Immutable structure makes this cheap admission check sufficient between startup checks.
CREATE FUNCTION myoxus_database_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; ready boolean; installed jsonb; admitted jsonb;
BEGIN
  IF current_setting('myoxus.managed_schema_write',true)='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Referential cleanup does not interpret a managed schema. Permit only the
  -- exact FK-owned null transition after the referenced object has gone.
  IF pg_trigger_depth()>1 AND TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='workspace_database_rows' THEN
      IF OLD.doc_id IS NOT NULL AND NEW.doc_id IS NULL
        AND (to_jsonb(NEW)-'doc_id'-'updated_at')=(to_jsonb(OLD)-'doc_id'-'updated_at')
        AND NOT EXISTS(SELECT 1 FROM docs WHERE id=OLD.doc_id) THEN RETURN NEW; END IF;
      IF ((OLD.created_by IS NOT NULL AND NEW.created_by IS NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.created_by))
        OR (OLD.updated_by IS NOT NULL AND NEW.updated_by IS NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.updated_by)))
        AND (NEW.created_by IS NOT DISTINCT FROM OLD.created_by OR (NEW.created_by IS NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.created_by)))
        AND (NEW.updated_by IS NOT DISTINCT FROM OLD.updated_by OR (NEW.updated_by IS NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.updated_by)))
        AND (to_jsonb(NEW)-'created_by'-'updated_by'-'updated_at')=(to_jsonb(OLD)-'created_by'-'updated_by'-'updated_at') THEN RETURN NEW; END IF;
    ELSE
      IF OLD.updated_by IS NOT NULL AND NEW.updated_by IS NULL
        AND (to_jsonb(NEW)-'updated_by'-'updated_at')=(to_jsonb(OLD)-'updated_by'-'updated_at')
        AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.updated_by) THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='workspace_database_rows' THEN
    IF TG_OP='UPDATE' AND NEW.database_id IS DISTINCT FROM OLD.database_id AND current_setting('myoxus.task_move',true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'native row owner can change only through Task movement' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN owner_id=OLD.database_id; ELSE owner_id=NEW.database_id; END IF;
  ELSE
    IF TG_OP='DELETE' THEN
      SELECT database_id INTO owner_id FROM workspace_database_rows WHERE id=OLD.row_id;
    ELSE
      SELECT database_id INTO owner_id FROM workspace_database_rows WHERE id=NEW.row_id;
    END IF;
  END IF;
  SELECT d.managed_installation->>'readiness'='ready',d.managed_installation INTO ready,installed
    FROM workspace_databases d JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project'
    WHERE d.id=owner_id;
  IF FOUND THEN
    IF installed IS NULL THEN RAISE EXCEPTION 'managed database schema is not installed' USING ERRCODE='23514'; END IF;
    admitted=COALESCE(NULLIF(current_setting('myoxus.admitted_database_sources',true),''),'[]')::jsonb;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admitted) source
      WHERE source->>0=installed->>'templateId' AND source->>1=installed->>'templateVersion' AND source->>2=installed->>'templateDigest') THEN
      RAISE EXCEPTION 'managed database source unavailable on this node' USING ERRCODE='23514';
    END IF;
  END IF;
  IF ready IS DISTINCT FROM true AND installed IS NOT NULL THEN
    RAISE EXCEPTION 'managed database schema unavailable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER managed_database_row_admission BEFORE INSERT OR UPDATE OR DELETE ON workspace_database_rows
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_content_guard();
CREATE TRIGGER managed_database_cell_admission BEFORE INSERT OR UPDATE OR DELETE ON workspace_database_cell_values
 FOR EACH ROW EXECUTE FUNCTION myoxus_database_content_guard();
