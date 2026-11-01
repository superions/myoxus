-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Last authenticated complete inventory permits SQL-first publication during
-- a remote outage; metadata completion must still revalidate actual Git bytes.
ALTER TABLE git_sync_profiles ADD COLUMN extract_verified_capture jsonb;
