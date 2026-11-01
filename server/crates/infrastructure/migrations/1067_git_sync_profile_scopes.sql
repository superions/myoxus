-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Keep every deployed profile at its existing repository-global manifest address.
-- A later Extract publishes a separately derived nested address without rewriting
-- or choosing between pre-existing profiles that share a remote and branch.
ALTER TABLE git_sync_profiles
  ADD COLUMN manifest_path text NOT NULL DEFAULT '.myoxus/git-sync-manifest.json',
  ADD COLUMN scope_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT git_sync_profiles_scope_revision_nonnegative CHECK (scope_revision >= 0);

-- The source profile owns its fence. A destination may disappear without
-- releasing it; operation retention cannot erase its provenance.
CREATE TABLE git_sync_scope_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES git_sync_profiles(id) ON DELETE CASCADE,
  repo_path text NOT NULL,
  is_directory boolean NOT NULL,
  destination_profile_id uuid REFERENCES git_sync_profiles(id) ON DELETE SET NULL,
  originating_operation_id uuid NOT NULL,
  scope_revision bigint NOT NULL CHECK (scope_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT git_sync_scope_exclusions_path_nonempty CHECK (
    repo_path <> '' AND repo_path !~ '^/' AND repo_path !~ '/$'
    AND repo_path !~ '(^|/)[.][.]?(/|$)' AND repo_path !~ '//'
    AND position(chr(92) IN repo_path) = 0
  ),
  CONSTRAINT git_sync_scope_exclusions_unique_path UNIQUE (profile_id, repo_path, is_directory)
);

CREATE INDEX git_sync_scope_exclusions_destination_idx
  ON git_sync_scope_exclusions(destination_profile_id)
  WHERE destination_profile_id IS NOT NULL;
CREATE INDEX git_sync_profiles_remote_scope_idx
  ON git_sync_profiles(repo_url, branch);
