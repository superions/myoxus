import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { formatRegionalDate } from "@myoxus/core/modules/i18n";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import type { FilterParams } from "../../modules/collection-rules";
import {
  DocumentMetadataCacheService,
  type DocumentMetadataIndexLookups,
  type DocumentMetadataIndexRow,
  type DocumentMetadataLookupKey,
} from "../../modules/document-metadata/services/document-metadata-cache";
import type { CanonicalMetadataKey } from "../../modules/document-metadata/types";
import { displayValueForMetadataField } from "../../modules/document-metadata/utils";
import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { TextFilterValue } from "../workspace-property-types/text";

interface DocumentMetadataDisplayMessages {
  loading: string;
  notSet: string;
  unversionedChanges: string;
  version: string;
  changedSuffix?: string;
}

const DEFAULT_DISPLAY_MESSAGES: DocumentMetadataDisplayMessages = {
  loading: "Loading",
  notSet: "Not set",
  unversionedChanges: "Unversioned changes",
  version: "Version",
  changedSuffix: "changed",
};

function displayMessages(
  t: ReturnType<typeof useI18n>,
): DocumentMetadataDisplayMessages {
  return {
    loading: t["com.myoxus.document-metadata.loading"](),
    notSet: t["com.myoxus.document-metadata.value.not-set"](),
    unversionedChanges:
      t["com.myoxus.document-metadata.value.unversioned-changes"](),
    version: t["com.myoxus.document-metadata.field.version"](),
    changedSuffix: t["com.myoxus.document-metadata.value.changed"](),
  };
}

function indexDateValue(
  value: string | null | undefined,
  regionalPreferences?: ReturnType<typeof useRegionalPreferences>,
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
  messages = DEFAULT_DISPLAY_MESSAGES,
  regionalPreferences?: ReturnType<typeof useRegionalPreferences>,
) {
  switch (metadataKey) {
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
          ? `${label}${row.dirtySinceCurrentVersion ? ` (${messages.changedSuffix ?? DEFAULT_DISPLAY_MESSAGES.changedSuffix})` : ""}`
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
  messages = DEFAULT_DISPLAY_MESSAGES,
  regionalPreferences?: ReturnType<typeof useRegionalPreferences>,
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

function DocumentMetadataInlineProperty({
  docId,
  metadataKey,
}: {
  docId: string;
  metadataKey: CanonicalMetadataKey;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const cacheService = useService(DocumentMetadataCacheService);
  const listModelOverrides = useLiveData(
    cacheService.watchListModelOverrides(),
  );
  const indexRows = useLiveData(cacheService.watchIndexRows());
  const lookups = useLiveData(cacheService.watchIndexLookups());
  const messages = displayMessages(t);
  const lookupHydrated = metadataLookupHydrated(metadataKey, lookups);
  const acknowledgedWrite = listModelOverrides.size
    ? cacheService.getListModelOverride(docId)
    : null;
  const indexRow = cacheService.getIndexRowByExternalId(docId);

  useEffect(() => {
    const tasks: Array<Promise<unknown>> = [];
    if (indexRows.length === 0) tasks.push(cacheService.hydrateIndex());
    if (!lookupHydrated) tasks.push(cacheService.hydrateIndexLookups());
    if (tasks.length) {
      Promise.all(tasks).catch((error) => {
        console.warn("[document-metadata] doc-list index hydration failed", {
          docId,
          metadataKey,
          error,
        });
      });
    }
  }, [cacheService, docId, indexRows.length, lookupHydrated, metadataKey]);

  const label = acknowledgedWrite
    ? displayValueForMetadataField(
        acknowledgedWrite,
        metadataKey,
        undefined,
        regionalPreferences,
      )
    : (indexRow &&
        metadataIndexDisplayValue(
          indexRow,
          metadataKey,
          lookups,
          messages,
          regionalPreferences,
        )) ||
      "-";

  return <StackProperty icon={null}>{label}</StackProperty>;
}

export const DocumentStatusDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => <DocumentMetadataInlineProperty docId={doc.id} metadataKey="status" />;

export const DocumentTypeDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => (
  <DocumentMetadataInlineProperty docId={doc.id} metadataKey="documentType" />
);

export const DocumentVersionDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => <DocumentMetadataInlineProperty docId={doc.id} metadataKey="version" />;

export const DocumentClassificationDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => (
  <DocumentMetadataInlineProperty docId={doc.id} metadataKey="classification" />
);

export const DocumentReviewDueAtDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => (
  <DocumentMetadataInlineProperty docId={doc.id} metadataKey="reviewDueAt" />
);

export const DocumentValidUntilDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => (
  <DocumentMetadataInlineProperty docId={doc.id} metadataKey="validUntil" />
);

function DocumentMetadataGroupHeader({
  groupId,
  docCount,
  metadataKey,
}: GroupHeaderProps & { metadataKey: CanonicalMetadataKey }) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const cacheService = useService(DocumentMetadataCacheService);
  const lookups = useLiveData(cacheService.watchIndexLookups());
  const messages = displayMessages(t);
  const lookupHydrated = metadataLookupHydrated(metadataKey, lookups);
  useEffect(() => {
    if (!lookupHydrated) {
      cacheService.hydrateIndexLookups().catch((error) => {
        console.warn("[document-metadata] group lookup hydration failed", {
          metadataKey,
          error,
        });
      });
    }
  }, [cacheService, lookupHydrated, metadataKey]);

  return (
    <PlainTextDocGroupHeader
      docCount={docCount}
      groupId={documentMetadataGroupLabel(
        groupId,
        metadataKey,
        lookups,
        messages,
        regionalPreferences,
      )}
    />
  );
}

export const DocumentStatusGroupHeader = (props: GroupHeaderProps) => (
  <DocumentMetadataGroupHeader {...props} metadataKey="status" />
);

export const DocumentTypeGroupHeader = (props: GroupHeaderProps) => (
  <DocumentMetadataGroupHeader {...props} metadataKey="documentType" />
);

export const DocumentVersionGroupHeader = (props: GroupHeaderProps) => (
  <DocumentMetadataGroupHeader {...props} metadataKey="version" />
);

export const DocumentClassificationGroupHeader = (props: GroupHeaderProps) => (
  <DocumentMetadataGroupHeader {...props} metadataKey="classification" />
);

export const DocumentReviewDueAtGroupHeader = (props: GroupHeaderProps) => (
  <DocumentMetadataGroupHeader {...props} metadataKey="reviewDueAt" />
);

export const DocumentValidUntilGroupHeader = (props: GroupHeaderProps) => (
  <DocumentMetadataGroupHeader {...props} metadataKey="validUntil" />
);

export function DocumentMetadataFilterValue({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onChange?: (filter: FilterParams) => void;
}) {
  return (
    <TextFilterValue
      filter={filter}
      isDraft={isDraft}
      onDraftCompleted={onDraftCompleted}
      onChange={onChange}
    />
  );
}
