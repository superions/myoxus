-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Engine schema derives from MIT Sayiir PostgreSQL 1.0.0 migrations 001–009.
-- Myoxus alone applies this schema through its append-only migration ledger.

-- Upstream 001_initial.sql
-- Workflow snapshots: current state of each workflow instance (1:1 with instance).
CREATE TABLE IF NOT EXISTS sayiir_workflow_snapshots (
    instance_id          TEXT        PRIMARY KEY,
    status               TEXT        NOT NULL,
    definition_hash      TEXT,
    current_task_id      TEXT,
    completed_task_count INT         NOT NULL DEFAULT 0,
    data                 BYTEA       NOT NULL,
    error                TEXT,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_status  ON sayiir_workflow_snapshots (status);
CREATE INDEX IF NOT EXISTS idx_snapshots_task    ON sayiir_workflow_snapshots (current_task_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_updated ON sayiir_workflow_snapshots (updated_at);

-- Snapshot history: append-only log of every checkpoint (1:N per instance).
CREATE TABLE IF NOT EXISTS sayiir_workflow_snapshot_history (
    id              BIGSERIAL   PRIMARY KEY,
    instance_id     TEXT        NOT NULL,
    version         INT         NOT NULL,
    status          TEXT        NOT NULL,
    current_task_id TEXT,
    data            BYTEA       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_history_instance ON sayiir_workflow_snapshot_history (instance_id, version);

-- Individual task states for observability (1:N per instance).
CREATE TABLE IF NOT EXISTS sayiir_workflow_tasks (
    instance_id  TEXT        NOT NULL,
    task_id      TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending',
    worker_id    TEXT,
    started_at   TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error        TEXT,
    PRIMARY KEY (instance_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON sayiir_workflow_tasks (status);

-- Cancel/pause signals (at most one per kind per instance).
CREATE TABLE IF NOT EXISTS sayiir_workflow_signals (
    instance_id  TEXT        NOT NULL,
    kind         TEXT        NOT NULL,
    reason       TEXT,
    requested_by TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, kind)
);

-- Distributed worker task claims (one active claim per task).
CREATE TABLE IF NOT EXISTS sayiir_task_claims (
    instance_id TEXT        NOT NULL,
    task_id     TEXT        NOT NULL,
    worker_id   TEXT        NOT NULL,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    PRIMARY KEY (instance_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_expires ON sayiir_task_claims (expires_at);
CREATE INDEX IF NOT EXISTS idx_claims_worker  ON sayiir_task_claims (worker_id);


-- Upstream 002_observability.sql
-- Add position_kind for queryable workflow position without blob deserialization.
ALTER TABLE sayiir_workflow_snapshots ADD COLUMN IF NOT EXISTS position_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_snapshots_position ON sayiir_workflow_snapshots (position_kind);

-- Add delay_wake_at so dashboards can show when parked workflows will resume.
ALTER TABLE sayiir_workflow_snapshots ADD COLUMN IF NOT EXISTS delay_wake_at TIMESTAMPTZ;


-- Upstream 003_workflow_events.sql
-- External events (signals) buffered per (instance_id, signal_name) in FIFO order.
CREATE TABLE IF NOT EXISTS sayiir_workflow_events (
    id           BIGSERIAL   PRIMARY KEY,
    instance_id  TEXT        NOT NULL,
    signal_name  TEXT        NOT NULL,
    payload      BYTEA       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_instance_signal
    ON sayiir_workflow_events (instance_id, signal_name, id);


-- Upstream 004_trace_context.sql
ALTER TABLE sayiir_workflow_snapshots ADD COLUMN IF NOT EXISTS trace_parent TEXT;


-- Upstream 005_history_unique_version.sql
-- Replace the non-unique index with a UNIQUE constraint on (instance_id, version)
-- to guarantee monotonic history even without the row-lock held.
DROP INDEX IF EXISTS idx_history_instance;
CREATE UNIQUE INDEX idx_history_instance ON sayiir_workflow_snapshot_history (instance_id, version);


-- Upstream 006_task_priority.sql
-- Add task priority column to support priority-based task scheduling.
-- Default 3 = Normal priority (1 = Critical, 5 = Minimal).
ALTER TABLE sayiir_workflow_snapshots
ADD COLUMN task_priority SMALLINT NOT NULL DEFAULT 3;


-- Upstream 007_task_tags.sql
-- Add task tags column to support tag-based worker affinity routing.
ALTER TABLE sayiir_workflow_snapshots
ADD COLUMN task_tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_sayiir_task_tags
ON sayiir_workflow_snapshots USING GIN (task_tags);


-- Upstream 008_performance_optim.sql
-- Performance/schema rework consolidated on top of the 0.5.0 release.
--
-- BREAKING: workflows running across this migration must be drained
-- and restarted. Pre-migration history rows have a NULL `data_hash`
-- and cannot be resolved by hash once the KV-offload cutover lands.
--
-- Operators with in-flight task claims should stop workers first.
-- `sayiir_task_claims` is RENAMED in place to `sayiir_workflow_claims`
-- (not dropped) — existing rows, indexes, and statistics carry over.
-- The PK narrows from `(instance_id, task_id)` to `(instance_id)` so
-- any instance with more than one pre-migration claim row (multi-task
-- in-flight workflows from 0.5.x, or unreleased claims from crashed
-- workers) will trip a unique-key violation at `ADD PRIMARY KEY` time
-- and abort the migration mid-run. Truncate or dedupe claims before
-- running this migration if a graceful drain isn't sufficient.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- sayiir_workflow_snapshots ---------------------------------------------------
--   - definition_hash / current_task_id move from hex TEXT to raw
--     BYTEA: half the storage, no per-bind to_hex() allocation.
--   - data drops NOT NULL: history becomes the canonical blob store.
--     New saves stop populating snapshots.data.
--   - history_version: row-local counter, replaces a racy
--     SELECT MAX(version)+1 subquery in save_snapshot.
--   - data_hash: mirrors history.data_hash at history_version so the
--     future KV cutover can resolve the current blob without the
--     history JOIN.
ALTER TABLE sayiir_workflow_snapshots
    ALTER COLUMN definition_hash TYPE BYTEA
        USING CASE WHEN definition_hash IS NULL THEN NULL
                   ELSE decode(definition_hash, 'hex') END,
    ALTER COLUMN current_task_id TYPE BYTEA
        USING CASE WHEN current_task_id IS NULL THEN NULL
                   ELSE digest(current_task_id, 'sha256') END,
    ALTER COLUMN data DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS history_version  INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS data_hash        BYTEA;

UPDATE sayiir_workflow_snapshots s
SET history_version = COALESCE(
    (SELECT MAX(version) FROM sayiir_workflow_snapshot_history h
     WHERE h.instance_id = s.instance_id),
    0
);

-- sayiir_workflow_snapshot_history --------------------------------------------
ALTER TABLE sayiir_workflow_snapshot_history
    ALTER COLUMN current_task_id TYPE BYTEA
        USING CASE WHEN current_task_id IS NULL THEN NULL
                   ELSE digest(current_task_id, 'sha256') END,
    ADD COLUMN IF NOT EXISTS data_hash BYTEA;

-- sayiir_workflow_tasks -------------------------------------------------------
-- output: per-task result, split out of the snapshot blob so late-stage
-- saves stop being quadratic in WAL volume.
ALTER TABLE sayiir_workflow_tasks
    ALTER COLUMN task_id TYPE BYTEA
        USING digest(task_id, 'sha256'),
    ADD COLUMN IF NOT EXISTS output BYTEA;

-- Polling hot-path index. Selectivity-only — the SELECT's ORDER BY is
-- non-indexable. Pre-create with CREATE INDEX CONCURRENTLY on large
-- tables; sqlx migrations run inside a transaction so this build is
-- blocking otherwise.
CREATE INDEX IF NOT EXISTS idx_snapshots_inprogress
    ON sayiir_workflow_snapshots (task_priority, updated_at)
    WHERE status = 'InProgress';

-- Hex-rendering view for ad-hoc ops queries against the now-BYTEA ids.
CREATE OR REPLACE VIEW sayiir_workflow_snapshots_hex AS
SELECT
    instance_id,
    status,
    encode(definition_hash, 'hex')  AS definition_hash,
    encode(current_task_id, 'hex')  AS current_task_id,
    completed_task_count,
    error,
    started_at,
    completed_at,
    updated_at
FROM sayiir_workflow_snapshots;

-- sayiir_task_claims → sayiir_workflow_claims --------------------------------
-- Keep the same physical table (preserve its indexes, statistics, and
-- any rows already drained by an operator stopping workers before the
-- migration); just rename, narrow the PK, and convert task_id to BYTEA.
-- One row per in-flight workflow now (only one task in flight per
-- instance, so the PK is just instance_id). Eligibility is a NOT
-- EXISTS join on this table; it stays small and hot in shared_buffers.
ALTER TABLE sayiir_task_claims RENAME TO sayiir_workflow_claims;
ALTER TABLE sayiir_workflow_claims
    ALTER COLUMN task_id TYPE BYTEA
        USING digest(task_id, 'sha256');
ALTER TABLE sayiir_workflow_claims DROP CONSTRAINT sayiir_task_claims_pkey;
ALTER TABLE sayiir_workflow_claims ADD PRIMARY KEY (instance_id);

COMMENT ON COLUMN sayiir_workflow_snapshots.data_hash IS
    'WIP: SHA-256 of the current snapshot blob. Mirrors history.data_hash at s.history_version.';
COMMENT ON COLUMN sayiir_workflow_snapshot_history.data_hash IS
    'WIP: SHA-256 of the encoded blob. Pre-migration rows are NULL and unsupported by the future KV offload.';


-- Upstream 009_index_cleanup.sql
-- Index cleanup + heap-page tuning. Pure performance migration; no
-- behaviour change. Identified via a static audit of every read path in
-- src/: the dropped indexes are not referenced by any query, and were
-- either superseded by the partial idx_snapshots_inprogress (008) or
-- left over from the 001 schema before the PK on instance_id made
-- single-column secondary indexes redundant.
--
-- Operational note for large existing fleets: the GIN rebuild below
-- holds an AccessExclusiveLock on sayiir_workflow_snapshots while it
-- runs. To avoid blocking writes during the migration window,
-- pre-create the replacement index before deploying:
--
--   CREATE INDEX CONCURRENTLY idx_sayiir_task_tags_new
--       ON sayiir_workflow_snapshots USING GIN (task_tags)
--       WHERE status = 'InProgress';
--   ALTER INDEX idx_sayiir_task_tags RENAME TO idx_sayiir_task_tags_old;
--   ALTER INDEX idx_sayiir_task_tags_new RENAME TO idx_sayiir_task_tags;
--   DROP INDEX idx_sayiir_task_tags_old;
--
-- and the GIN-rebuild block below is then a no-op via IF EXISTS guards.

-- sayiir_workflow_snapshots --------------------------------------------------
-- Every save_snapshot UPDATE writes this row. Each surviving secondary
-- index on it is amortised across all writes to the table.
--   idx_snapshots_status: superseded by partial idx_snapshots_inprogress.
--   idx_snapshots_task:   redundant with the PK; every read-by-task
--                         path already binds instance_id = $1.
--   idx_snapshots_updated: updated_at moves on every save — maximum
--                         write churn for no read benefit (the polling
--                         ORDER BY is a non-SARGable expression).
--   idx_snapshots_position: low cardinality, redundant with the
--                         InProgress-partial pre-filter.
DROP INDEX IF EXISTS idx_snapshots_status;
DROP INDEX IF EXISTS idx_snapshots_task;
DROP INDEX IF EXISTS idx_snapshots_updated;
DROP INDEX IF EXISTS idx_snapshots_position;

-- Make task_tags GIN partial. Terminal rows are never matched by
-- find_available_tasks' tag filter, but the old non-partial GIN
-- indexed them anyway — pure write amplification for the lifetime of
-- the workflow's row.
--
-- This block is idempotent against the pre-deploy recipe in the
-- header: if the existing `idx_sayiir_task_tags` is already partial
-- (any predicate at all — we don't care about the exact predicate
-- formatting, only that it's not the full-table index we want to
-- replace), both arms are skipped and no AccessExclusiveLock is
-- taken. Otherwise we drop the non-partial and build the partial
-- inline, which DOES briefly lock the table.
--
-- Detection uses `pg_index.indpred IS NOT NULL` which is the
-- structural "this index is partial" check, rather than substring
-- matching against `pg_get_indexdef`'s text output — the latter is
-- not contract-stable across PG versions or column types (the
-- predicate can render as `WHERE status = 'InProgress'::text`,
-- `WHERE ((status)::text = 'InProgress'::text)`, etc.), and a miss
-- would silently force the AccessExclusiveLock rebuild the
-- pre-deploy recipe was meant to avoid.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'sayiir_workflow_snapshots'
          AND c.relname = 'idx_sayiir_task_tags'
          AND i.indpred IS NOT NULL
    ) THEN
        -- Already partial; no-op.
        NULL;
    ELSE
        EXECUTE 'DROP INDEX IF EXISTS idx_sayiir_task_tags';
        EXECUTE $ddl$
            CREATE INDEX idx_sayiir_task_tags
                ON sayiir_workflow_snapshots USING GIN (task_tags)
                WHERE status = 'InProgress'
        $ddl$;
    END IF;
END $$;

-- Leave 20% free space on each heap page so future row-version writes
-- have somewhere to land in-page. Reduces page splits on updates that
-- grow the row (e.g. task_tags TEXT[] gaining an entry, error becoming
-- non-NULL on failure). HOT eligibility still requires that no indexed
-- column change; with idx_snapshots_inprogress on (task_priority,
-- updated_at) those updates remain non-HOT — fillfactor here is about
-- reducing split frequency, not enabling HOT outright.
ALTER TABLE sayiir_workflow_snapshots SET (fillfactor = 80);

-- sayiir_workflow_tasks ------------------------------------------------------
-- idx_tasks_status: not referenced by any read path. fetch_task_outputs
-- and friends filter by (instance_id, status='completed'); the PK on
-- (instance_id, task_id) covers the instance_id lookup, and a small
-- post-filter on status is cheaper than maintaining a low-cardinality
-- secondary index on every save_task_result write.
DROP INDEX IF EXISTS idx_tasks_status;

-- sayiir_workflow_claims (formerly sayiir_task_claims) -----------------------
-- The eligibility predicate in find_available_tasks / find_hinted_task is
-- `NOT EXISTS (SELECT 1 FROM claims c WHERE c.instance_id = s.instance_id
--              AND (c.expires_at IS NULL OR c.expires_at > now()))` —
-- always a PK lookup (the PK is on instance_id since migration 008).
-- Neither expires_at nor worker_id is the driver of any query in src/.
-- These rename-survivors from migration 001 are unused.
DROP INDEX IF EXISTS idx_claims_expires;
DROP INDEX IF EXISTS idx_claims_worker;


ALTER TABLE workspace_automation_runs
  ADD COLUMN accepted_json jsonb,
  ADD COLUMN definition_hash text,
  ADD COLUMN execution_generation bigint NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
  ADD COLUMN claim_owner uuid;
ALTER TABLE workspace_automation_actions
  ADD COLUMN node_key text,
  ADD COLUMN effect_key text,
  ADD COLUMN input_fingerprint text,
  ADD COLUMN reserved_id uuid,
  ADD COLUMN expected_edit_revision bigint;
CREATE UNIQUE INDEX workspace_automation_effect_identity
  ON workspace_automation_actions(run_id,node_key,effect_key) WHERE node_key IS NOT NULL;

-- A takeover and its native fence commit together; heartbeat extension does not
-- invalidate the still-running effect. Native writers lock claim before run.
CREATE FUNCTION workspace_automation_runtime_claim_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    UPDATE workspace_automation_runs
    SET execution_generation=execution_generation+1, claim_owner=NEW.worker_id::uuid
    WHERE id::text=NEW.instance_id AND accepted_json IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_automation_runtime_claim_changed
  AFTER INSERT OR UPDATE ON sayiir_workflow_claims
  FOR EACH ROW EXECUTE FUNCTION workspace_automation_runtime_claim_changed();

ALTER TABLE outbox_events DROP CONSTRAINT chk_outbox_events_event_type;
ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_event_type CHECK (event_type IN (
  'mention', 'invite', 'comment_reply', 'access_change', 'doc_updated',
  'workspace_doc_broadcast', 'workspace_content_published', 'history_captured', 'calendar_mail',
  'database_task_notification', 'workspace_automation_trigger'
));

-- Native run deletion owns every engine artifact, including test/Workspace cleanup.
ALTER TABLE workspace_automation_runs ADD COLUMN runtime_instance_id text
  GENERATED ALWAYS AS (id::text) STORED UNIQUE;
ALTER TABLE sayiir_workflow_snapshots ADD CONSTRAINT sayiir_native_run
  FOREIGN KEY(instance_id) REFERENCES workspace_automation_runs(runtime_instance_id) ON DELETE CASCADE;
ALTER TABLE sayiir_workflow_snapshot_history ADD CONSTRAINT sayiir_workflow_snapshot_history_snapshot FOREIGN KEY(instance_id) REFERENCES sayiir_workflow_snapshots(instance_id) ON DELETE CASCADE;
ALTER TABLE sayiir_workflow_tasks ADD CONSTRAINT sayiir_workflow_tasks_snapshot FOREIGN KEY(instance_id) REFERENCES sayiir_workflow_snapshots(instance_id) ON DELETE CASCADE;
ALTER TABLE sayiir_workflow_signals ADD CONSTRAINT sayiir_workflow_signals_snapshot FOREIGN KEY(instance_id) REFERENCES sayiir_workflow_snapshots(instance_id) ON DELETE CASCADE;
ALTER TABLE sayiir_workflow_claims ADD CONSTRAINT sayiir_workflow_claims_snapshot FOREIGN KEY(instance_id) REFERENCES sayiir_workflow_snapshots(instance_id) ON DELETE CASCADE;
ALTER TABLE sayiir_workflow_events ADD CONSTRAINT sayiir_workflow_events_snapshot FOREIGN KEY(instance_id) REFERENCES sayiir_workflow_snapshots(instance_id) ON DELETE CASCADE;

-- Compatibility is admitted by the existing native migration ledger, never library AutoDDL.
COMMENT ON TABLE sayiir_workflow_snapshots IS 'myoxus-runtime-schema:1;sayiir:1.0.0';
