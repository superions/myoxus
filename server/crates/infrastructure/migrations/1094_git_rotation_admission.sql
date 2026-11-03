-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE scheduling_schedules DROP CONSTRAINT scheduling_target_shape;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_target_shape CHECK (
  jsonb_typeof(target_json)='object' AND octet_length(target_json::text)<=8192
  AND COALESCE(target_json->>'kind' IN ('recurring_task','calendar_master','document_review','calendar_reminder','database_reminder','git_cron','git_polling','git_rotation'),false)
  AND (target_json->>'kind' IN ('calendar_master','calendar_reminder') OR workspace_id IS NOT NULL)
  AND (target_json->>'kind'<>'calendar_master' OR
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL))
  AND (target_json->>'kind'<>'document_review' OR
    (rule_json IS NULL AND COALESCE(jsonb_typeof(target_json->'enabled')='boolean',false)
      AND target_json->>'document_id' IS NOT NULL AND target_json->>'confirmed_by' IS NOT NULL))
  AND (target_json->>'kind'<>'calendar_reminder' OR
    (rule_json IS NULL AND target_json->>'definition_id' IS NOT NULL AND target_json->>'event_id' IS NOT NULL))
  AND (target_json->>'kind'<>'database_reminder' OR
    (rule_json IS NULL AND target_json->>'reminder_id' IS NOT NULL))
  AND (target_json->>'kind' NOT IN('git_cron','git_polling') OR
    (rule_json IS NULL AND target_json->>'profile_id' IS NOT NULL
      AND (lifecycle<>'active' OR next_due_at IS NOT NULL)))
  AND (target_json->>'kind'<>'git_rotation' OR
    (rule_json IS NULL AND COALESCE(target_json->>'credential_id'=id::text,false)
      AND target_json->>'source_fingerprint' IS NOT NULL
      AND (lifecycle<>'active' OR next_due_at IS NOT NULL))));

-- Only identifiers, expiry/configuration and scrubbed native lifecycle facts
-- enter timing. Never select plaintext/ciphertext, labels or repository URLs.
CREATE FUNCTION refresh_git_rotation_schedule(source_credential uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source record; due timestamptz; fingerprint text; next_lifecycle text;
BEGIN
  -- Use this same order from fenced native admission: sorted native consumers,
  -- native credential/rotation rows, this key, then the shared schedule. Read
  -- the source AFTER waiting; an old MVCC projection must not restore old rules.
  PERFORM pg_advisory_xact_lock(hashtextextended('git-rotation-schedule:'||source_credential::text,0));
  PERFORM id FROM scheduling_schedules WHERE id=source_credential FOR UPDATE;
  IF EXISTS(SELECT 1 FROM scheduling_schedules WHERE id=source_credential AND target_json->>'kind'<>'git_rotation') THEN
    RAISE EXCEPTION 'Git rotation schedule owner mismatch';
  END IF;
  SELECT c.id,c.expires_at,c.profile_id,p.workspace_id,p.owner_id,p.enabled AS profile_enabled,
    p.auth_method,(p.repo_url ~* '^https://') AS profile_https,
    r.provider,r.enabled,r.renew_before_days,r.requested_lifetime_days,r.state,r.last_attempt_at,r.latest_attempt_id
  INTO source FROM git_sync_credentials c JOIN git_sync_profiles p ON p.id=c.profile_id AND p.credential_id=c.id
    JOIN git_token_rotation r ON r.profile_id=p.id WHERE c.id=source_credential;
  IF NOT FOUND THEN
    UPDATE scheduling_schedules SET lifecycle='ended',generation=generation+1,revision=revision+1,
      next_nominal=NULL,next_due_at=NULL,next_admission_at=NULL,blocked_reason=NULL,updated_at=clock_timestamp()
    WHERE id=source_credential AND lifecycle<>'ended';
    RETURN;
  END IF;
  due:=CASE WHEN source.expires_at IS NOT NULL THEN
    source.expires_at-make_interval(secs=>source.renew_before_days::double precision*86400) END;
  IF source.state='Failed' AND source.last_attempt_at IS NOT NULL AND due IS NOT NULL THEN
    due:=GREATEST(due,((source.last_attempt_at AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC');
  END IF;
  next_lifecycle:=CASE WHEN source.enabled AND due IS NOT NULL AND source.state IN('Configured','Completed','Failed')
    AND (source.state<>'Failed' OR source.last_attempt_at IS NOT NULL)
    THEN 'active' ELSE 'ended' END;
  IF next_lifecycle='ended' THEN due:=NULL; END IF;
  fingerprint:=encode(digest(jsonb_build_array(source.id,source.expires_at,source.profile_id,
    source.workspace_id,source.owner_id,source.profile_enabled,source.auth_method,source.profile_https,
    source.provider,source.enabled,source.renew_before_days,source.requested_lifetime_days,
    source.state,source.last_attempt_at,source.latest_attempt_id)::text,'sha256'),'hex');
  INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,lifecycle,
    next_nominal,next_due_at,next_admission_at)
  VALUES(source.id,source.workspace_id,source.owner_id,'UTC',
    jsonb_build_object('kind','git_rotation','credential_id',source.id,'source_fingerprint',fingerprint),next_lifecycle,
    CASE WHEN due IS NOT NULL THEN jsonb_build_object('kind','local_date_time','value',to_char(due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')) END,due,due)
  ON CONFLICT(id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,actor_id=EXCLUDED.actor_id,
    target_json=EXCLUDED.target_json,lifecycle=EXCLUDED.lifecycle,generation=scheduling_schedules.generation+1,
    revision=scheduling_schedules.revision+1,next_nominal=EXCLUDED.next_nominal,next_due_at=EXCLUDED.next_due_at,
    next_admission_at=EXCLUDED.next_admission_at,blocked_reason=NULL,updated_at=clock_timestamp()
  WHERE scheduling_schedules.target_json IS DISTINCT FROM EXCLUDED.target_json
    OR scheduling_schedules.lifecycle IS DISTINCT FROM EXCLUDED.lifecycle;
END $$;

CREATE FUNCTION refresh_git_rotation_from_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT credential_id INTO source FROM git_sync_profiles WHERE id=OLD.profile_id;
    IF source IS NOT NULL THEN PERFORM refresh_git_rotation_schedule(source); END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    SELECT credential_id INTO source FROM git_sync_profiles WHERE id=NEW.profile_id;
    IF source IS NOT NULL THEN PERFORM refresh_git_rotation_schedule(source); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER git_rotation_state_schedule AFTER INSERT OR DELETE OR UPDATE OF
  profile_id,provider,enabled,renew_before_days,requested_lifetime_days,state,last_attempt_at,latest_attempt_id
  ON git_token_rotation FOR EACH ROW EXECUTE FUNCTION refresh_git_rotation_from_rotation();

CREATE FUNCTION refresh_git_rotation_from_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN PERFORM refresh_git_rotation_schedule(OLD.id);
  ELSE PERFORM refresh_git_rotation_schedule(NEW.id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER git_rotation_credential_schedule AFTER INSERT OR DELETE OR UPDATE OF profile_id,expires_at,auth_method
  ON git_sync_credentials FOR EACH ROW EXECUTE FUNCTION refresh_git_rotation_from_credential();

CREATE FUNCTION refresh_git_rotation_from_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.credential_id IS NOT NULL THEN PERFORM refresh_git_rotation_schedule(NEW.credential_id); END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.credential_id IS NOT NULL THEN PERFORM refresh_git_rotation_schedule(OLD.credential_id); END IF;
  ELSE
    IF OLD.credential_id IS NOT NULL THEN PERFORM refresh_git_rotation_schedule(OLD.credential_id); END IF;
    IF NEW.credential_id IS NOT NULL AND NEW.credential_id IS DISTINCT FROM OLD.credential_id THEN
      PERFORM refresh_git_rotation_schedule(NEW.credential_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER git_rotation_profile_schedule AFTER INSERT OR DELETE OR UPDATE OF
  credential_id,workspace_id,owner_id,enabled,auth_method,repo_url ON git_sync_profiles
  FOR EACH ROW EXECUTE FUNCTION refresh_git_rotation_from_profile();

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM git_token_rotation r JOIN git_sync_profiles p ON p.id=r.profile_id
    WHERE r.state='Rotating' AND (r.latest_attempt_id IS NULL OR r.last_attempt_at IS NULL
      OR r.admitted_credential_id IS NULL OR p.credential_id IS DISTINCT FROM r.admitted_credential_id)) THEN
    RAISE EXCEPTION 'Native rotating attempt identity is inconsistent; operator resolution required';
  END IF;
END $$;

DO $$ DECLARE source uuid; BEGIN
  FOR source IN SELECT c.id FROM git_sync_credentials c JOIN git_token_rotation r ON r.profile_id=c.profile_id ORDER BY c.id LOOP
    PERFORM refresh_git_rotation_schedule(source);
  END LOOP;
END $$;

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK(event_type IN (
  'mention','invite','comment_reply','access_change','doc_updated','workspace_doc_broadcast',
  'workspace_content_published','history_captured','calendar_mail','calendar_reminder_due',
  'database_reminder_due','git_cron_due','git_polling_due','git_rotation_due','database_task_notification',
  'workspace_automation_trigger','workspace_automation_signal','task_recurrence_due'));
-- A rotating attempt is a native immutable dispatch, not permission to retry
-- the remote provider. Existing queue attempts/active leases remain unchanged.
INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id)
SELECT r.latest_attempt_id,c.id,
  jsonb_build_object('kind','local_date_time','value',to_char(r.last_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')),
  r.last_attempt_at,s.generation,r.latest_attempt_id
FROM git_token_rotation r JOIN git_sync_profiles p ON p.id=r.profile_id
JOIN git_sync_credentials c ON c.id=p.credential_id AND c.profile_id=r.profile_id
JOIN scheduling_schedules s ON s.id=c.id
WHERE r.state='Rotating' AND r.latest_attempt_id IS NOT NULL AND r.last_attempt_at IS NOT NULL;
INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
SELECT r.latest_attempt_id,'git_rotation',c.id::text,'git_rotation_due',jsonb_build_object(
  'scheduleId',c.id,'generation',s.generation,'profileId',r.profile_id,'attemptId',r.latest_attempt_id)
FROM git_token_rotation r JOIN git_sync_profiles p ON p.id=r.profile_id
JOIN git_sync_credentials c ON c.id=p.credential_id AND c.profile_id=r.profile_id
JOIN scheduling_schedules s ON s.id=c.id
WHERE r.state='Rotating' AND r.latest_attempt_id IS NOT NULL AND r.last_attempt_at IS NOT NULL;
