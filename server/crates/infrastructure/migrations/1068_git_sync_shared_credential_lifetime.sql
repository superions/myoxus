-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The active pointer is the authority for secret lifetime, not the steward FK.
-- Deferred checking permits a profile deletion to remove its own last secret
-- while forbidding a cascade or explicit delete with surviving dependents.
ALTER TABLE git_sync_profiles
  ADD CONSTRAINT git_sync_profiles_active_credential_fkey
  FOREIGN KEY (credential_id) REFERENCES git_sync_credentials(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX git_sync_profiles_active_credential_idx
  ON git_sync_profiles (credential_id) WHERE credential_id IS NOT NULL;
