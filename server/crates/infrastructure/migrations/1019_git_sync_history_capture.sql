-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE git_sync_profiles
  ADD COLUMN activation_generation bigint NOT NULL DEFAULT 1;

ALTER TABLE git_sync_profiles DROP CONSTRAINT IF EXISTS git_sync_profiles_trigger_mode_check;
ALTER TABLE git_sync_profiles
  ADD CONSTRAINT git_sync_profiles_trigger_mode_check
    CHECK (trigger_mode IN ('Manual', 'Polling', 'Webhook', 'Cron', 'HistoryCapture')),
  ADD CONSTRAINT git_sync_profiles_history_capture_direction_check
    CHECK (trigger_mode <> 'HistoryCapture' OR sync_direction IN ('MyoxusToGit', 'Bidirectional'));

ALTER TABLE git_sync_runs DROP CONSTRAINT git_sync_runs_trigger_source_check;
ALTER TABLE git_sync_runs
  ADD CONSTRAINT git_sync_runs_trigger_source_check
    CHECK (trigger_source IN ('Manual', 'Polling', 'Webhook', 'Cron', 'HistoryCapture'));

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events
  ADD CONSTRAINT chk_outbox_events_event_type
    CHECK (event_type IN (
      'mention', 'invite', 'comment_reply', 'access_change', 'doc_updated',
      'workspace_doc_broadcast', 'workspace_content_published', 'history_captured'
    ));

CREATE TABLE git_sync_history_capture_receipts (
  profile_id uuid NOT NULL REFERENCES git_sync_profiles(id) ON DELETE CASCADE,
  history_id bigint NOT NULL REFERENCES doc_histories(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  activation_generation bigint NOT NULL,
  assigned_run_id uuid,
  assigned_at timestamptz,
  discarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, history_id),
  CONSTRAINT git_sync_history_capture_receipts_assignment_check CHECK (
    (assigned_run_id IS NULL AND assigned_at IS NULL) OR
    (assigned_run_id IS NOT NULL AND assigned_at IS NOT NULL)
  )
);

CREATE INDEX git_sync_history_capture_pending_idx
  ON git_sync_history_capture_receipts (profile_id, created_at, history_id)
  WHERE assigned_run_id IS NULL AND discarded_at IS NULL;
