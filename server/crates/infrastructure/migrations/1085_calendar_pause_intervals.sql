-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Only completed intentional pauses are closed windows; scheduling_schedules
-- retains the currently open pause through its existing paused_at contract.
CREATE TABLE scheduling_pause_intervals (
  schedule_id uuid NOT NULL REFERENCES scheduling_schedules(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  PRIMARY KEY(schedule_id, starts_at)
);
ALTER TABLE calendar_reminders ADD COLUMN suppressed boolean NOT NULL DEFAULT false;
