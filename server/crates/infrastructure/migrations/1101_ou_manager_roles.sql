-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE VIEW organization_managers AS
SELECT DISTINCT m.user_id, u.organization_id
FROM organization_unit_member m
JOIN organization_unit u ON u.id = m.unit_id
WHERE m.role = 'manager' AND u.status = 'active';

-- Compatibility projection for administrative feature lists.
CREATE VIEW effective_user_features AS
SELECT user_id, feature_name, activated FROM user_features WHERE feature_name <> 'manager'
UNION ALL
SELECT DISTINCT user_id, 'manager', true FROM organization_managers;

DROP TRIGGER effective_roles_feature ON user_features;
CREATE OR REPLACE VIEW workspace_role_sources AS
SELECT workspace_id, user_id, role, true AS direct, false AS owner_ou_manager, NULL::uuid AS unit_id
FROM workspace_memberships JOIN users ON users.id = workspace_memberships.user_id WHERE workspace_memberships.status = 'Accepted'
UNION ALL
SELECT w.id, m.user_id,
       CASE WHEN m.role = 'manager' THEN 'Admin' ELSE w.ou_member_role END,
       false, w.ou_member_role IS NOT NULL AND m.role = 'manager' AND l.relationship = 'owner'
              AND w.owner_principal_type = 'ou' AND w.owner_principal_id = l.unit_id, l.unit_id
FROM organization_unit_workspace l
JOIN organization_unit u ON u.id = l.unit_id AND u.status = 'active'
JOIN organization_unit_member m ON m.unit_id = l.unit_id
JOIN users account ON account.id = m.user_id
JOIN workspaces w ON w.id = l.workspace_id
WHERE m.role = 'manager'
   OR (m.role = 'member' AND l.relationship = 'owner'
       AND w.owner_principal_type = 'ou' AND w.owner_principal_id = l.unit_id
       AND w.ou_member_role IS NOT NULL);

ALTER TABLE workspace_effective_roles ADD COLUMN ou_ids uuid[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE VIEW workspace_role_projection AS
SELECT workspace_id, user_id, max(role) FILTER (WHERE direct) AS direct_role,
       (array_agg(role ORDER BY array_position(ARRAY['Reader','Collaborator','Manager','Admin'], role) DESC)
           FILTER (WHERE NOT direct))[1] AS ou_role,
       (array_agg(role ORDER BY array_position(
           ARRAY['External','Reader','Commenter','Collaborator','Manager','Admin','Owner'], role) DESC))[1] AS role,
       bool_or(owner_ou_manager) AS owner_ou_manager,
       COALESCE(array_agg(DISTINCT unit_id ORDER BY unit_id) FILTER (WHERE NOT direct AND role = 'Admin'),
                array_agg(DISTINCT unit_id ORDER BY unit_id) FILTER (WHERE NOT direct), ARRAY[]::uuid[]) AS ou_ids
FROM workspace_role_sources GROUP BY workspace_id, user_id;

-- Reconcile already-materialized roles once, in the migration transaction.
DELETE FROM workspace_effective_roles;
INSERT INTO workspace_effective_roles SELECT * FROM workspace_role_projection;
DELETE FROM user_features WHERE feature_name = 'manager';
ALTER TABLE user_features ADD CONSTRAINT manager_is_an_ou_role CHECK (feature_name <> 'manager');
