-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Queue recovery visits only expired active work, not every retained source body.
CREATE INDEX copilot_context_ingestion_due_idx
ON copilot_context_items ((COALESCE((metadata->>'leaseUntil')::bigint, 0)), created_at)
WHERE item_type IN ('file', 'blob')
  AND metadata->>'ingestStatus' IN ('queued', 'running');
