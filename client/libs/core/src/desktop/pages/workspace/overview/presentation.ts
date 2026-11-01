// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkspaceOverviewRegisterPresentationFieldsFragment } from "@myoxus/graphql";

export type OverviewRegisterPresentation =
  WorkspaceOverviewRegisterPresentationFieldsFragment;

/** Canonical system properties admitted by the native overview settings owner. */
export const overviewRegisterProperties = [
  "title",
  "documentType",
  "status",
  "classification",
  "version",
  "createdBy",
  "createdAt",
  "tags",
  "updatedAt",
  "reviewDueAt",
  "validUntil",
] as const;

export const defaultOverviewRegisterPresentation: OverviewRegisterPresentation =
  {
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
        ]
      : null,
  );
