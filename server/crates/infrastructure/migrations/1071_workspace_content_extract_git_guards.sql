-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Pending metadata protects its ownership contract, not source sync or repair
-- of the current credential pointer. Target sync is paused independently.
CREATE FUNCTION guard_extract_git_profile_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace_content_extract_targets e
    WHERE e.git_sync_pending AND (
      e.target_workspace_id = OLD.workspace_id
      OR e.git_sync_plan->>'sourceProfileId' = OLD.id::text
    )
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.workspace_id, NEW.owner_id, NEW.repo_url, NEW.branch, NEW.root_path,
           NEW.manifest_path, NEW.scope_revision, NEW.sync_direction, NEW.trigger_mode,
           NEW.polling_interval_secs, NEW.cron_expression, NEW.cron_timezone,
           NEW.cron_misfire_policy, NEW.enabled)
       IS DISTINCT FROM
       ROW(OLD.workspace_id, OLD.owner_id, OLD.repo_url, OLD.branch, OLD.root_path,
           OLD.manifest_path, OLD.scope_revision, OLD.sync_direction, OLD.trigger_mode,
           OLD.polling_interval_secs, OLD.cron_expression, OLD.cron_timezone,
           OLD.cron_misfire_policy, OLD.enabled) THEN
      RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER guard_extract_git_profile_mutation
  BEFORE UPDATE OR DELETE ON git_sync_profiles
  FOR EACH ROW EXECUTE FUNCTION guard_extract_git_profile_mutation();

CREATE FUNCTION guard_extract_git_target_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('Pending', 'Running') AND EXISTS (
    SELECT 1 FROM workspace_content_extract_targets e
    JOIN git_sync_profiles p ON p.workspace_id = e.target_workspace_id
    WHERE p.id = NEW.profile_id AND e.git_sync_pending
  ) THEN
    RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_extract_git_target_run
  BEFORE INSERT OR UPDATE OF status ON git_sync_runs
  FOR EACH ROW EXECUTE FUNCTION guard_extract_git_target_run();
