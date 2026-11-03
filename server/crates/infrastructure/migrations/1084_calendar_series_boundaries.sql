-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A split can leave an empty head without invalidating its retained base rule.
ALTER TABLE scheduling_schedules ADD COLUMN ends_before timestamptz;
ALTER TABLE scheduling_schedules ADD CONSTRAINT scheduling_calendar_end CHECK (
  ends_before IS NULL OR (target_json->>'kind') IS NOT DISTINCT FROM 'calendar_master');

-- Cache geometry is not an authored revision or another recurrence definition.
ALTER TABLE calendar_events ADD COLUMN projection_from timestamptz;
ALTER TABLE calendar_events ADD COLUMN projection_to timestamptz;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_projection_window CHECK (
  (projection_from IS NULL AND projection_to IS NULL) OR
  (projection_from IS NOT NULL AND projection_to IS NOT NULL AND projection_to>projection_from
    AND extract(epoch FROM (projection_to-projection_from))<=31622400));
