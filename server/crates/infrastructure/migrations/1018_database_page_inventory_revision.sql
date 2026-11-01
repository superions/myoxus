-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE workspace_database_page_inventory_revision (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION bump_workspace_database_page_inventory_revision(p_workspace_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF p_workspace_id IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = p_workspace_id) THEN
    RETURN;
  END IF;
  INSERT INTO workspace_database_page_inventory_revision (workspace_id, revision, updated_at)
  VALUES (p_workspace_id, 1, now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET revision = workspace_database_page_inventory_revision.revision + 1,
        updated_at = now();
END;
$$;

CREATE FUNCTION database_page_inventory_touch_database() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM bump_workspace_database_page_inventory_revision(NEW.workspace_id);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM bump_workspace_database_page_inventory_revision(OLD.workspace_id);
    RETURN OLD;
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    PERFORM bump_workspace_database_page_inventory_revision(OLD.workspace_id);
  END IF;
  PERFORM bump_workspace_database_page_inventory_revision(NEW.workspace_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_database_page_inventory_membership
AFTER INSERT OR DELETE ON workspace_databases
FOR EACH ROW EXECUTE FUNCTION database_page_inventory_touch_database();

CREATE TRIGGER trg_database_page_inventory_facts
AFTER UPDATE OF workspace_id, title, description, deleted_at, edit_revision, updated_at
ON workspace_databases FOR EACH ROW
WHEN (
  OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR
  OLD.title IS DISTINCT FROM NEW.title OR
  OLD.description IS DISTINCT FROM NEW.description OR
  OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR
  OLD.edit_revision IS DISTINCT FROM NEW.edit_revision OR
  OLD.updated_at IS DISTINCT FROM NEW.updated_at
)
EXECUTE FUNCTION database_page_inventory_touch_database();

CREATE FUNCTION database_page_inventory_touch_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_workspace_id UUID;
  new_workspace_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT workspace_id INTO old_workspace_id FROM workspace_databases WHERE id = OLD.database_id;
    PERFORM bump_workspace_database_page_inventory_revision(old_workspace_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR OLD.database_id IS DISTINCT FROM NEW.database_id) THEN
    SELECT workspace_id INTO new_workspace_id FROM workspace_databases WHERE id = NEW.database_id;
    PERFORM bump_workspace_database_page_inventory_revision(new_workspace_id);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_database_page_inventory_profile_membership
AFTER INSERT OR DELETE ON database_profiles
FOR EACH ROW EXECUTE FUNCTION database_page_inventory_touch_profile();

CREATE TRIGGER trg_database_page_inventory_profile_kind
AFTER UPDATE OF database_id, profile_kind ON database_profiles
FOR EACH ROW
WHEN (
  OLD.database_id IS DISTINCT FROM NEW.database_id OR
  OLD.profile_kind IS DISTINCT FROM NEW.profile_kind
)
EXECUTE FUNCTION database_page_inventory_touch_profile();
