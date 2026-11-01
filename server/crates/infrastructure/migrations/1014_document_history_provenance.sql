-- SPDX-License-Identifier: AGPL-3.0-or-later

ALTER TABLE doc_histories
  ADD COLUMN origin text,
  ADD COLUMN actor_id uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE doc_histories
  ADD CONSTRAINT doc_histories_origin_check
  CHECK (
    origin IS NULL
    OR origin IN (
      'manual',
      'automatic',
      'publish',
      'pdf_export',
      'daily',
      'api',
      'restore',
      'recovery'
    )
  );
