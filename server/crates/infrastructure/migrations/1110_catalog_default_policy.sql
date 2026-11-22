-- SPDX-License-Identifier: AGPL-3.0-or-later

-- NULL apply_to_new_workspaces means no policy. FALSE is an operator choice.
ALTER TABLE template_catalog_entries
  ADD COLUMN apply_to_new_workspaces boolean,
  ADD COLUMN selection_mode text NOT NULL DEFAULT 'published' CHECK (selection_mode IN ('published','pinned_revision')),
  ADD COLUMN provisioning_mode text NOT NULL DEFAULT 'managed_until_local_edit' CHECK (provisioning_mode IN ('seed_once','managed_until_local_edit','manual_update')),
  ADD COLUMN release_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN policy_created_at timestamptz,
  ADD COLUMN policy_updated_at timestamptz,
  ADD CHECK ((apply_to_new_workspaces IS NULL) = (policy_created_at IS NULL)),
  ADD CHECK ((apply_to_new_workspaces IS NULL) = (policy_updated_at IS NULL)),
  ADD CHECK (apply_to_new_workspaces IS NOT NULL OR NOT release_managed);
UPDATE template_catalog_entries e SET apply_to_new_workspaces=p.apply_to_new_workspaces,
  selection_mode=p.selection_mode,provisioning_mode=p.provisioning_mode,release_managed=p.release_managed,
  policy_created_at=p.created_at,policy_updated_at=p.updated_at FROM template_default_policies p WHERE p.template_id=e.id;
DROP TABLE template_default_policies;
