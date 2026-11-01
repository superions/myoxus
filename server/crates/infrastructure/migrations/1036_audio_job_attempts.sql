-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Extend the existing audio job owner; Redis remains a delivery mechanism.
ALTER TABLE copilot_jobs
  ADD COLUMN transcription_attempt_id uuid,
  ADD COLUMN transcription_attempts integer NOT NULL DEFAULT 0 CHECK (transcription_attempts >= 0),
  ADD COLUMN transcription_deadline timestamptz,
  ADD COLUMN transcription_lease_until timestamptz,
  ADD COLUMN transcription_dispatch_after timestamptz,
  ADD COLUMN transcription_cleanup_after timestamptz;

UPDATE copilot_jobs SET transcription_attempt_id = gen_random_uuid(),
  transcription_dispatch_after = now()
WHERE job_type = 'audio_transcription';

-- Existing execution snapshots get their bounded deadline from the worker's
-- authoritative queue policy on recovery. Missing snapshots fail closed there.
CREATE INDEX copilot_audio_dispatch_idx ON copilot_jobs
  (transcription_dispatch_after, created_at, id)
  WHERE job_type = 'audio_transcription' AND state IN ('pending', 'running', 'claimed');

CREATE INDEX copilot_audio_cleanup_idx ON copilot_jobs (transcription_cleanup_after, id)
  WHERE job_type = 'audio_transcription' AND transcription_cleanup_after IS NOT NULL;
