-- Overview pages bind existing content; they do not store another folder tree.
ALTER TABLE workspaces
  ADD COLUMN overview_settings JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(overview_settings) = 'object'),
  ADD COLUMN overview_revision BIGINT NOT NULL DEFAULT 0
    CHECK (overview_revision >= 0);
