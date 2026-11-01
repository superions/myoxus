-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Disconnect never grants a Git write. An operator may explicitly permit a
-- later outbound source sync without releasing its immutable detached fence.
CREATE OR REPLACE FUNCTION guard_extract_git_profile_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE move_pending boolean;
BEGIN
  IF EXISTS(SELECT 1 FROM workspace_content_extract_targets e
    WHERE e.git_sync_pending AND (e.target_workspace_id=OLD.workspace_id OR e.git_sync_plan->>'sourceProfileId'=OLD.id::text)) THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE='23514';
    END IF;
    IF ROW(NEW.workspace_id,NEW.owner_id,NEW.repo_url,NEW.branch,NEW.root_path,NEW.manifest_path,NEW.scope_revision)
       IS DISTINCT FROM ROW(OLD.workspace_id,OLD.owner_id,OLD.repo_url,OLD.branch,OLD.root_path,OLD.manifest_path,OLD.scope_revision) THEN
      RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE='23514';
    END IF;
    SELECT EXISTS(SELECT 1 FROM workspace_content_extract_targets e WHERE e.git_sync_pending
      AND (e.target_workspace_id=OLD.workspace_id OR e.git_sync_plan->>'sourceProfileId'=OLD.id::text)
      AND e.git_sync_plan->>'choice'<>'disconnect') INTO move_pending;
    IF move_pending AND ROW(NEW.sync_direction,NEW.trigger_mode,NEW.polling_interval_secs,NEW.cron_expression,
      NEW.cron_timezone,NEW.cron_misfire_policy,NEW.enabled) IS DISTINCT FROM
      ROW(OLD.sync_direction,OLD.trigger_mode,OLD.polling_interval_secs,OLD.cron_expression,
      OLD.cron_timezone,OLD.cron_misfire_policy,OLD.enabled) THEN
      RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE='23514';
    END IF;
    IF NOT move_pending AND ROW(NEW.sync_direction,NEW.trigger_mode,NEW.polling_interval_secs,NEW.cron_expression,
      NEW.cron_timezone,NEW.cron_misfire_policy,NEW.enabled) IS DISTINCT FROM
      ROW(OLD.sync_direction,OLD.trigger_mode,OLD.polling_interval_secs,OLD.cron_expression,
      OLD.cron_timezone,OLD.cron_misfire_policy,OLD.enabled) THEN
      IF NOT pg_try_advisory_xact_lock(hashtextextended(
        'git-sync-repository-branch/' || octet_length(OLD.repo_url)::text || '/' || OLD.repo_url || OLD.branch,0)) THEN
        RAISE EXCEPTION 'XWS_GIT_SYNC_HANDOFF_UNAVAILABLE' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
