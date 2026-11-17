// SPDX-License-Identifier: AGPL-3.0-or-later

import { REGISTER_FIELD_LABEL_KEYS } from "@myoxus/core/modules/document-metadata/utils";

import type { DocumentMetadataIndexLookups } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";

import type {
  WorkspaceOverviewQuery,
  WorkspaceOverviewRegisterPresentationFieldsFragment,
} from "@myoxus/graphql";

export type OverviewRegisterPresentation =
  WorkspaceOverviewRegisterPresentationFieldsFragment;

/** Canonical system properties admitted by the native overview settings owner. */
export const overviewRegisterProperties = Object.keys(
  REGISTER_FIELD_LABEL_KEYS,
) as (keyof typeof REGISTER_FIELD_LABEL_KEYS)[];

export const defaultOverviewRegisterPresentation: OverviewRegisterPresentation =
  {
    selection: { subtree: false, tagIds: [], matchAllTags: false, filters: [] },
    displayProperties: [
      "system:title",
      "system:documentType",
      "system:status",
      "system:version",
      "system:createdBy",
      "system:createdAt",
      "system:tags",
      "system:updatedAt",
    ],
    orderBy: { type: "system", key: "updatedAt", desc: true },
  };

export const overviewPresentationKey = (
  value: OverviewRegisterPresentation | null | undefined,
) =>
  JSON.stringify(
    value
      ? [
          value.displayProperties,
          value.orderBy.type,
          value.orderBy.key,
          value.orderBy.desc,
          value.selection,
        ]
      : null,
  );

/** Shared page-local label maps; register and exported report cells use the same formatter. */
export function registerMetadataLookups(
  documents: NonNullable<
    NonNullable<WorkspaceOverviewQuery["workspace"]>["overview"]
  >["documents"],
): DocumentMetadataIndexLookups {
  const result: DocumentMetadataIndexLookups = {
    statusLabels: {},
    documentTypeLabels: {},
    versionLabels: {},
    classificationLabels: {},
    hydratedKeys: {
      status: true,
      documentType: true,
      version: true,
      classification: true,
    },
  };
  for (const document of documents) {
    const row = document.metadata,
      labels = document.metadataLabels;
    if (!row || !labels) continue;
    if (row.statusId && labels.statusLabel)
      result.statusLabels[row.statusId] = labels.statusLabel;
    if (row.documentTypeId && labels.documentTypeLabel)
      result.documentTypeLabels[row.documentTypeId] = labels.documentTypeLabel;
    if (row.currentVersionId && labels.versionLabel)
      result.versionLabels[row.currentVersionId] = labels.versionLabel;
    if (row.classificationId && labels.classificationLabel)
      result.classificationLabels[row.classificationId] =
        labels.classificationLabel;
  }
  return result;
}

/** The persisted native block shape is unchanged; both consumers use one register contract. */
export function documentIndexPresentation(
  query: import("@virgultum/core/models").DocumentIndexQuery,
  displayProperties: string[] = ["system:title"],
): OverviewRegisterPresentation {
  return {
    displayProperties,
    orderBy: query.orderBy ?? { type: "system", key: "organizer", desc: false },
    selection: {
      subtree: query.subtree,
      tagIds: query.tagIds,
      matchAllTags: query.matchAllTags,
      filters: query.filters.map((filter) => ({
        ...filter,
        value: filter.value ?? null,
      })),
    },
  };
}

export function overviewPresentationIncomplete(
  value: OverviewRegisterPresentation,
) {
  return value.selection.filters.some(
    (filter) => !filter.method.includes("empty") && !filter.value,
  );
}
