-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A second disabled profile must not bypass the pending ownership contract by
-- creating a new enabled profile for either Workspace.
CREATE FUNCTION guard_extract_git_profile_creation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM workspaces WHERE id=NEW.workspace_id FOR KEY SHARE;
  IF EXISTS(SELECT 1 FROM workspace_content_extract_targets e
    WHERE e.git_sync_pending AND (e.source_workspace_id=NEW.workspace_id OR e.target_workspace_id=NEW.workspace_id)) THEN
    RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_extract_git_profile_creation
  BEFORE INSERT ON git_sync_profiles
  FOR EACH ROW EXECUTE FUNCTION guard_extract_git_profile_creation();
