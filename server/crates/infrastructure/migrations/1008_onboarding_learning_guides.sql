-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Update reusable builders; seed-once reader copies remain untouched.
UPDATE template_catalog_entries SET builder_version = 4, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'welcome-myoxus' AND builder_version = 3;

UPDATE template_catalog_entries SET builder_version = 4, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'getting-started-myoxus' AND builder_version = 3;

UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'using-folders-myoxus' AND builder_version = 2;

UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'meeting-templates-myoxus' AND builder_version = 2;

UPDATE template_catalog_entries SET builder_version = 2, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'databases-guide-myoxus' AND builder_version = 1;
