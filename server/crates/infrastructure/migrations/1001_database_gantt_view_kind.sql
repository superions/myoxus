-- SPDX-License-Identifier: AGPL-3.0-or-later

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM workspace_database_views
     WHERE view_kind NOT IN (
       'table', 'kanban', 'list', 'gallery', 'calendar', 'timeline', 'progress', 'gantt'
     )
  ) THEN
    RAISE EXCEPTION 'workspace_database_views contains an unsupported view_kind';
  END IF;
END $$;

ALTER TABLE workspace_database_views
  DROP CONSTRAINT workspace_database_views_view_kind_check;

ALTER TABLE workspace_database_views
  ADD CONSTRAINT workspace_database_views_view_kind_check
  CHECK (
    view_kind IN (
      'table', 'kanban', 'list', 'gallery', 'calendar', 'timeline', 'progress', 'gantt'
    )
  );
