<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Administration via API: organization management

[Documentation](../../README.md) / [API](../README.md) / [Server API](./README.md)

Use this reference for scripted organization administration and integrations.
For day-to-day administration, follow the
[Admin frontend organization guide](../../ops/administration/organization.md).

GraphQL requests use `POST /graphql` and the server's normal authentication.
Operations under `admin` require global Admin authorization; the manager
operations below use the caller's own organizational scope. Inspect response
errors as well as returned data. The [server API guide](./README.md) explains
request handling, and the [schema reference](./graphql/README.md) contains the
complete current signatures.

For OIDC setup and group mapping through Admin, see
[SSO and group mapping](../../ops/administration/organization.md#sso-and-group-mapping).
Provider configuration and claim policies are described in the
[authentication guide](../../ops/security/authentication.md#oidc-claims-and-ou-group-mapping).

<details>
<summary>On this page</summary>

- [Overview](#overview)
- [Model](#model)
- [Initial Provisioning](#initial-provisioning)
- [Selecting the Active Structure Model](#selecting-the-active-structure-model)
- [Renaming the Organization](#renaming-the-organization)
- [Managing OU Types](#managing-ou-types)
- [Creating, Moving, and Deactivating OUs](#creating-moving-and-deactivating-ous)
- [Using the Organization Chart](#using-the-organization-chart)
- [Assigning Managers](#assigning-managers)
- [Assigning Workspaces to an OU](#assigning-workspaces-to-an-ou)
- [Project and Workspace Creation by Managers](#project-and-workspace-creation-by-managers)
- [Import and Export](#import-and-export)
- [Sync Sources and Conflict Rules](#sync-sources-and-conflict-rules)
- [Troubleshooting](#troubleshooting)

</details>

## Overview

Myoxus manages users, workspaces, and projects under one **organization**. An
organization can contain any number of **organizational units** (OUs), arranged
as a hierarchy of departments, teams, projects, or staff units. An OU can own,
manage, or link multiple workspaces. This replaces the former one-to-one team
and workspace model.

This reference documents organization API operations, interchange contracts
and synchronization behavior.

## Model

| Term                 | Meaning                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization         | Tenant container. In single-tenant mode, the default organization has `key='myoxus'`.                                                                                     |
| Organizational unit  | Node in the hierarchy with `parent_unit_id`, `unit_type_id`, and `slug`.                                                                                                  |
| OU type              | Template with capability flags such as `is_structural`, `can_have_children`, `can_be_root_level`, and `can_own_workspaces`.                                               |
| OU member            | User-to-OU relation with a `reader`, `member`, or `manager` role and a `manual`, `import`, `oidc`, `ldap`, or `scim` source.                                              |
| OU-to-workspace link | OU-to-workspace relation with `owner`, `managed`, or `linked` semantics.                                                                                                  |
| Manager              | Capability plus role. Management access requires both global `FeatureType.Manager` and `organization_unit_member.role='manager'`.                                         |
| Policy               | Three-state project creation settings (`disabled`, `requires_approval`, or `allowed`), with separate boolean permissions for workspace creation and OU member management. |

Important invariants:

- An OU may own multiple workspaces, but a workspace has at most one OU owner
  relation, enforced by a partial unique index.
- Parent assignment uses a 32-level cycle cap. Cyclic hierarchies cannot be
  persisted.
- OU managers can receive at most `WorkspaceRole::Admin`; they can never become
  workspace owners.
- `FeatureType.Manager` without OU membership grants no access. A manager OU
  membership without the global feature grants no access either.

## Initial Provisioning

The canonical baseline creates the default organization and bundled OU type
presets automatically.

The bundled catalogues cover general organizational structures, large and small
municipal administrations, deep business hierarchies and matrix/project
organizations. Inspect the exact types through the Admin frontend or the
GraphQL query `admin.organizationUnitTypes`.

## Selecting the Active Structure Model

Select exactly one authoring model under **Organization -> Unit types** in the
Admin frontend. The selection is stored in
`organization.metadata.unit_type_catalog`. It filters OU type choices only; it
does not modify server-seeded presets.

| Selection | Effect in OU forms                                                 |
| --------- | ------------------------------------------------------------------ |
| `all`     | UI label **All**; shows every active type, including custom types. |
| `default` | Shows active default preset types without a package prefix.        |
| `kvg`     | Shows active `kvg.*` preset types only.                            |
| `kvk`     | Shows active `kvk.*` preset types only.                            |
| `wt`      | Shows active `wt.*` preset types only.                             |
| `mx`      | Shows active `mx.*` preset types only.                             |

Custom types remain visible and editable in type management. OU forms show
them only under **All**. Existing OUs whose type no longer belongs to the
active model remain editable in the detail inspector, which explicitly marks
this exception.

The model can also be selected through GraphQL:

```graphql
mutation UpdateOrganizationUnitCatalog {
  admin {
    updateOrganization(input: { metadata: { unit_type_catalog: { schema_version: 1, id: "kvk" } } }) {
      metadata
    }
  }
}
```

## Renaming the Organization

```graphql
mutation RenameOrganization {
  admin {
    updateOrganization(input: { name: "Myoxus AG", slug: "myoxus-ag" }) {
      id
      name
      slug
    }
  }
}
```

The `key` is immutable because it is the single-tenant stability anchor. The
operation is audited as `organization.update`.

## Managing OU Types

These operations are Admin-only:

```graphql
mutation UpsertOrganizationUnitType {
  admin {
    upsertOrganizationUnitType(input: { key: "department", label: "Department", isStructural: true, canHaveChildren: true, canBeRootLevel: true, canBeManagerCreated: false, canHaveCrossUnitMembers: false, canOwnWorkspaces: true, canManageWorkspaces: true }) {
      id
      key
      label
    }
  }
}

mutation DeactivateOrganizationUnitType {
  admin {
    deactivateOrganizationUnitType(id: "<type-uuid>")
  }
}
```

Types with `is_preset=true` are immutable because migrations seed them. Custom
types may use any supported capability-flag combination.

## Creating, Moving, and Deactivating OUs

```graphql
mutation UpsertOrganizationUnit {
  admin {
    upsertOrganizationUnit(input: { unitTypeId: "<type-uuid>", name: "Marketing Department", slug: "marketing", parentUnitId: null, status: Active }) {
      id
      name
      slug
    }
  }
}

mutation SetOrganizationUnitParent {
  admin {
    setOrganizationUnitParent(unitId: "<unit-uuid>", parentUnitId: "<parent-unit-uuid>")
  }
}

mutation DeactivateOrganizationUnit {
  admin {
    deactivateOrganizationUnit(id: "<unit-uuid>")
  }
}
```

Every `parent_unit_id` assignment runs the 32-level cycle check. Moving a node
into its own subtree fails with `Conflict`.

`admin.organizationUnits` also returns `childUnitCount`, `memberCount`, and
`workspaceCount`. Lists, the organization chart, and page counters consume the
same API projection.

## Using the Organization Chart

The Admin frontend exposes the OU hierarchy under
**Organization -> Organization chart**. This is not a separate editing model.
Selecting a node opens the same audited `UnitDetail` inspector used by the list
view. Name, type, parent, members, and workspace assignments are edited in that
one place.

## Assigning Managers

Assign the user to a specific OU with the `Manager` role:

```graphql
mutation AssignOrganizationManager {
  admin {
    assignOrganizationManager(input: { unitId: "<unit-uuid>", userId: "<user-uuid>", role: Manager }) {
      unitId
      userId
      role
    }
  }
}
```

The mutation also materializes the global Manager capability when necessary.
Removing or downgrading the user's last Manager membership revokes that
capability automatically. Remove a membership with:

```graphql
mutation UnassignOrganizationManager {
  admin {
    unassignOrganizationManager(unitId: "<unit-uuid>", userId: "<user-uuid>")
  }
}
```

## Assigning Workspaces to an OU

```graphql
mutation AssignOrganizationUnitWorkspace {
  admin {
    assignOrganizationUnitWorkspace(input: { unitId: "<unit-uuid>", workspaceId: "<workspace-uuid>", relationship: Owner })
  }
}

mutation UnassignOrganizationUnitWorkspace {
  admin {
    unassignOrganizationUnitWorkspace(unitId: "<unit-uuid>", workspaceId: "<workspace-uuid>", relationship: Owner)
  }
}
```

Relations:

- `owner`: the OU owns the workspace. Each workspace may have only one owner
  relation.
- `managed`: the OU manages the workspace without owning it.
- `linked`: informational relation without management authority.

## Project and Workspace Creation by Managers

Root-level project creation and project creation inside an OU each have three
policy states. Workspace creation and OU member management are separate boolean
permissions:

- `disabled`: managers cannot perform the operation.
- `requires_approval`: a manager can create an
  `organization_project_request`, which an Admin must decide.
- `allowed`: a manager can create the resource directly.

Configure policies through:

```graphql
mutation {
  admin {
    updateOrganizationPolicy(input: { managerRootProjectCreation: Allowed, managerUnitProjectCreation: RequiresApproval, managerCanCreateWorkspaces: true, managerCanManageOuMembers: false, importExportEnabled: true }) {
      managerRootProjectCreation
      managerUnitProjectCreation
      managerCanCreateWorkspaces
      managerCanManageOuMembers
      importExportEnabled
    }
  }
}
```

Manager workflow:

- `myOrganizationUnits` and `myOrganizationUnitWorkspaces` expose the caller's
  OUs and workspaces.
- `canCreateOrganizationProject(unitId: ...)` and
  `canCreateWorkspaceInOrganizationUnit(unitId: ...)` are read-only policy
  checks.
- `createOrganizationProject(input: ...)` applies the policy gate and returns
  `ALLOWED`, `REQUIRES_APPROVAL`, or `DENIED`. Approval-required requests are
  persisted.
- `createWorkspaceInOrganizationUnit(input: ...)` creates a workspace and links
  it as owned by the OU. The operation is audited as
  `organization.workspace.create`.

Admin decision:

```graphql
mutation {
  admin {
    decideOrganizationProjectRequest(id: "<request-uuid>", newStatus: Approved)
  }
}
```

Only the requester can set `Cancelled`, using
`cancelOrganizationProjectRequest(id: ...)`.

## Import and Export

Admin shows export loading and read failures separately from import results.
Downloads are unavailable while the current snapshot is loading or failed;
Retry reloads it without discarding a pasted import draft. A successful import
remains successful when its subsequent export refresh fails. Use Export Retry,
not another Apply, to recover that readback.

JSON is the complete interchange format using schema version 1. Its exported
field names are camelCase. Unknown or duplicate fields are rejected at every
typed level, while keys inside an explicit `metadata` object remain free-form.
The existing optional collections and optional record fields may still be
omitted. There are no snake_case aliases: a misspelling such as `unit_types`
is an error instead of an empty import.

CSV is the human-readable projection comprising `organization.csv`,
`ou_types.csv`, `ous.csv`, `ou_members.csv`, and `ou_workspaces.csv`. An import
must contain exactly one of a JSON snapshot or CSV files. For CSV,
`organization.csv` is required and must contain exactly one data row; the other
four files remain optional. File names and columns are exact, although columns
may be reordered. Unknown or duplicate files and columns, missing required
headers, duplicate stable keys, malformed values, and ambiguous rows are
reported with file, row, and field context. The RFC-4180 parser preserves
quoted commas and newlines, Unicode, and CRLF input.

Both formats use the same `parse -> dry_run -> apply` pipeline. Structural or
domain validation errors are returned in the preview response and do not enter
the mutation path. CSV export serialization failures are reported as failures;
the server never substitutes an empty successful file.

CSV is deliberately not a full snapshot. Applying it preserves every
authoritative field absent from its columns, including organization and entity
metadata, policy, OU descriptions, and unit-type presentation/state values.
Defaults apply only when a CSV row creates a new entity. JSON retains its full
schema-versioned snapshot semantics.

```graphql
query OrganizationExport {
  admin {
    organizationExport {
      schemaVersion
      json
      files {
        name
        contentType
        content
      }
    }
  }
}

mutation OrganizationImportDryRun {
  admin {
    organizationImportDryRun(input: { json: "..." }) {
      errors {
        source
        row
        field
        message
      }
      summary {
        unitsInserted
      }
    }
  }
}

mutation OrganizationImportApply {
  admin {
    organizationImportApply(input: { json: "..." }) {
      errors {
        message
      }
      summary {
        organizationUpdated
      }
    }
  }
}
```

The authoritative CSV columns and validation rules live in
`server/crates/application/src/organization/import_export.rs`:

| File                | Required columns                                                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization.csv`  | `key`, `name`, `slug`                                                                                                                                                                                                         |
| `ou_types.csv`      | `key`, `label`, `is_structural`, `can_have_children`, `can_be_root_level`, `can_be_manager_created`, `can_have_cross_unit_members`, `can_own_workspaces`, `can_manage_workspaces`, `is_staff_unit`, `requires_admin_approval` |
| `ous.csv`           | `key`, `parent_key`, `type_key`, `name`, `slug`, `status`, `max_members`                                                                                                                                                      |
| `ou_members.csv`    | `ou_key`, `user_email`, `role`, `source`                                                                                                                                                                                      |
| `ou_workspaces.csv` | `ou_key`, `workspace_id`, `relationship`                                                                                                                                                                                      |

Idempotency keys:

| Entity               | Stable key                                                             |
| -------------------- | ---------------------------------------------------------------------- |
| Organization         | `key`                                                                  |
| OU type              | `(organization_id, key)`                                               |
| OU                   | `(organization_id, slug)`, with hierarchy represented by `parent_slug` |
| OU member            | `(unit_id, user_id)`, resolving users by email                         |
| OU-to-workspace link | `(unit_id, workspace_id, relationship)`                                |

Apply persists nothing unless the dry run is error-free, then rechecks mutable
references in one serializable transaction. Organization, types, units and
parents, memberships and Manager capability, workspace relationships and owner
projection, and policy either commit together or all roll back. Stable-key
reimports keep IDs and do not delete unrelated records. Serialization conflicts
are retried at most three times; source conflicts and other business errors are
not retried. Only a committed import returns a success summary. Cache
invalidation and the `organization.import.apply` audit record run after commit;
their best-effort failures are logged and never misreported as a durable
rollback.

## Sync Sources and Conflict Rules

Each `organization_unit_member` row has one of five `source` values:
`manual`, `import`, `oidc`, `ldap`, or `scim`. The source determines conflict
behavior during synchronization.

| Source   | Writer                                    | Allowed manual changes                                   | Next synchronization       |
| -------- | ----------------------------------------- | -------------------------------------------------------- | -------------------------- |
| `manual` | Admin or manager through frontend/GraphQL | Role, metadata, and removal                              | Unchanged by sync.         |
| `import` | Admin JSON/CSV apply                      | Role and metadata; removal survives until another import | Changed only by import.    |
| `oidc`   | OIDC group sync at login                  | Local metadata only; sync resets the role                | Server wins for OIDC rows. |
| `ldap`   | No active synchronization writer          | Preserve existing rows                                   | Not supported.             |
| `scim`   | No active synchronization writer          | Preserve existing rows                                   | Not supported.             |

The implemented OIDC path writes only `source=oidc` rows. It maps provider
groups to OUs, never creates direct workspace roles, and never grants global
Admin access. Manual, import, LDAP, and SCIM rows remain intact when an OIDC
group maps to the same OU. Stale OIDC rows are removed only when
`removeMissingOidcMemberships=true`.

LDAP and SCIM remain modeled as reserved extension sources. Sync-owned rows use
`server-wins`: a local patch is discarded by the next synchronization while
the membership remains owned by that source.

For mixed environments, use `manual` for managers and staff units, and sync
departments and standard memberships. This retains operational flexibility
without creating multi-channel conflicts.

## Troubleshooting

### Safe Status Changes and Deletion

Manage OUs only through **Organization -> Units** in Admin or the documented
GraphQL/MCP lifecycle operations. `active` is the only operational status.
`disabled` and `archived` grant no OU rights and accept no new relations.

Always load the deletion preview before permanent deletion. It lists child
units, members, workspace links, owner and managed workspaces, project requests,
and OIDC group mappings separately. Resolve each relation through its owning
Admin surface or API, then request a fresh preview.
Only an inactive OU with no blockers can be deleted, and deletion requires both
the exact OU name and the current preview revision. Deletion is irreversible
and does not cascade domain data.

Direct `DELETE` statements and manual foreign-key changes are unsupported.
They bypass status, reference, OIDC lock, and audit invariants.

- **`is_manager_for_unit` returns `false` despite membership:** verify the
  global `FeatureType.Manager` capability through
  `admin.users(filter: ...) { features }` or the `user_features` table.
- **`upsertOrganizationUnit` returns `Conflict`:** either the slug duplicates a
  sibling under the same parent, or the new parent creates a cycle within the
  32-hop cap.
- **`createWorkspaceInOrganizationUnit` returns `ActionForbidden`:**
  `manager_can_create_workspaces` may be false, the OU type may have
  `can_own_workspaces=false`, or the caller may not manage that OU.
- **A historical shared workspace has no root content:** repair it once using
  an existing active global Admin:

  ```bash
  myoxus-cli workspaces seed-root-doc all --admin-user-id <uuid>
  ```

  The command reports `Seeded`, `Skipped`, `Failed`, and `Total`. Record the
  affected count before running it; the count must be zero afterwards:

  ```sql
  SELECT COUNT(*)
    FROM workspaces w
   WHERE w.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM doc_updates u
        WHERE u.workspace_id = w.id AND u.doc_id = w.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM doc_snapshots s
        WHERE s.workspace_id = w.id AND s.doc_id = w.id
     );
  ```

  The operation is idempotent and overwrites neither updates nor snapshots. A
  missing actor ID, or one that does not identify an active global Admin,
  aborts before the first change. Any other seed failure also returns a nonzero
  exit status; rerun safely after correcting the cause.

- **Import reports `unsupported schemaVersion`:** a newer server exported the
  snapshot. The current server supports `JSON_SCHEMA_VERSION = 1`.
- **Audit entries are absent:** tests and development setups without a wired
  `PgAuditLogStore` use a no-op recorder. Production wires
  `with_audit_recorder` in `server.rs`.
