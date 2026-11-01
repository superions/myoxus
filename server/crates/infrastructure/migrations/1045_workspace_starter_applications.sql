-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE workspaces ADD COLUMN initial_content_policy text NOT NULL DEFAULT 'legacy_defaults'
  CHECK (initial_content_policy IN ('legacy_defaults', 'empty'));

CREATE FUNCTION myoxus_workspace_initial_content_policy_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.initial_content_policy IS DISTINCT FROM OLD.initial_content_policy THEN
    RAISE EXCEPTION 'workspace initial content policy is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_initial_content_policy_immutable
BEFORE UPDATE OF initial_content_policy ON workspaces FOR EACH ROW
EXECUTE FUNCTION myoxus_workspace_initial_content_policy_immutable();

-- Result identities deliberately do not reference the deletable Workspace.
-- Operational account deletion explicitly removes its private creation receipts.
CREATE TABLE workspace_starter_applications (
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL DEFAULT 'create_workspace' CHECK (operation='create_workspace'),
  request_id uuid NOT NULL CHECK (request_id <> '00000000-0000-0000-0000-000000000000'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  package_id text NOT NULL CHECK (length(package_id) BETWEEN 1 AND 128),
  package_version text NOT NULL CHECK (length(package_version) BETWEEN 1 AND 128),
  package_digest text NOT NULL CHECK (package_digest ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  initial_content text NOT NULL DEFAULT 'empty' CHECK (initial_content='empty'),
  assistance_mode text NOT NULL CHECK (assistance_mode IN ('manual','guided','automatic')),
  assistance_saved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, request_id)
);
