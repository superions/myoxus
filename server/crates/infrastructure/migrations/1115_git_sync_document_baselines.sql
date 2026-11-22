-- SPDX-License-Identifier: AGPL-3.0-or-later

LOCK TABLE git_sync_bindings, git_sync_baselines IN ACCESS EXCLUSIVE MODE;

ALTER TABLE git_sync_bindings
    ADD COLUMN baseline_content_hash text,
    ADD COLUMN baseline_commit_oid text,
    ADD COLUMN baseline_myoxus_updated_at timestamptz,
    ADD COLUMN baseline_captured_at timestamptz,
    ADD CONSTRAINT git_sync_complete_baseline CHECK (
        num_nonnulls(baseline_content_hash, baseline_commit_oid,
                     baseline_myoxus_updated_at, baseline_captured_at) IN (0, 4)
    );

UPDATE git_sync_bindings b
SET baseline_content_hash = s.content_hash, baseline_commit_oid = s.commit_oid,
    baseline_myoxus_updated_at = s.myoxus_updated_at, baseline_captured_at = s.captured_at
FROM git_sync_baselines s WHERE s.binding_id = b.id;

DROP TABLE git_sync_baselines;
