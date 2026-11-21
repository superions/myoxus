-- SPDX-License-Identifier: AGPL-3.0-or-later

-- NULL keeps existing workspaces on their previous membership policy until adopted.
ALTER TABLE workspaces ADD COLUMN ou_member_role text
    CHECK (ou_member_role IN ('Reader', 'Collaborator', 'Manager'));

CREATE TABLE workspace_effective_roles (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direct_role text,
    ou_role text,
    role text NOT NULL,
    owner_ou_manager boolean NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_effective_roles_user ON workspace_effective_roles(user_id, workspace_id);

-- Used only by the migration and by governance writes. One source may disappear
-- while another continues to grant access to the same workspace.
CREATE VIEW workspace_role_sources AS
SELECT workspace_id, user_id, role, true AS direct, false AS owner_ou_manager
FROM workspace_memberships JOIN users ON users.id = workspace_memberships.user_id WHERE workspace_memberships.status = 'Accepted'
UNION ALL
SELECT w.id, m.user_id,
       CASE WHEN m.role = 'manager' THEN 'Admin' ELSE w.ou_member_role END,
       false, w.ou_member_role IS NOT NULL AND m.role = 'manager' AND l.relationship = 'owner'
              AND w.owner_principal_type = 'ou' AND w.owner_principal_id = l.unit_id
FROM organization_unit_workspace l
JOIN organization_unit u ON u.id = l.unit_id AND u.status = 'active'
JOIN organization_unit_member m ON m.unit_id = l.unit_id
JOIN users account ON account.id = m.user_id
JOIN workspaces w ON w.id = l.workspace_id
WHERE (m.role = 'manager' AND EXISTS (
           SELECT 1 FROM user_features f WHERE f.user_id = m.user_id
             AND f.feature_name = 'manager' AND f.activated))
   OR (m.role = 'member' AND l.relationship = 'owner'
       AND w.owner_principal_type = 'ou' AND w.owner_principal_id = l.unit_id
       AND w.ou_member_role IS NOT NULL);

CREATE VIEW workspace_role_projection AS
SELECT workspace_id, user_id, max(role) FILTER (WHERE direct) AS direct_role,
       (array_agg(role ORDER BY array_position(ARRAY['Reader','Collaborator','Manager','Admin'], role) DESC)
           FILTER (WHERE NOT direct))[1] AS ou_role,
       (array_agg(role ORDER BY array_position(
           ARRAY['External','Reader','Commenter','Collaborator','Manager','Admin','Owner'], role) DESC))[1] AS role,
       bool_or(owner_ou_manager) AS owner_ou_manager
FROM workspace_role_sources GROUP BY workspace_id, user_id;

INSERT INTO workspace_effective_roles SELECT * FROM workspace_role_projection;

CREATE FUNCTION refresh_workspace_roles(ws uuid, actor uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    -- Serialize competing sources for this workspace. Subsequent statements
    -- see the previous writer's commit at READ COMMITTED.
    PERFORM id FROM workspaces WHERE id = ws FOR NO KEY UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    DELETE FROM workspace_effective_roles
     WHERE workspace_id = ws AND (actor IS NULL OR user_id = actor);
    IF actor IS NULL THEN
        INSERT INTO workspace_effective_roles SELECT * FROM workspace_role_projection WHERE workspace_id = ws;
    ELSE
        INSERT INTO workspace_effective_roles SELECT * FROM workspace_role_projection WHERE workspace_id = ws AND user_id = actor;
    END IF;
END;
$$;

-- A member and a workspace link can be inserted concurrently on an empty OU.
-- Lock the unit before discovering its workspaces, then refresh in stable order.
CREATE FUNCTION refresh_unit_workspace_roles(unit uuid, actor uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ws uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(1100, hashtext(unit::text));
    FOR ws IN SELECT DISTINCT workspace_id FROM organization_unit_workspace
               WHERE unit_id = unit ORDER BY workspace_id
    LOOP
        PERFORM refresh_workspace_roles(ws, actor);
    END LOOP;
END;
$$;

CREATE FUNCTION workspace_role_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    unit uuid;
    actor uuid;
BEGIN
    CASE TG_TABLE_NAME
    WHEN 'workspace_memberships' THEN
        IF TG_OP = 'UPDATE' AND (NEW.role, NEW.status) = (OLD.role, OLD.status) THEN RETURN NULL; END IF;
        PERFORM refresh_workspace_roles(COALESCE(NEW.workspace_id, OLD.workspace_id),
                                        COALESCE(NEW.user_id, OLD.user_id));
    WHEN 'workspaces' THEN
        PERFORM refresh_workspace_roles(NEW.id);
    WHEN 'organization_unit_workspace' THEN
        IF TG_OP = 'UPDATE' AND NEW.relationship = OLD.relationship THEN RETURN NULL; END IF;
        unit := COALESCE(NEW.unit_id, OLD.unit_id);
        PERFORM pg_advisory_xact_lock(1100, hashtext(unit::text));
        PERFORM refresh_workspace_roles(COALESCE(NEW.workspace_id, OLD.workspace_id));
    WHEN 'organization_unit' THEN
        PERFORM refresh_unit_workspace_roles(NEW.id, NULL);
    WHEN 'organization_unit_member' THEN
        IF TG_OP = 'UPDATE' AND NEW.role = OLD.role THEN RETURN NULL; END IF;
        actor := COALESCE(NEW.user_id, OLD.user_id);
        PERFORM pg_advisory_xact_lock(1101, hashtext(actor::text));
        PERFORM refresh_unit_workspace_roles(COALESCE(NEW.unit_id, OLD.unit_id), actor);
    WHEN 'user_features' THEN
        IF TG_OP = 'UPDATE' AND NEW.activated = OLD.activated THEN RETURN NULL; END IF;
        IF COALESCE(NEW.feature_name, OLD.feature_name) = 'manager' THEN
            actor := COALESCE(NEW.user_id, OLD.user_id);
            PERFORM pg_advisory_xact_lock(1101, hashtext(actor::text));
            FOR unit IN SELECT unit_id FROM organization_unit_member
                         WHERE user_id = actor AND role = 'manager' ORDER BY unit_id
            LOOP
                PERFORM refresh_unit_workspace_roles(unit, actor);
            END LOOP;
        END IF;
    END CASE;
    RETURN NULL;
END;
$$;

CREATE TRIGGER effective_roles_direct AFTER INSERT OR DELETE OR UPDATE OF role, status
ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION workspace_role_source_changed();
CREATE TRIGGER effective_roles_workspace AFTER UPDATE OF owner_principal_type, owner_principal_id, ou_member_role
ON workspaces FOR EACH ROW WHEN ((OLD.owner_principal_type, OLD.owner_principal_id, OLD.ou_member_role)
    IS DISTINCT FROM (NEW.owner_principal_type, NEW.owner_principal_id, NEW.ou_member_role))
EXECUTE FUNCTION workspace_role_source_changed();
CREATE TRIGGER effective_roles_link AFTER INSERT OR DELETE OR UPDATE OF relationship
ON organization_unit_workspace FOR EACH ROW EXECUTE FUNCTION workspace_role_source_changed();
CREATE TRIGGER effective_roles_member AFTER INSERT OR DELETE OR UPDATE OF role
ON organization_unit_member FOR EACH ROW EXECUTE FUNCTION workspace_role_source_changed();
CREATE TRIGGER effective_roles_unit AFTER UPDATE OF status ON organization_unit
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION workspace_role_source_changed();
CREATE TRIGGER effective_roles_feature AFTER INSERT OR DELETE OR UPDATE OF activated
ON user_features FOR EACH ROW EXECUTE FUNCTION workspace_role_source_changed();
