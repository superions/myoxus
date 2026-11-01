// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { CollectionRulesService } from "@myoxus/core/modules/collection-rules";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { TagService } from "../service/tag";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  EmptyState,
  EmptyStateTitle,
  Loading,
  Notice,
  Stack,
  SurfaceList,
  SurfaceListHeader,
  SurfaceListHeaderTitle,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { memo, useEffect, useState } from "react";

export function useTagDocumentIds(tagId: string) {
  const collectionRules = useService(CollectionRulesService);
  const tagList = useService(TagService).tagList;
  const usages = useLiveData(tagList.documentUsageState$(tagId));
  const [documentIds, setDocumentIds] = useState<string[]>([]);

  useEffect(() => {
    setDocumentIds([]);
    const subscription = collectionRules
      .watch({
        filters: [
          {
            type: "system",
            key: "empty-journal",
            method: "is",
            value: "false",
          },
          { type: "system", key: "trash", method: "is", value: "false" },
        ],
        orderBy: { type: "system", key: "updatedAt", desc: true },
      })
      .subscribe({
        next: (result) => {
          setDocumentIds([
            ...new Set(result.groups.flatMap((group) => group.items)),
          ]);
        },
        error: (error) => console.error(error),
      });
    return () => subscription.unsubscribe();
  }, [collectionRules, tagId]);

  return documentIds.filter((id) => usages.ids?.includes(id));
}

const TagDocumentUsageRow = memo(function TagDocumentUsageRow({
  docId,
}: {
  docId: string;
}) {
  const displayMeta = useService(DocDisplayMetaService);
  const title = useLiveData(displayMeta.title$(docId));
  const Icon = useLiveData(displayMeta.icon$(docId));
  return (
    <SurfaceListItemFrame component={WorkbenchLink} to={`/${docId}`}>
      <SurfaceListItem
        alignItems="center"
        component="div"
        density="compact"
        interactive
        layout="row"
        role="presentation"
      >
        <SurfaceListItemIcon size="md">
          <Icon />
        </SurfaceListItemIcon>
        <SurfaceListItemMain grow>
          <SurfaceListText kind="title">{title}</SurfaceListText>
        </SurfaceListItemMain>
      </SurfaceListItem>
    </SurfaceListItemFrame>
  );
});

export function TagUsageList({
  tagId,
  workspaceId,
}: {
  tagId: string;
  workspaceId: string | null;
}) {
  const t = useI18n();
  const documentIds = useTagDocumentIds(tagId);
  const tagList = useService(TagService).tagList;
  const documents = useLiveData(tagList.documentUsageState$(tagId));
  const database = useLiveData(tagList.databaseUsageState$(tagId));
  const databaseRows = database.rows;
  const error = documents.error ?? database.error;
  const loadingMore = database.status === "loading";
  const loadMore = () => tagList.loadMoreDatabaseUsages(tagId);
  const hasMore = database.hasMore;
  const empty = documentIds.length === 0 && databaseRows.length === 0;

  if (
    workspaceId &&
    (documents.status === "loading" || database.status === "loading") &&
    !error
  ) {
    return (
      <Notice title={t["Loading"]()}>
        <Loading />
      </Notice>
    );
  }
  const errorNotice = error ? (
    <Notice
      title={t["com.myoxus.database.selector.error-title"]()}
      tone="error"
    >
      {t["com.myoxus.database.selector.error-description"]()}
      <Button
        variant="secondary"
        onClick={() => {
          void tagList.retryCatalog();
        }}
      >
        {t["Retry"]()}
      </Button>
    </Notice>
  ) : null;
  if (empty && !error) {
    return (
      <EmptyState
        title={
          <EmptyStateTitle>
            {t["com.myoxus.selectPage.empty"]()}
          </EmptyStateTitle>
        }
      />
    );
  }

  return (
    <Stack>
      {errorNotice}
      {documentIds.length > 0 ? (
        <SurfaceList label={t["com.myoxus.workspace-pages.kind.documents"]()}>
          <SurfaceListHeader density="section">
            <SurfaceListHeaderTitle typographySlot="label-compact">
              {t["com.myoxus.workspace-pages.kind.documents"]()}
            </SurfaceListHeaderTitle>
            <Badge surface="floating" tone="neutral">
              {documentIds.length}
            </Badge>
          </SurfaceListHeader>
          {documentIds.map((docId) => (
            <TagDocumentUsageRow key={docId} docId={docId} />
          ))}
        </SurfaceList>
      ) : null}
      {databaseRows.length > 0 ? (
        <SurfaceList label={t["com.myoxus.workspace-pages.kind.databases"]()}>
          <SurfaceListHeader density="section">
            <SurfaceListHeaderTitle typographySlot="label-compact">
              {t["com.myoxus.workspace-pages.kind.databases"]()}
            </SurfaceListHeaderTitle>
            <Badge surface="floating" tone="neutral">
              {databaseRows.length}
            </Badge>
          </SurfaceListHeader>
          {databaseRows.map((usage) => (
            <SurfaceListItemFrame
              key={`${usage.databaseId}:${usage.rowId}`}
              component={WorkbenchLink}
              to={`/databases/${usage.databaseId}?rowId=${usage.rowId}`}
            >
              <SurfaceListItem
                alignItems="center"
                component="div"
                density="compact"
                interactive
                layout="row"
                role="presentation"
              >
                <SurfaceListItemIcon size="md">
                  <DatabaseIcon />
                </SurfaceListItemIcon>
                <SurfaceListItemMain grow>
                  <SurfaceListText kind="title">
                    {usage.rowTitle}
                  </SurfaceListText>
                  <SurfaceListText kind="description">
                    {usage.databaseTitle}
                  </SurfaceListText>
                </SurfaceListItemMain>
              </SurfaceListItem>
            </SurfaceListItemFrame>
          ))}
          {hasMore ? (
            <Button
              loading={Boolean(loadingMore)}
              onClick={loadMore}
              variant="secondary"
            >
              {t["com.myoxus.database.load-more"]()}
            </Button>
          ) : null}
        </SurfaceList>
      ) : null}
    </Stack>
  );
}
