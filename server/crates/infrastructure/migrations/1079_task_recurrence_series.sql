-- SPDX-License-Identifier: AGPL-3.0-or-later
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_workspace_identity UNIQUE(id,workspace_id);
CREATE TABLE task_recurrence_series (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipe_json jsonb NOT NULL CHECK(jsonb_typeof(recipe_json)='object' AND octet_length(recipe_json::text)<=1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(id,workspace_id) REFERENCES scheduling_schedules(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX task_recurrence_series_workspace ON task_recurrence_series(workspace_id,id);

CREATE TABLE task_recurrence_members (
  occurrence_id uuid PRIMARY KEY REFERENCES scheduling_occurrences(id) ON DELETE CASCADE,
  series_id uuid NOT NULL REFERENCES task_recurrence_series(id) ON DELETE CASCADE,
  -- Native identities remain receipts after a member or its container is deleted.
  -- Current access/location is always resolved through the live Row, not here.
  row_id uuid NOT NULL,
  database_id uuid NOT NULL,
  adopted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(series_id,row_id)
);
CREATE INDEX task_recurrence_members_row ON task_recurrence_members(row_id,series_id);
