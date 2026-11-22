-- Older schemas allowed simultaneous relationships between the same pair.
-- The enum order is owner, managed, linked. Retain existing strongest rights.
DELETE FROM organization_unit_workspace weaker USING organization_unit_workspace stronger
WHERE weaker.unit_id = stronger.unit_id AND weaker.workspace_id = stronger.workspace_id
  AND weaker.relationship > stronger.relationship;
ALTER TABLE organization_unit_workspace DROP CONSTRAINT organization_unit_workspace_pkey,
  ADD PRIMARY KEY (unit_id, workspace_id);
