-- Native mutable Row-template content revisions. Existing content is unchanged.
ALTER TABLE workspace_database_row_templates
  ADD COLUMN edit_revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT workspace_database_row_templates_edit_revision_check CHECK (edit_revision >= 1);

-- Personal revisions are opaque positive tokens. A sequence survives Reset's
-- row deletion, so Recreate cannot admit a draft from an earlier incarnation.
-- Preserve positive installed tokens and allocate above their current maximum.
CREATE SEQUENCE database_view_user_state_edit_revision_seq AS BIGINT MINVALUE 1 NO CYCLE;
SELECT setval(
  'database_view_user_state_edit_revision_seq',
  GREATEST(COALESCE(MAX(edit_revision), 0), 1),
  COALESCE(MAX(edit_revision), 0) > 0
) FROM database_view_user_states;
ALTER SEQUENCE database_view_user_state_edit_revision_seq
  OWNED BY database_view_user_states.edit_revision;
ALTER TABLE database_view_user_states
  ALTER COLUMN edit_revision SET DEFAULT nextval('database_view_user_state_edit_revision_seq');
-- Zero remains exclusively the absent-state sentinel; content is unchanged.
UPDATE database_view_user_states
SET edit_revision = nextval('database_view_user_state_edit_revision_seq')
WHERE edit_revision = 0;
ALTER TABLE database_view_user_states
  DROP CONSTRAINT database_view_user_states_revision_non_negative,
  ADD CONSTRAINT database_view_user_states_revision_positive CHECK (edit_revision > 0);
