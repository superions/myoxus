-- SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later

UPDATE template_catalog_entries SET builder_version = 4, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'meeting-notes' AND builder_version = 3;

UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'agile-standup' AND builder_version = 2;

UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'agile-retro' AND builder_version = 2;
