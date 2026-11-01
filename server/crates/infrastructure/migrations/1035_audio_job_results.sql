-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Bind each historical audio job to its actual model-specific result. Legacy
-- payloads remain untouched as recovery input; new writes use the result table.
ALTER TABLE copilot_jobs ADD COLUMN transcription_result_id uuid
  REFERENCES copilot_transcripts(id) ON DELETE SET NULL;

INSERT INTO copilot_transcripts
  (workspace_id, source_type, source_id, content, segments, model, language,
   duration_secs, metadata, status, created_at, updated_at)
SELECT j.workspace_id, 'audio', j.id::text,
  CASE jsonb_typeof(j.payload->'transcription')
    WHEN 'string' THEN j.payload->>'transcription'
    ELSE j.payload->'transcription'->>'text' END,
  CASE WHEN jsonb_typeof(j.payload->'transcription'->'segments') = 'array'
    THEN j.payload->'transcription'->'segments' ELSE '[]'::jsonb END,
  COALESCE(NULLIF(j.payload->'transcription'->>'model', ''),
    NULLIF(j.payload->'transcriptionConfig'->>'model', ''), NULLIF(j.payload->>'model', ''), ''),
  j.payload->'transcription'->>'language',
  CASE WHEN jsonb_typeof(j.payload->'transcription'->'duration_seconds') = 'number'
    THEN (j.payload->'transcription'->>'duration_seconds')::real ELSE NULL END,
  jsonb_strip_nulls(jsonb_build_object('provider', j.payload->'transcription'->'provider')),
  'completed', j.created_at, j.updated_at
FROM copilot_jobs j
WHERE j.job_type = 'audio_transcription' AND j.workspace_id IS NOT NULL
  AND (jsonb_typeof(j.payload->'transcription'->'text') = 'string'
    OR jsonb_typeof(j.payload->'transcription') = 'string')
  AND NOT EXISTS (
    SELECT 1 FROM copilot_transcripts t
    WHERE t.workspace_id = j.workspace_id AND t.source_type = 'audio'
      AND t.status = 'completed'
      AND (t.source_id = j.id::text OR t.source_id = j.payload->>'blobId')
      AND (COALESCE(NULLIF(j.payload->'transcription'->>'model', ''),
        NULLIF(j.payload->'transcriptionConfig'->>'model', ''), NULLIF(j.payload->>'model', '')) IS NULL
        OR t.model = COALESCE(NULLIF(j.payload->'transcription'->>'model', ''),
          NULLIF(j.payload->'transcriptionConfig'->>'model', ''), NULLIF(j.payload->>'model', '')))
  )
ON CONFLICT (workspace_id, source_type, source_id, model) DO NOTHING;

-- Existing rows and their metadata win over legacy payloads. Resolve historical
-- identities once, with a stable tie-breaker; readback subsequently uses the ID.
WITH candidates AS (
  SELECT j.id, (
    SELECT t.id FROM copilot_transcripts t
    WHERE t.workspace_id = j.workspace_id AND t.source_type = 'audio'
      AND t.status = 'completed'
      AND (t.source_id = j.id::text OR t.source_id = j.payload->>'blobId')
      AND (COALESCE(NULLIF(j.payload->'transcription'->>'model', ''),
        NULLIF(j.payload->'transcriptionConfig'->>'model', ''), NULLIF(j.payload->>'model', '')) IS NULL
        OR t.model = COALESCE(NULLIF(j.payload->'transcription'->>'model', ''),
          NULLIF(j.payload->'transcriptionConfig'->>'model', ''), NULLIF(j.payload->>'model', '')))
    ORDER BY (t.source_id = j.id::text) DESC, t.updated_at DESC, t.id DESC LIMIT 1
  ) AS result_id FROM copilot_jobs j WHERE j.job_type = 'audio_transcription'
)
UPDATE copilot_jobs j SET transcription_result_id = candidates.result_id
FROM candidates WHERE j.id = candidates.id AND candidates.result_id IS NOT NULL;

CREATE INDEX idx_copilot_audio_jobs_owner_source
  ON copilot_jobs (user_id, workspace_id, (payload->>'blobId'), updated_at DESC, id DESC)
  WHERE job_type = 'audio_transcription';
