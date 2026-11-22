-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Existing workers replenish only sources with references, in normal bounded
-- catch-up batches. A branch read must never initiate this population.
UPDATE document_graph_index_state SET stale_state = 'stale'
WHERE stale_state = 'current' AND occurrence_count > 0;
