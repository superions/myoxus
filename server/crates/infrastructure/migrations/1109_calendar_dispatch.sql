-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE calendar_reminders ADD COLUMN worker_job_id uuid, ADD COLUMN dispatched_at timestamptz,
  ADD CHECK ((worker_job_id IS NULL) = (dispatched_at IS NULL));
UPDATE calendar_reminders r SET worker_job_id=d.worker_job_id,dispatched_at=d.dispatched_at
FROM calendar_reminder_dispatch_log d WHERE r.id=d.reminder_id;
DROP TABLE calendar_reminder_dispatch_log;
