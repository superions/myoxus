import type {
  DocumentMetadataIndexLookups,
  DocumentMetadataIndexRow,
  DocumentMetadataLookupKey,
} from "./services/document-metadata-cache";
import {
  formatRegionalDateTime,
  formatRegionalDate,
  type RegionalFormatPreferences,
} from "../i18n/regional-format";

import type {
  CanonicalMetadataKey,
  DocumentMetadataFieldDefinition,
  DocumentMetadataModel,
  DocumentMetadataValueDefinition,
  DocumentTypeDefinition,
} from "./types";

export const CANONICAL_METADATA_LABELS: Record<CanonicalMetadataKey, string> = {
  status: "Status",
  documentType: "Document type",
  version: "Version",
  responsible: "Responsible",
  reviewDueAt: "Review due at",
  validFrom: "Valid from",
  validUntil: "Valid until",
  classification: "Classification",
  documentNumber: "Document number",
  language: "Language",
  audience: "Audience",
  retentionPolicy: "Retention policy",
};

export const PROPERTY_METADATA_KEYS: CanonicalMetadataKey[] = [
  "status",
  "documentType",
  "version",
  "classification",
  "documentNumber",
  "language",
  "responsible",
  "audience",
  "reviewDueAt",
  "validFrom",
  "validUntil",
  "retentionPolicy",
];

export const HEADER_METADATA_KEYS: CanonicalMetadataKey[] = [
  "status",
  "documentType",
  "classification",
  "version",
  ...PROPERTY_METADATA_KEYS.filter(
    (key) =>
      !["status", "documentType", "classification", "version"].includes(key),
  ),
];

export const PRIMARY_PROPERTY_METADATA_KEYS: CanonicalMetadataKey[] = [
  "status",
  "documentType",
  "version",
  "classification",
  "documentNumber",
  "responsible",
  "reviewDueAt",
  "validUntil",
];

export const SECONDARY_PROPERTY_METADATA_KEYS: CanonicalMetadataKey[] =
  PROPERTY_METADATA_KEYS.filter(
    (key) => !PRIMARY_PROPERTY_METADATA_KEYS.includes(key),
  );

export const SYSTEM_LIST_METADATA_KEYS: CanonicalMetadataKey[] = [
  "status",
  "documentType",
  "version",
  "classification",
  "reviewDueAt",
  "validUntil",
];

export interface DocumentMetadataDisplayMessages {
  noStatus: string;
  noType: string;
  noVersion: string;
  notSet: string;
  unversionedChanges: string;
  changedSuffix: string;
  principal_one: string;
  principal_other: string;
}

const DEFAULT_DISPLAY_MESSAGES: DocumentMetadataDisplayMessages = {
  noStatus: "No status",
  noType: "No type",
  noVersion: "No version",
  notSet: "Not set",
  unversionedChanges: "Unversioned changes",
  changedSuffix: "changed",
  principal_one: "principal",
  principal_other: "principals",
};

export function definitionMap(definitions: DocumentMetadataFieldDefinition[]) {
  return new Map(definitions.map((definition) => [definition.key, definition]));
}

export function labelForDefinition(
  definitions: Map<string, DocumentMetadataFieldDefinition>,
  key: CanonicalMetadataKey,
): string {
  return definitions.get(key)?.label ?? CANONICAL_METADATA_LABELS[key];
}

function findValue(
  values: DocumentMetadataValueDefinition[],
  id: string | null | undefined,
) {
  if (!id) return null;
  return values.find((value) => value.id === id) ?? null;
}

function findType(
  types: DocumentTypeDefinition[],
  id: string | null | undefined,
) {
  if (!id) return null;
  return types.find((type) => type.id === id) ?? null;
}

export function displayValueForMetadataField(
  model: DocumentMetadataModel,
  key: CanonicalMetadataKey,
  messages: Partial<DocumentMetadataDisplayMessages> = {},
  regionalPreferences?: RegionalFormatPreferences,
): string {
  const m = { ...DEFAULT_DISPLAY_MESSAGES, ...messages };
  const { state, lookup } = model;

  switch (key) {
    case "status":
      return state.statusLabel ?? m.noStatus;
    case "documentType":
      return (
        state.typeLabel ??
        findType(lookup.documentTypes, state.typeId)?.label ??
        m.noType
      );
    case "version":
      if (!state.currentVersionLabel) {
        return state.dirtySinceCurrentVersion
          ? m.unversionedChanges
          : m.noVersion;
      }
      return `${state.currentVersionLabel}${state.dirtySinceCurrentVersion ? ` (${m.changedSuffix})` : ""}`;
    case "classification":
      return (
        state.classificationLabel ??
        findValue(
          lookup.valueDefinitions.classification,
          state.classificationId,
        )?.label ??
        m.notSet
      );
    case "retentionPolicy":
      return (
        state.retentionPolicyLabel ??
        findValue(
          lookup.valueDefinitions.retentionPolicy,
          state.retentionPolicyId,
        )?.label ??
        m.notSet
      );
    case "reviewDueAt":
      return formatDateTime(state.reviewDueAt, m.notSet, regionalPreferences);
    case "validFrom":
      return formatDateTime(state.validFrom, m.notSet, regionalPreferences);
    case "validUntil":
      return formatDateTime(state.validUntil, m.notSet, regionalPreferences);
    case "documentNumber":
      return state.documentNumber || m.notSet;
    case "language":
      return state.languageLabel || m.notSet;
    case "responsible": {
      const member = lookup.workspaceMembers.find(
        (member) => member.id === state.responsibleUserId,
      );
      return (
        member?.name || member?.email || state.responsibleUserId || m.notSet
      );
    }
    case "audience":
      return state.audienceLabels.length
        ? state.audienceLabels.join(", ")
        : m.notSet;
  }
}

export function hasDisplayValueForMetadataField(
  model: DocumentMetadataModel,
  key: CanonicalMetadataKey,
): boolean {
  const { state } = model;
  switch (key) {
    case "status":
      return Boolean(state.statusLabel || state.statusId);
    case "documentType":
      return Boolean(state.typeLabel || state.typeId);
    case "version":
      return Boolean(
        state.currentVersionLabel || state.dirtySinceCurrentVersion,
      );
    case "classification":
      return Boolean(state.classificationId);
    case "retentionPolicy":
      return Boolean(state.retentionPolicyId);
    case "reviewDueAt":
      return Boolean(state.reviewDueAt);
    case "validFrom":
      return Boolean(state.validFrom);
    case "validUntil":
      return Boolean(state.validUntil);
    case "documentNumber":
      return Boolean(state.documentNumber?.trim());
    case "language":
      return Boolean(state.languageLabel || state.languageId);
    case "responsible":
      return Boolean(state.responsibleUserId);
    case "audience":
      return Boolean(state.audienceIds.length);
  }
}

function formatDateTime(
  value: string | null | undefined,
  emptyLabel = "Not set",
  regionalPreferences?: RegionalFormatPreferences,
): string {
  if (!value) return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (regionalPreferences) {
    return formatRegionalDateTime(date, regionalPreferences);
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCsvIds(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const METADATA_FIELD_LABEL_KEYS = {
  status: "com.myoxus.document-metadata.field.status",
  documentType: "com.myoxus.document-metadata.field.document-type",
  version: "com.myoxus.document-metadata.field.version",
  responsible: "com.myoxus.document-metadata.field.responsible",
  reviewDueAt: "com.myoxus.document-metadata.field.review-due-at",
  validFrom: "com.myoxus.document-metadata.field.valid-from",
  validUntil: "com.myoxus.document-metadata.field.valid-until",
  classification: "com.myoxus.document-metadata.field.classification",
  documentNumber: "com.myoxus.document-metadata.field.document-number",
  language: "com.myoxus.document-metadata.field.language",
  audience: "com.myoxus.document-metadata.field.audience",
  retentionPolicy: "com.myoxus.document-metadata.field.retention-policy",
} as const satisfies Record<CanonicalMetadataKey, string>;

/** Native register columns share their labels with Explorer and export consumers. */
export const REGISTER_FIELD_LABEL_KEYS = {
  title: "Title",
  documentType: METADATA_FIELD_LABEL_KEYS.documentType,
  status: METADATA_FIELD_LABEL_KEYS.status,
  classification: METADATA_FIELD_LABEL_KEYS.classification,
  version: METADATA_FIELD_LABEL_KEYS.version,
  createdBy: "com.myoxus.page-properties.property.createdBy",
  responsible: METADATA_FIELD_LABEL_KEYS.responsible,
  createdAt: "com.myoxus.page-properties.property.createdAt",
  tags: "Tags",
  updatedAt: "com.myoxus.page-properties.property.updatedAt",
  reviewDueAt: METADATA_FIELD_LABEL_KEYS.reviewDueAt,
  validUntil: METADATA_FIELD_LABEL_KEYS.validUntil,
} as const;

export interface DocumentMetadataIndexDisplayMessages {
  loading: string;
  notSet: string;
  unversionedChanges: string;
  version: string;
  changedSuffix?: string;
}

const DEFAULT_INDEX_DISPLAY_MESSAGES: DocumentMetadataIndexDisplayMessages = {
  loading: "Loading",
  notSet: "Not set",
  unversionedChanges: "Unversioned changes",
  version: "Version",
  changedSuffix: "changed",
};

function indexDateValue(
  value: string | null | undefined,
  regionalPreferences?: RegionalFormatPreferences,
) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (regionalPreferences) {
    return formatRegionalDate(date, regionalPreferences);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    date,
  );
}

function metadataLookupKey(
  metadataKey: CanonicalMetadataKey,
): DocumentMetadataLookupKey | null {
  switch (metadataKey) {
    case "status":
    case "documentType":
    case "classification":
    case "version":
      return metadataKey;
    default:
      return null;
  }
}

export function metadataLookupHydrated(
  metadataKey: CanonicalMetadataKey,
  lookups: DocumentMetadataIndexLookups,
) {
  const lookupKey = metadataLookupKey(metadataKey);
  if (!lookupKey) return true;
  if (lookupKey === "version") return true;
  return lookups.hydratedKeys[lookupKey] === true;
}

export function metadataIndexDisplayValue(
  row: DocumentMetadataIndexRow,
  metadataKey: CanonicalMetadataKey,
  lookups: DocumentMetadataIndexLookups,
  messages = DEFAULT_INDEX_DISPLAY_MESSAGES,
  regionalPreferences?: RegionalFormatPreferences,
) {
  switch (metadataKey) {
    case "responsible":
      return row.responsibleName ?? null;
    case "status":
      return row.statusId ? (lookups.statusLabels[row.statusId] ?? null) : null;
    case "documentType":
      return row.documentTypeId
        ? (lookups.documentTypeLabels[row.documentTypeId] ?? null)
        : null;
    case "version":
      if (row.currentVersionId) {
        const label = lookups.versionLabels[row.currentVersionId];
        return label
          ? `${label}${row.dirtySinceCurrentVersion ? ` (${messages.changedSuffix ?? DEFAULT_INDEX_DISPLAY_MESSAGES.changedSuffix})` : ""}`
          : null;
      }
      return row.dirtySinceCurrentVersion ? messages.unversionedChanges : null;
    case "classification":
      return row.classificationId
        ? (lookups.classificationLabels[row.classificationId] ?? null)
        : null;
    case "reviewDueAt":
      return indexDateValue(row.reviewDueAt, regionalPreferences);
    case "validUntil":
      return indexDateValue(row.validUntil, regionalPreferences);
    default:
      return null;
  }
}

export function documentMetadataGroupLabel(
  groupId: string,
  metadataKey: CanonicalMetadataKey,
  lookups: DocumentMetadataIndexLookups,
  messages = DEFAULT_INDEX_DISPLAY_MESSAGES,
  regionalPreferences?: RegionalFormatPreferences,
) {
  if (!groupId) return messages.notSet;
  switch (metadataKey) {
    case "status":
      return lookups.statusLabels[groupId] ?? messages.loading;
    case "documentType":
      return lookups.documentTypeLabels[groupId] ?? messages.loading;
    case "version":
      return lookups.versionLabels[groupId] ?? messages.version;
    case "classification":
      return lookups.classificationLabels[groupId] ?? messages.loading;
    case "reviewDueAt":
    case "validUntil":
      return indexDateValue(groupId, regionalPreferences) ?? messages.notSet;
    default:
      return messages.notSet;
  }
}
