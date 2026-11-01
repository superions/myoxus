-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Provider-neutral, single-row lifecycle for Git-Sync token rotation.

CREATE TABLE git_token_rotation (
  profile_id uuid PRIMARY KEY
    REFERENCES git_sync_profiles(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  renew_before_days integer NOT NULL,
  requested_lifetime_days integer NOT NULL,
  state text NOT NULL DEFAULT 'Configured',
  latest_attempt_id uuid,
  -- Retained as the admission identity after the superseded credential row is
  -- deleted on success; it is evidence for commit-acknowledgement re-reads,
  -- not a second active credential pointer.
  admitted_credential_id uuid,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  diagnosis varchar(256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT git_token_rotation_provider_check
    CHECK (provider IN ('GitLab')),
  CONSTRAINT git_token_rotation_state_check
    CHECK (state IN ('Configured', 'Rotating', 'Completed', 'Failed', 'ManualIntervention')),
  CONSTRAINT git_token_rotation_renew_before_days_check
    CHECK (renew_before_days BETWEEN 1 AND 365),
  CONSTRAINT git_token_rotation_requested_lifetime_days_check
    CHECK (requested_lifetime_days BETWEEN 1 AND 365),
  CONSTRAINT git_token_rotation_attempt_shape_check
    CHECK (
      (state = 'Rotating' AND latest_attempt_id IS NOT NULL
        AND admitted_credential_id IS NOT NULL AND last_attempt_at IS NOT NULL)
      OR state <> 'Rotating'
    )
);

CREATE INDEX git_token_rotation_due_idx
  ON git_token_rotation (enabled, state, updated_at)
  WHERE enabled = true
    AND state IN ('Configured', 'Completed', 'Failed');
