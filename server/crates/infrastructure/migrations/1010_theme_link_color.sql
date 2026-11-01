-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Preserve the previously projected link color in every persisted schema,
-- including operator-owned clones, before links become independently editable.
INSERT INTO color_schema_values (schema_id, mode, token_key, value)
SELECT schema_id, mode, 'link-default', value
FROM color_schema_values
WHERE token_key = 'accent-primary'
ON CONFLICT (schema_id, mode, token_key) DO NOTHING;
