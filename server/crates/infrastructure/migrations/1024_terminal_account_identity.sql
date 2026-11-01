-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A deleted account retains only attribution identity. Historical FKs remain
-- valid, but credentials, grants and private state may not reference it anew.
ALTER TABLE users ADD CONSTRAINT users_deleted_account_shape CHECK (
  status <> 'deleted' OR (
    email = 'deleted:' || id::text AND password_hash IS NULL
    AND avatar_key IS NULL AND email_verified_at IS NULL AND NOT is_admin
  )
);

CREATE FUNCTION users_preserve_deleted_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'deleted' AND (
    ROW(NEW.id, NEW.name, NEW.status, NEW.email, NEW.password_hash,
        NEW.avatar_key, NEW.email_verified_at, NEW.is_admin, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.name, OLD.status, OLD.email, OLD.password_hash,
        OLD.avatar_key, OLD.email_verified_at, OLD.is_admin, OLD.created_at)
  ) THEN
    RAISE EXCEPTION 'account is no longer operational'
      USING ERRCODE = '23514', CONSTRAINT = 'account_reference_not_operational';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_preserve_deleted_identity BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION users_preserve_deleted_identity();

-- SHARE conflicts with the deletion's UPDATE lock, unlike KEY SHARE. Check
-- again after acquiring it: a writer waiting for deletion must reject the
-- committed terminal row. Multiple references are locked in UUID order.
CREATE FUNCTION guard_operational_account_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  column_name text;
  account_ids uuid[] := ARRAY[]::uuid[];
  account_id uuid;
  account_status text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF TG_OP = 'INSERT' THEN
      account_ids := array_append(account_ids, (to_jsonb(NEW)->>column_name)::uuid);
    ELSIF (to_jsonb(NEW)->column_name) IS DISTINCT FROM (to_jsonb(OLD)->column_name) THEN
      account_ids := array_append(account_ids, (to_jsonb(NEW)->>column_name)::uuid);
    END IF;
  END LOOP;
  FOR account_id IN SELECT DISTINCT id FROM unnest(account_ids) AS ids(id)
                    WHERE id IS NOT NULL ORDER BY id LOOP
    SELECT status INTO account_status FROM public.users WHERE id = account_id FOR SHARE;
    IF NOT FOUND OR account_status = 'deleted' THEN
      RAISE EXCEPTION 'account is no longer operational'
        USING ERRCODE = '23514', CONSTRAINT = 'account_reference_not_operational';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Explicit allowlist: never guard historical author/creator/actor columns.
DO $$
DECLARE owner record;
BEGIN
  FOR owner IN SELECT * FROM (VALUES
    ('sessions', 'user_id'),
    ('session_links', 'user_id'),
    ('access_tokens', 'user_id'),
    ('api_keys', 'user_id'),
    ('verification_tokens', 'user_id'),
    ('connected_accounts', 'user_id'),
    ('mcp_idempotency_keys', 'user_id'),
    ('user_features', 'user_id'),
    ('user_preferences', 'user_id'),
    ('workspace_memberships', 'user_id'),
    ('organization_unit_member', 'user_id'),
    ('doc_user_permissions', 'user_id'),
    ('comment_thread_read_state', 'user_id'),
    ('database_row_reminders', 'user_id'),
    ('database_view_user_states', 'user_id'),
    ('notifications', 'user_id'),
    ('workspace_member_last_access', 'user_id'),
    ('workspace_content_operation_recipient_outbox', 'recipient_id'),
    ('document_history_capture_request', 'actor_id'),
    ('calendar_accounts', 'user_id'),
    ('copilot_contexts', 'user_id'),
    ('copilot_jobs', 'user_id'),
    ('copilot_sessions', 'user_id'),
    ('git_sync_profiles', 'owner_id'),
    ('telemetry_events', 'user_id'),
    ('workspace_imports', 'actor_id'),
    ('workspaces', 'owner_user_id'),
    ('docs', 'userspace_owner_id'),
    ('docs', 'responsible_user_id'),
    ('document_workspace_settings', 'default_responsible_user_id'),
    ('organization_document_settings', 'default_responsible_user_id')
  ) AS owners(table_name, column_name) LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW EXECUTE FUNCTION guard_operational_account_reference(%L)',
      'guard_account_' || owner.column_name, owner.column_name,
      owner.table_name, owner.column_name
    );
  END LOOP;
END $$;
