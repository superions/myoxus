/**
 * Format Adapters — Template Registry
 *
 * Translates raw GraphQL response shapes into domain view-models consumed by
 * tab components.  Components must NOT import raw GraphQL response types
 * directly — use these adapters so that upstream schema changes are absorbed
 * in a single place.
 *
 * All functions are pure (no side-effects, no React dependencies) so they can
 * be tested without rendering anything.
 */

import {
  RevisionStateType,
  type TemplateAssignmentsQuery,
  type TemplateCatalogQuery,
  type TemplateDefaultPoliciesQuery,
  type TemplateJobsQuery,
  type TemplateRevisionsQuery,
  TemplateSourceType,
  TemplateStatusType,
} from "@myoxus/graphql";

// ---------------------------------------------------------------------------
// Raw element aliases (derived from generated query types)
// ---------------------------------------------------------------------------

type RawCatalogEntry = TemplateCatalogQuery["admin"]["templateCatalog"][number];

type RawAssignment =
  TemplateAssignmentsQuery["admin"]["templateAssignments"][number];

type RawRevision = TemplateRevisionsQuery["admin"]["templateRevisions"][number];

type RawJob = TemplateJobsQuery["admin"]["templateJobs"][number];

type RawDefaultPolicy =
  TemplateDefaultPoliciesQuery["admin"]["templateDefaultPolicies"][number];

// ---------------------------------------------------------------------------
// Domain view-models
// ---------------------------------------------------------------------------

/** Catalog entry as consumed by CatalogTab and ArchiveTab. */
export interface CatalogEntryViewModel {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  /** Normalised to PascalCase TemplateStatusType so badge components work without casts. */
  status: TemplateStatusType;
  /** Whether this template was uploaded via bundle or registered as a code-built builtin. */
  source: TemplateSourceType;
  /** Minimum client version required to apply this template. */
  minClientVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Assignment (workspace template policy) as consumed by AssignmentsTab. */
export interface AssignmentViewModel {
  id: string;
  workspaceId: string;
  templateId: string;
  selectionMode: string;
  selectedRevisionId: string | null;
  provisioningMode: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Revision as consumed by VersionsTab. */
export interface RevisionViewModel {
  id: string;
  templateId: string;
  version: string;
  /** Preserve the generated GraphQL enum for lifecycle actions and badges. */
  state: RevisionStateType;
  checksum: string | null;
  releaseNotes: string | null;
  createdAt: string;
  publishedAt: string | null;
  createdBy: string | null;
}

/** Default policy as consumed by DefaultPoliciesTab. */
export interface DefaultPolicyViewModel {
  templateId: string;
  applyToNewWorkspaces: boolean;
  selectionMode: string;
  provisioningMode: string;
  createdAt: string;
  updatedAt: string;
}

/** Job record as consumed by JobsTab. */
export interface JobViewModel {
  id: string;
  /** Normalised to uppercase string (IMPORT | RECONCILE). */
  jobType: string;
  /** Normalised to uppercase string. */
  state: string;
  templateId: string | null;
  workspaceId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summaryJson: string | null;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Adapts a single raw catalog entry from the GraphQL response into the
 * CatalogEntryViewModel used by CatalogTab and ArchiveTab.
 */
export function adaptCatalogEntry(raw: RawCatalogEntry): CatalogEntryViewModel {
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    description: raw.description ?? null,
    category: raw.category ?? null,
    tags: raw.tags ?? [],
    status: raw.status ?? TemplateStatusType.Active,
    source: raw.source ?? TemplateSourceType.Bundle,
    minClientVersion: raw.minClientVersion ?? 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    archivedAt: raw.archivedAt ?? null,
  };
}

/**
 * Adapts an array of raw catalog entries from the GraphQL response.
 */
export function adaptCatalogEntries(
  raw: RawCatalogEntry[],
): CatalogEntryViewModel[] {
  return raw.map(adaptCatalogEntry);
}

/**
 * Adapts a single workspace template assignment.
 */
export function adaptAssignment(raw: RawAssignment): AssignmentViewModel {
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    templateId: raw.templateId,
    selectionMode: String(raw.selectionMode),
    selectedRevisionId: raw.selectedRevisionId ?? null,
    provisioningMode: String(raw.provisioningMode),
    isEnabled: raw.isEnabled,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Adapts an array of workspace template assignments.
 */
export function adaptAssignments(raw: RawAssignment[]): AssignmentViewModel[] {
  return raw.map(adaptAssignment);
}

/**
 * Adapts a single template revision.
 */
export function adaptRevision(raw: RawRevision): RevisionViewModel {
  return {
    id: raw.id,
    templateId: raw.templateId,
    version: raw.version,
    state: raw.state,
    checksum: raw.checksum ?? null,
    releaseNotes: raw.releaseNotes ?? null,
    createdAt: raw.createdAt,
    publishedAt: raw.publishedAt ?? null,
    createdBy: raw.createdBy ?? null,
  };
}

/**
 * Adapts an array of template revisions.
 */
export function adaptRevisions(raw: RawRevision[]): RevisionViewModel[] {
  return raw.map(adaptRevision);
}

/**
 * Adapts a single template job.
 */
export function adaptJob(raw: RawJob): JobViewModel {
  return {
    id: raw.id,
    jobType: String(raw.jobType),
    state: String(raw.state),
    templateId: raw.templateId ?? null,
    workspaceId: raw.workspaceId ?? null,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null,
    summaryJson: raw.summaryJson ?? null,
  };
}

/**
 * Adapts an array of template jobs.
 */
export function adaptJobs(raw: RawJob[]): JobViewModel[] {
  return raw.map(adaptJob);
}

/**
 * Adapts a single template default policy.
 */
export function adaptDefaultPolicy(
  raw: RawDefaultPolicy,
): DefaultPolicyViewModel {
  return {
    templateId: raw.templateId,
    applyToNewWorkspaces: raw.applyToNewWorkspaces,
    selectionMode: String(raw.selectionMode),
    provisioningMode: String(raw.provisioningMode),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/**
 * Adapts an array of template default policies.
 */
export function adaptDefaultPolicies(
  raw: RawDefaultPolicy[],
): DefaultPolicyViewModel[] {
  return raw.map(adaptDefaultPolicy);
}
