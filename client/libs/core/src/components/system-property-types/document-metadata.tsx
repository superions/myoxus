import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import type { FilterParams } from "../../modules/collection-rules";
import { DocumentMetadataCacheService } from "../../modules/document-metadata/services/document-metadata-cache";
import type { CanonicalMetadataKey } from "../../modules/document-metadata/types";
import {
  displayValueForMetadataField,
  metadataLookupHydrated,
  metadataIndexDisplayValue,
  documentMetadataGroupLabel,
  type DocumentMetadataIndexDisplayMessages,
} from "../../modules/document-metadata/utils";
import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { TextFilterValue } from "../workspace-property-types/text";

function displayMessages(
  t: ReturnType<typeof useI18n>,
): DocumentMetadataIndexDisplayMessages {
  return {
    loading: t["com.myoxus.document-metadata.loading"](),
    notSet: t["com.myoxus.document-metadata.value.not-set"](),
    unversionedChanges:
      t["com.myoxus.document-metadata.value.unversioned-changes"](),
    version: t["com.myoxus.document-metadata.field.version"](),
    changedSuffix: t["com.myoxus.document-metadata.value.changed"](),
  };
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

export const DocumentResponsibleDocListProperty = ({
  doc,
}: {
  doc: { id: string };
}) => (
  <DocumentMetadataInlineProperty docId={doc.id} metadataKey="responsible" />
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
