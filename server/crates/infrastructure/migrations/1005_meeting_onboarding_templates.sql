-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Advance builtin source revisions through the regular registry. Seed-once
-- onboarding copies remain reader-owned; this does not rewrite their content.
UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'meeting-notes' AND builder_version = 2;
UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'welcome-myoxus' AND builder_version = 2;
UPDATE template_catalog_entries SET builder_version = 3, updated_at = NOW()
WHERE source = 'builtin' AND slug = 'getting-started-myoxus' AND builder_version = 2;

INSERT INTO template_catalog_entries
  (id, slug, title, description, category, tags, status, created_by,
   created_at, updated_at, archived_at, source, builder_version, min_client_version)
VALUES
  ('70a65e40-359a-4aa0-9d72-d8e71f09c1e7', 'meeting-templates-myoxus', 'Meeting Templates', 'Guide to reusable meeting documents and manual attendance', 'onboarding', '{onboarding,meetings,templates}', 'active', NULL, NOW(), NOW(), NULL, 'builtin', 1, 0),
  ('786e79f3-f78d-4a20-94e6-02cbd388723a', 'databases-guide-myoxus', 'Databases', 'Guide to fields, rows, views and database collaboration', 'onboarding', '{onboarding,databases,guide}', 'active', NULL, NOW(), NOW(), NULL, 'builtin', 1, 0);

INSERT INTO template_default_policies
  (template_id, apply_to_new_workspaces, selection_mode, provisioning_mode)
SELECT id, true, 'published', 'seed_once'
FROM template_catalog_entries
WHERE source = 'builtin'
  AND slug IN ('meeting-templates-myoxus', 'databases-guide-myoxus');
