// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { isSupportedSystemPropertyType } from "@myoxus/core/components/system-property-types";
import { OrderByName } from "@myoxus/core/components/explorer/display-menu/order";
import { metadataIndexDisplayValue } from "@myoxus/core/components/system-property-types/document-metadata";
import { TagItem } from "@myoxus/core/components/tags/tag";
import type { DocumentMetadataIndexLookups } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import type { CanonicalMetadataKey } from "@myoxus/core/modules/document-metadata/types";
import { formatRegionalDateTime } from "@myoxus/core/modules/i18n";
import { isWorkspaceTagColorRole } from "@myoxus/core/modules/tag/color-role";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import type { WorkspaceOverviewQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { FileIcon } from "@myoxus/icons/react";
import {
  BadgeList,
  BadgeListItem,
  Group,
  MyoxusText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  Text,
} from "@myoxus/ui-facade";
import { useMemo } from "react";
import { defaultOverviewRegisterPresentation } from "./presentation";

type Page = NonNullable<
  NonNullable<WorkspaceOverviewQuery["workspace"]>["overview"]
>;
type Document = Page["documents"][number];

/** Read-only cells over the native admitted page. Sorting, membership, labels
 * and pagination stay with its server owner; cells never hydrate editor models.
 */
export function WorkspaceOverviewRegister({
  page,
  workspaceId,
}: {
  page: Page;
  workspaceId: string;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const { jumpToWorkspaceResource } = useNavigateHelper();
  const columns = (
    page.registerPresentation ?? defaultOverviewRegisterPresentation
  ).displayProperties
    .map((key) => key.slice("system:".length))
    .filter(isSupportedSystemPropertyType);
  const lookups = useMemo<DocumentMetadataIndexLookups>(() => {
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
    for (const document of page.documents) {
      const row = document.metadata,
        labels = document.metadataLabels;
      if (!row || !labels) continue;
      if (row.statusId && labels.statusLabel)
        result.statusLabels[row.statusId] = labels.statusLabel;
      if (row.documentTypeId && labels.documentTypeLabel)
        result.documentTypeLabels[row.documentTypeId] =
          labels.documentTypeLabel;
      if (row.currentVersionId && labels.versionLabel)
        result.versionLabels[row.currentVersionId] = labels.versionLabel;
      if (row.classificationId && labels.classificationLabel)
        result.classificationLabels[row.classificationId] =
          labels.classificationLabel;
    }
    return result;
  }, [page.documents]);
  const messages = {
    loading: t["com.myoxus.document-metadata.loading"](),
    notSet: t["com.myoxus.document-metadata.value.not-set"](),
    unversionedChanges:
      t["com.myoxus.document-metadata.value.unversioned-changes"](),
    version: t["Version"](),
    changedSuffix: t["com.myoxus.document-metadata.value.changed"](),
  };
  const time = (value: string | null | undefined) =>
    value ? (
      <MyoxusText
        component="time"
        typographySlot="caption"
        tone="secondary"
        textWrap="nowrap"
        dateTime={value}
      >
        {formatRegionalDateTime(value, regionalPreferences)}
      </MyoxusText>
    ) : (
      "–"
    );
  const value = (document: Document, column: string) => {
    switch (column) {
      case "title":
        return (
          <Group align="flex-start" wrap="nowrap">
            <FileIcon aria-hidden="true" />
            {document.resource.workspaceId === workspaceId ? (
              <Text
                component={WorkbenchLink}
                to={`/${encodeURIComponent(document.resource.id)}`}
              >
                {document.title || t["Untitled"]()}
              </Text>
            ) : (
              <Text
                component="a"
                href={`/workspace/${encodeURIComponent(document.resource.workspaceId)}/${encodeURIComponent(document.resource.id)}`}
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    jumpToWorkspaceResource(document.resource);
                  }
                }}
              >
                {document.title || t["Untitled"]()}
              </Text>
            )}
          </Group>
        );
      case "createdBy":
        return document.createdByName || "–";
      case "createdAt":
        return time(document.createdAt);
      case "updatedAt":
        return time(document.updatedAt);
      case "tags":
        return document.tags.length ? (
          <BadgeList>
            {document.tags.map((tag) => {
              if (!isWorkspaceTagColorRole(tag.colorRole))
                throw new Error("Unsupported workspace tag color role");
              return (
                <BadgeListItem key={tag.id}>
                  <TagItem
                    mode="list-tag"
                    tag={{
                      id: tag.id,
                      name: tag.name,
                      color: tag.colorRole,
                      archived: tag.archived,
                    }}
                  />
                </BadgeListItem>
              );
            })}
          </BadgeList>
        ) : (
          "–"
        );
      default:
        return document.metadata
          ? metadataIndexDisplayValue(
              document.metadata,
              column as CanonicalMetadataKey,
              lookups,
              messages,
              regionalPreferences,
            ) || "–"
          : "–";
    }
  };
  return (
    <TableScrollContainer containInlineSize>
      <Table highlightOnHover>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column}>
                {<OrderByName orderBy={{ type: "system", key: column }} />}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.documents.map((document) => (
            <TableRow
              key={`${document.resource.workspaceId}:${document.resource.id}`}
            >
              {columns.map((column) => (
                <TableCell key={column}>{value(document, column)}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScrollContainer>
  );
}
