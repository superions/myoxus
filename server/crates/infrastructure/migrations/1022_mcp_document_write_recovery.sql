-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Existing pending rows have unknown effects and must not be auto-replayed.
ALTER TABLE mcp_idempotency_keys
  ADD COLUMN recovery_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN mutation_committed boolean NOT NULL DEFAULT false,
  ADD COLUMN lease_until timestamptz NOT NULL DEFAULT (now() + interval '60 seconds');
