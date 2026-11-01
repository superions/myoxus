/**
 * Organization management helpers for E2E tests.
 *
 * GraphQL mirrors the resolvers built in Paket D so tests exercise the
 * same surface as the admin / web frontends.
 */

import type { APIRequestContext } from "@playwright/test";

import { gqlRequest } from "./auth";

// ── Types ─────────────────────────────────────────────────────────────

export interface OrganizationUnitInfo {
  id: string;
  name: string;
  slug: string;
  parentUnitId: string | null;
  unitTypeId: string;
  status: string;
  childUnitCount: number;
  memberCount: number;
  workspaceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationInfo {
  id: string;
  key: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown>;
}

export interface OrganizationUnitTypeInfo {
  id: string;
  key: string;
  label: string;
  isPreset: boolean;
  isActive: boolean;
}

export interface OrganizationProjectRequestInfo {
  id: string;
  status: string;
  proposedName: string;
  requestedScope: string;
  requestedBy: string;
  createdAt: string;
}

export type OrganizationUnitRole = "Reader" | "Member" | "Manager";
export type OrganizationUnitWorkspaceRelationship =
  "OWNER" | "MANAGED" | "LINKED";

export interface OrganizationUnitMemberInfo {
  unitId: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  userAvatarUrl: string | null;
  role: OrganizationUnitRole;
  source: string;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationUnitWorkspaceInfo {
  unitId: string;
  workspaceId: string;
  workspaceName: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
  relationship: OrganizationUnitWorkspaceRelationship;
  storageUsedBytes: number | null;
  effectiveQuotaBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

// ── Queries ───────────────────────────────────────────────────────────

export async function fetchOrganizationUnits(
  request: APIRequestContext,
): Promise<OrganizationUnitInfo[]> {
  const data = await gqlRequest<{
    admin: { organizationUnits: OrganizationUnitInfo[] };
  }>(
    request,
    `query { admin { organizationUnits {
       id name slug parentUnitId unitTypeId status
       childUnitCount memberCount workspaceCount
       createdAt updatedAt
     } } }`,
  );
  return data.admin.organizationUnits;
}

export async function fetchOrganization(
  request: APIRequestContext,
): Promise<OrganizationInfo> {
  const data = await gqlRequest<{
    admin: { organization: OrganizationInfo };
  }>(request, `query { admin { organization { id key name slug metadata } } }`);
  return data.admin.organization;
}

export async function fetchOrganizationUnitTypes(
  request: APIRequestContext,
): Promise<OrganizationUnitTypeInfo[]> {
  const data = await gqlRequest<{
    admin: { organizationUnitTypes: OrganizationUnitTypeInfo[] };
  }>(
    request,
    `query { admin { organizationUnitTypes(includeInactive: true) {
       id key label isPreset isActive
     } } }`,
  );
  return data.admin.organizationUnitTypes;
}

export async function fetchPendingProjectRequests(
  request: APIRequestContext,
): Promise<OrganizationProjectRequestInfo[]> {
  const data = await gqlRequest<{
    admin: { organizationProjectRequests: OrganizationProjectRequestInfo[] };
  }>(
    request,
    `query { admin { organizationProjectRequests(status: PENDING) {
       id status proposedName requestedScope requestedBy createdAt
     } } }`,
  );
  return data.admin.organizationProjectRequests;
}

export async function fetchOrganizationUnitMembers(
  request: APIRequestContext,
  unitId: string,
): Promise<OrganizationUnitMemberInfo[]> {
  const data = await gqlRequest<{
    admin: { organizationUnitMembers: OrganizationUnitMemberInfo[] };
  }>(
    request,
    `query UnitMembers($unitId: ID!) {
       admin { organizationUnitMembers(unitId: $unitId) {
         unitId userId userEmail userName userAvatarUrl role source metadata createdAt updatedAt
       } }
     }`,
    { unitId },
  );
  return data.admin.organizationUnitMembers;
}

export async function fetchOrganizationUnitWorkspaces(
  request: APIRequestContext,
  unitId: string,
): Promise<OrganizationUnitWorkspaceInfo[]> {
  const data = await gqlRequest<{
    admin: { organizationUnitWorkspaces: OrganizationUnitWorkspaceInfo[] };
  }>(
    request,
    `query UnitWorkspaces($unitId: ID!) {
       admin { organizationUnitWorkspaces(unitId: $unitId) {
         unitId workspaceId workspaceName ownerUserId ownerEmail relationship
         storageUsedBytes effectiveQuotaBytes createdAt updatedAt
       } }
     }`,
    { unitId },
  );
  return data.admin.organizationUnitWorkspaces;
}

// ── Mutations (admin) ─────────────────────────────────────────────────

export async function createOrganizationUnit(
  request: APIRequestContext,
  input: {
    name: string;
    slug: string;
    unitTypeId: string;
    parentUnitId?: string | null;
  },
): Promise<OrganizationUnitInfo> {
  const data = await gqlRequest<{
    admin: { upsertOrganizationUnit: OrganizationUnitInfo };
  }>(
    request,
    `mutation Upsert($input: UpsertOrganizationUnitInput!) {
       admin { upsertOrganizationUnit(input: $input) {
         id name slug parentUnitId unitTypeId status
         childUnitCount memberCount workspaceCount
         createdAt updatedAt
       } }
     }`,
    { input },
  );
  return data.admin.upsertOrganizationUnit;
}

export async function updateOrganizationMetadata(
  request: APIRequestContext,
  metadata: Record<string, unknown>,
): Promise<OrganizationInfo> {
  const data = await gqlRequest<{
    admin: { updateOrganization: OrganizationInfo };
  }>(
    request,
    `mutation UpdateOrganization($metadata: JSON!) {
       admin { updateOrganization(input: { metadata: $metadata }) {
         id key name slug metadata
       } }
     }`,
    { metadata },
  );
  return data.admin.updateOrganization;
}

export async function deactivateOrganizationUnit(
  request: APIRequestContext,
  unitId: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation Deactivate($id: ID!) {
       admin { deactivateOrganizationUnit(id: $id) }
     }`,
    { id: unitId },
  );
}

export async function deactivateOrganizationUnitType(
  request: APIRequestContext,
  unitTypeId: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation DeactivateUnitType($id: ID!) {
       admin { deactivateOrganizationUnitType(id: $id) }
     }`,
    { id: unitTypeId },
  );
}

export async function assignOrganizationUnitMember(
  request: APIRequestContext,
  input: {
    unitId: string;
    userId: string;
    role: OrganizationUnitRole;
  },
): Promise<OrganizationUnitMemberInfo> {
  const data = await gqlRequest<{
    admin: { assignOrganizationManager: OrganizationUnitMemberInfo };
  }>(
    request,
    `mutation AssignUnitMember($input: AssignOrganizationManagerInput!) {
       admin { assignOrganizationManager(input: $input) {
         unitId userId userEmail userName userAvatarUrl role source metadata createdAt updatedAt
       } }
     }`,
    { input },
  );
  return data.admin.assignOrganizationManager;
}

export async function unassignOrganizationUnitMember(
  request: APIRequestContext,
  unitId: string,
  userId: string,
): Promise<void> {
  await gqlRequest(
    request,
    `mutation UnassignUnitMember($unitId: ID!, $userId: ID!) {
       admin { unassignOrganizationManager(unitId: $unitId, userId: $userId) }
     }`,
    { unitId, userId },
  );
}

export async function assignOrganizationUnitWorkspace(
  request: APIRequestContext,
  input: {
    unitId: string;
    workspaceId: string;
    relationship: OrganizationUnitWorkspaceRelationship;
  },
): Promise<void> {
  await gqlRequest(
    request,
    `mutation AssignUnitWorkspace($input: AssignOrganizationUnitWorkspaceInput!) {
       admin { assignOrganizationUnitWorkspace(input: $input) }
     }`,
    { input },
  );
}

export async function unassignOrganizationUnitWorkspace(
  request: APIRequestContext,
  input: {
    unitId: string;
    workspaceId: string;
    relationship: OrganizationUnitWorkspaceRelationship;
  },
): Promise<void> {
  await gqlRequest(
    request,
    `mutation UnassignUnitWorkspace(
       $unitId: ID!
       $workspaceId: ID!
       $relationship: OrganizationUnitWorkspaceRelationshipEnum!
     ) {
       admin {
         unassignOrganizationUnitWorkspace(
           unitId: $unitId
           workspaceId: $workspaceId
           relationship: $relationship
         )
       }
     }`,
    input,
  );
}

export async function exportOrganizationSnapshot(
  request: APIRequestContext,
): Promise<{ schemaVersion: number; json: string }> {
  const data = await gqlRequest<{
    admin: { organizationExport: { schemaVersion: number; json: string } };
  }>(request, `query { admin { organizationExport { schemaVersion json } } }`);
  return data.admin.organizationExport;
}

export async function importOrganizationSnapshotDryRun(
  request: APIRequestContext,
  json: string,
): Promise<{
  errors: {
    source: string;
    row: number | null;
    field: string | null;
    message: string;
  }[];
}> {
  const data = await gqlRequest<{
    admin: {
      organizationImportDryRun: {
        errors: {
          source: string;
          row: number | null;
          field: string | null;
          message: string;
        }[];
      };
    };
  }>(
    request,
    `mutation Dry($json: String!) {
       admin { organizationImportDryRun(input: { json: $json }) {
         errors { source row field message }
       } }
     }`,
    { json },
  );
  return data.admin.organizationImportDryRun;
}
