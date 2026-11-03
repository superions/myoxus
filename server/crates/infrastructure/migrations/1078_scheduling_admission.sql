-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Timing is authoritative here; native recipes and execution receipts retain
-- their existing owners. Nominal Due and the next admission time are distinct.
CREATE TABLE scheduling_schedules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  admission_zone text NOT NULL CHECK(length(admission_zone) BETWEEN 1 AND 128),
  target_json jsonb NOT NULL CHECK (jsonb_typeof(target_json)='object'
    AND (target_json->>'kind') IS NOT DISTINCT FROM 'recurring_task' AND octet_length(target_json::text)<=8192),
  rule_json jsonb CHECK (rule_json IS NULL OR (jsonb_typeof(rule_json)='object' AND octet_length(rule_json::text)<=32768)),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','paused','ended')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation>0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  next_nominal jsonb,
  next_due_at timestamptz,
  next_admission_at timestamptz,
  blocked_reason text CHECK (blocked_reason IS NULL OR length(blocked_reason)<=128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduling_cursor_shape CHECK (
    (next_nominal IS NULL AND next_due_at IS NULL AND next_admission_at IS NULL)
    OR (next_nominal IS NOT NULL AND jsonb_typeof(next_nominal)='object'
      AND next_due_at IS NOT NULL AND next_admission_at IS NOT NULL)),
  CHECK(rule_json IS NULL OR rule_json->>'zone'=admission_zone)
);
CREATE INDEX scheduling_due ON scheduling_schedules(next_admission_at,id)
  WHERE lifecycle='active' AND next_admission_at IS NOT NULL;

CREATE TABLE scheduling_occurrences (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES scheduling_schedules(id) ON DELETE CASCADE,
  nominal_json jsonb NOT NULL CHECK (jsonb_typeof(nominal_json)='object'),
  nominal_due_at timestamptz NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  dispatch_id uuid NOT NULL UNIQUE,
  run_id uuid REFERENCES workspace_automation_runs(id) ON DELETE SET NULL,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schedule_id,nominal_json)
);
-- Dispatch identity survives native Run/history removal; an acknowledged slot
-- is never interpreted as permission to create a replacement member.
ALTER TABLE workspace_automation_runs
  ADD COLUMN scheduling_occurrence_id uuid REFERENCES scheduling_occurrences(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX workspace_automation_scheduling_occurrence
  ON workspace_automation_runs(scheduling_occurrence_id) WHERE scheduling_occurrence_id IS NOT NULL;

ALTER TABLE workspace_automation_runs DROP CONSTRAINT workspace_automation_runs_origin_shape;
ALTER TABLE workspace_automation_runs ADD CONSTRAINT workspace_automation_runs_origin_shape CHECK (
  (origin_kind='rule' AND automation_id IS NOT NULL AND trigger_type IS NOT NULL
    AND trigger_event_json IS NOT NULL AND confirmed_actor_id IS NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='confirmed_context_documents' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='prepare_documents'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='document_review' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL
    AND review_actor_id IS NOT NULL AND review_request_id IS NOT NULL
    AND review_task_id IS NOT NULL AND review_follow_up_id IS NOT NULL
    AND review_wait_id IS NOT NULL AND length(review_wait_id)>0
    AND review_deadline_at IS NOT NULL AND accepted_json IS NOT NULL AND task_handover_state IS NULL)
  OR (origin_kind='task_handover' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='task_handover'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL
    AND review_actor_id IS NULL AND task_handover_state IS NOT NULL)
  OR (origin_kind='task_maintenance' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='task_maintenance'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL
    AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='workspace_setup' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NOT NULL AND confirmed_operation='create_workspace'
    AND confirmed_request_id IS NOT NULL AND accepted_json IS NOT NULL
    AND review_actor_id IS NULL AND task_handover_state IS NULL)
  OR (origin_kind='recurring_task' AND automation_id IS NULL AND trigger_type IS NULL
    AND trigger_event_json IS NULL AND confirmed_actor_id IS NOT NULL
    AND confirmed_operation IS NULL AND confirmed_request_id IS NULL
    AND review_actor_id IS NULL AND task_handover_state IS NULL AND accepted_json IS NOT NULL)
);
ALTER TABLE workspace_automation_runs ADD CONSTRAINT workspace_automation_scheduling_origin CHECK (
  (origin_kind='recurring_task' AND scheduling_occurrence_id IS NOT NULL AND accepted_json->'recurringTask' IS NOT NULL)
  OR (origin_kind<>'recurring_task' AND scheduling_occurrence_id IS NULL)
);
