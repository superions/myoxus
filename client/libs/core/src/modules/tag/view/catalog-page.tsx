// SPDX-License-Identifier: AGPL-3.0-or-later
import { getArtworkUrl } from "@myoxus/theme/artwork";
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard/use-guard";
import {
  TagEditMenu,
  type TagMetadataUpdate,
  useWorkspaceTagColorOptions,
  useWorkspaceTagCommands,
} from "@myoxus/core/components/tags";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { MoreHorizontalIcon, PlusIcon, TagsIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Alert,
  Badge,
  Button,
  ColorSwatch,
  EmptyState,
  ThemedImg,
  EmptyStateTitle,
  Group,
  IconButton,
  Loading,
  MyoxusTextInput,
  PageContentRail,
  Select,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListSpacer,
  SurfaceListText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  type TagColorRole,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitle,
  ViewSwitcher,
  useResponsiveSmQuery,
} from "@myoxus/ui-facade";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { TagService } from "../service/tag";
import { TagMetadataModal } from "./tag-metadata-modal";

export type TagCatalogStatus = "active" | "archived" | "all";
export type TagCatalogSort =
  | "name-asc"
  | "name-desc"
  | "updated-desc"
  | "updated-asc"
  | "usage-desc"
  | "usage-asc";

export type TagCatalogRow = {
  id: string;
  name: string;
  description: string;
  color: TagColorRole;
  archived: boolean;
  updatedAt: number;
  documentCount: number;
  databaseRowCount: number;
};

export function resolveTagCatalogViewState({
  error,
  isLoading,
  totalCount,
  visibleCount,
}: {
  error: unknown;
  isLoading: boolean;
  totalCount: number;
  visibleCount: number;
}) {
  return {
    body: isLoading
      ? ("loading" as const)
      : visibleCount > 0
        ? ("rows" as const)
        : totalCount > 0
          ? ("no-results" as const)
          : ("empty" as const),
    showError: Boolean(error),
  };
}

export function selectTagCatalogRows(
  rows: readonly TagCatalogRow[],
  search: string,
  status: TagCatalogStatus,
  sort: TagCatalogSort,
) {
  const needle = search.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => {
    if (status === "active" && row.archived) return false;
    if (status === "archived" && !row.archived) return false;
    if (!needle) return true;
    return `${row.name}\n${row.description}`
      .toLocaleLowerCase()
      .includes(needle);
  });

  return filtered.sort((left, right) => {
    const name = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
    const updated = left.updatedAt - right.updatedAt;
    const leftUsage = left.documentCount + left.databaseRowCount;
    const rightUsage = right.documentCount + right.databaseRowCount;
    const usage = leftUsage - rightUsage;
    const primary =
      sort === "name-asc"
        ? name
        : sort === "name-desc"
          ? -name
          : sort === "updated-desc"
            ? -updated
            : sort === "updated-asc"
              ? updated
              : sort === "usage-desc"
                ? -usage
                : usage;
    return primary || left.id.localeCompare(right.id);
  });
}

export function stopTagCatalogRowAction(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
}

function useTagCatalog() {
  const tagList = useService(TagService).tagList;
  const state = useLiveData(tagList.catalogWithCountsState$);
  const rows: TagCatalogRow[] = state.tags.map((tag) => ({
    id: tag.id,
    name: tag.value,
    description: tag.description ?? "",
    color: tag.color,
    archived: tag.archived ?? false,
    updatedAt:
      tag.updateDate instanceof Date
        ? tag.updateDate.getTime()
        : (tag.updateDate ?? 0),
    documentCount: tag.documentCount ?? 0,
    databaseRowCount: tag.databaseRowCount ?? 0,
  }));
  return {
    error: state.error,
    isLoading: state.status === "loading",
    mutate: () => tagList.retryCatalog(),
    rows,
  };
}

function TagCatalogHeader({ onCreate }: { onCreate: () => void }) {
  const t = useI18n();
  // The server authorizes tag lifecycle as workspace-visible document
  // metadata through Workspace_CreateDoc. Mirroring that capability here
  // avoids presenting controls that the authoritative service will reject.
  const canCreateTag = useGuard("Workspace_CreateDoc");
  const state = useLiveData(useService(TagService).tagList.catalogState$);
  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="tag-catalog-header-frame"
      title={<WorkbenchHeaderTitle>{t["Tags"]()}</WorkbenchHeaderTitle>}
      right={
        canCreateTag && state.status === "ready" ? (
          <IconButton
            icon={<PlusIcon />}
            aria-label={t["com.myoxus.rootAppSidebar.tags.new-tag"]()}
            tooltip={t["com.myoxus.rootAppSidebar.tags.new-tag"]()}
            onClick={onCreate}
          />
        ) : null
      }
    />
  );
}

function TagCatalogMenu({
  row,
  onChanged,
}: {
  row: TagCatalogRow;
  onChanged: () => void;
}) {
  const t = useI18n();
  const commands = useWorkspaceTagCommands();
  const colors = useWorkspaceTagColorOptions();
  const canChangeTag = useGuard("Workspace_CreateDoc");
  const state = useLiveData(useService(TagService).tagList.catalogState$);
  const canDeleteTag = useGuard("Workspace_Properties_Delete");
  const tag = {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    archived: row.archived,
  };

  if (
    state.status !== "ready" ||
    (!canChangeTag && !(row.archived && canDeleteTag))
  )
    return null;

  return (
    <TagEditMenu
      colors={colors}
      canEdit={canChangeTag}
      canDeletePermanently={canDeleteTag}
      onTagUpdate={async (_tagId, metadata: TagMetadataUpdate) => {
        const changed = await commands.updateTag(row.id, metadata);
        if (changed) onChanged();
        return changed;
      }}
      onTagArchive={(tagId) => {
        void commands.archiveTags([tagId]).then((changed) => {
          if (changed) onChanged();
        });
      }}
      onTagDeletePermanently={(tagId) => {
        return commands.deleteTagPermanently(tagId).then((changed) => {
          if (changed) onChanged();
          return changed;
        });
      }}
      onTagRestore={(tagId) => {
        void commands.restoreTag(tagId).then((changed) => {
          if (changed) onChanged();
        });
      }}
      tag={tag}
    >
      <IconButton
        aria-label={`${row.name}: ${t["com.myoxus.common.open-menu"]()}`}
        icon={<MoreHorizontalIcon />}
        onClick={stopTagCatalogRowAction}
        size="small"
      />
    </TagEditMenu>
  );
}

function TagCatalogUsage({ row }: { row: TagCatalogRow }) {
  const t = useI18n();
  return (
    <Group gap="xs" wrap="wrap">
      <Badge tone="neutral">
        {t["com.myoxus.tags.catalog.documents"]({
          count: String(row.documentCount),
        })}
      </Badge>
      <Badge tone="neutral">
        {t["com.myoxus.tags.catalog.database-rows"]({
          count: String(row.databaseRowCount),
        })}
      </Badge>
    </Group>
  );
}

function TagCatalogName({ row }: { row: TagCatalogRow }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <ColorSwatch tagColorRole={row.color} shape="circle" />
      <Stack gap={0}>
        <SurfaceListText kind="title">{row.name}</SurfaceListText>
        {row.description ? (
          <SurfaceListText kind="description">
            {row.description}
          </SurfaceListText>
        ) : null}
      </Stack>
    </Group>
  );
}

function DesktopCatalogRows({
  rows,
  onChanged,
}: {
  rows: readonly TagCatalogRow[];
  onChanged: () => void;
}) {
  const t = useI18n();
  const dateFormatter = new Intl.DateTimeFormat(t.language, {
    dateStyle: "medium",
  });
  return (
    <TableScrollContainer containInlineSize>
      <Table highlightOnHover>
        <TableHeader>
          <TableRow>
            <TableHead>{t["com.myoxus.tags.name"]()}</TableHead>
            <TableHead>{t["com.myoxus.tags.catalog.column.usage"]()}</TableHead>
            <TableHead>{t["Updated"]()}</TableHead>
            <TableHead>{t["Status"]()}</TableHead>
            <TableHead
              aria-label={t["com.myoxus.tags.catalog.column.actions"]()}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-testid={`tag-catalog-row-${row.id}`}>
              <TableCell>
                <SurfaceListItemFrame
                  component={WorkbenchLink}
                  to={`/tag/${row.id}`}
                >
                  <TagCatalogName row={row} />
                </SurfaceListItemFrame>
              </TableCell>
              <TableCell>
                <TagCatalogUsage row={row} />
              </TableCell>
              <TableCell>
                {dateFormatter.format(new Date(row.updatedAt))}
              </TableCell>
              <TableCell>
                <Badge tone={row.archived ? "neutral" : "success"}>
                  {row.archived
                    ? t["com.myoxus.tags.status.archived"]()
                    : t["com.myoxus.tags.status.active"]()}
                </Badge>
              </TableCell>
              <TableCell>
                <TagCatalogMenu row={row} onChanged={onChanged} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScrollContainer>
  );
}

function CompactCatalogRows({
  rows,
  onChanged,
}: {
  rows: readonly TagCatalogRow[];
  onChanged: () => void;
}) {
  const t = useI18n();
  return (
    <SurfaceList label={t["Tags"]()}>
      {rows.map((row) => (
        <SurfaceListItemFrame
          key={row.id}
          component={WorkbenchLink}
          to={`/tag/${row.id}`}
        >
          <SurfaceListItem
            component="div"
            density="compact"
            interactive
            layout="row"
            role="presentation"
            data-testid={`tag-catalog-row-${row.id}`}
          >
            <SurfaceListItemIcon>
              <ColorSwatch tagColorRole={row.color} shape="circle" />
            </SurfaceListItemIcon>
            <SurfaceListItemMain grow>
              <SurfaceListText kind="title">{row.name}</SurfaceListText>
              {row.description ? (
                <SurfaceListText kind="description">
                  {row.description}
                </SurfaceListText>
              ) : null}
              <SurfaceListMeta layout="row-group">
                <TagCatalogUsage row={row} />
                {row.archived ? (
                  <Badge tone="neutral">
                    {t["com.myoxus.tags.status.archived"]()}
                  </Badge>
                ) : null}
              </SurfaceListMeta>
            </SurfaceListItemMain>
            <SurfaceListSpacer />
            <TagCatalogMenu row={row} onChanged={onChanged} />
          </SurfaceListItem>
        </SurfaceListItemFrame>
      ))}
    </SurfaceList>
  );
}

function TagCatalogContent({ compact }: { compact: boolean }) {
  const t = useI18n();
  const { error, isLoading, mutate, rows } = useTagCatalog();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TagCatalogStatus>("active");
  const [sort, setSort] = useState<TagCatalogSort>("name-asc");
  const selectedRows = useMemo(
    () => selectTagCatalogRows(rows, search, status, sort),
    [rows, search, status, sort],
  );
  const revalidate = useCallback(() => {
    void mutate();
  }, [mutate]);
  const viewState = resolveTagCatalogViewState({
    error,
    isLoading,
    totalCount: rows.length,
    visibleCount: selectedRows.length,
  });

  return (
    <PageContentRail fill scroll spacious width="wide">
      <Stack>
        <Group justify="space-between">
          <Group>
            <MyoxusTextInput
              aria-label={t["com.myoxus.tags.catalog.search.label"]()}
              placeholder={t["com.myoxus.tags.catalog.search.label"]()}
              value={search}
              onChange={setSearch}
            />
            <ViewSwitcher<TagCatalogStatus>
              aria-label={t["com.myoxus.tags.catalog.filter.label"]()}
              items={[
                {
                  value: "active",
                  label: t["com.myoxus.tags.status.active"](),
                },
                {
                  value: "archived",
                  label: t["com.myoxus.tags.status.archived"](),
                },
                {
                  value: "all",
                  label: t["com.myoxus.tags.catalog.filter.all"](),
                },
              ]}
              onChange={setStatus}
              value={status}
            />
          </Group>
          <Select
            aria-label={t["com.myoxus.tags.catalog.sort.label"]()}
            data={[
              {
                value: "name-asc",
                label: t["com.myoxus.tags.catalog.sort.name-asc"](),
              },
              {
                value: "name-desc",
                label: t["com.myoxus.tags.catalog.sort.name-desc"](),
              },
              {
                value: "updated-desc",
                label: t["com.myoxus.tags.catalog.sort.updated-desc"](),
              },
              {
                value: "updated-asc",
                label: t["com.myoxus.tags.catalog.sort.updated-asc"](),
              },
              {
                value: "usage-desc",
                label: t["com.myoxus.tags.catalog.sort.usage-desc"](),
              },
              {
                value: "usage-asc",
                label: t["com.myoxus.tags.catalog.sort.usage-asc"](),
              },
            ]}
            onChange={(value) => value && setSort(value as TagCatalogSort)}
            value={sort}
          />
        </Group>
        {viewState.showError ? (
          <Alert title={t["com.myoxus.tags.catalog.load-failed"]()}>
            <Button variant="secondary" onClick={revalidate}>
              {t["Retry"]()}
            </Button>
          </Alert>
        ) : null}
        {viewState.body === "loading" ? (
          <Loading data-testid="tag-catalog-loading" />
        ) : viewState.body === "empty" || viewState.body === "no-results" ? (
          <EmptyState
            media={
              <ThemedImg
                fluid
                alt=""
                lightSrc={getArtworkUrl(
                  viewState.body === "empty" ? "tags" : "search",
                )}
              />
            }
            title={
              <EmptyStateTitle icon={<TagsIcon />}>
                {viewState.body === "empty"
                  ? t["com.myoxus.empty.tags.title"]()
                  : t["com.myoxus.tags.catalog.no-results"]()}
              </EmptyStateTitle>
            }
            description={
              viewState.body === "empty"
                ? t["com.myoxus.empty.tags.description"]()
                : t["com.myoxus.tags.catalog.no-results-description"]()
            }
            data-testid="tag-catalog-empty"
          />
        ) : compact ? (
          <CompactCatalogRows rows={selectedRows} onChanged={revalidate} />
        ) : (
          <DesktopCatalogRows rows={selectedRows} onChanged={revalidate} />
        )}
      </Stack>
    </PageContentRail>
  );
}

export function TagCatalogPage({
  compact,
  children,
}: {
  compact: boolean;
  children: (parts: { header: ReactNode; content: ReactNode }) => ReactNode;
}) {
  const compactViewport = useResponsiveSmQuery(compact);
  const tagService = useService(TagService);
  const commands = useWorkspaceTagCommands();
  const colors = useWorkspaceTagColorOptions();
  const [createOpen, setCreateOpen] = useState(false);
  const [createColor, setCreateColor] = useState<TagColorRole>("tag.grey");
  const createTagDraft = useMemo(
    () => ({
      id: "",
      name: "",
      color: createColor,
      description: "",
    }),
    [createColor],
  );
  const handleCreate = useCallback(() => {
    setCreateColor(tagService.randomTagColor());
    setCreateOpen(true);
  }, [tagService]);

  return children({
    header: (
      <>
        <TagCatalogHeader onCreate={handleCreate} />
        <TagMetadataModal
          colors={colors}
          mode="create"
          onOpenChange={setCreateOpen}
          onSubmit={async (metadata) => {
            await commands.createTag(
              metadata.name,
              metadata.color,
              metadata.description,
            );
            return true;
          }}
          open={createOpen}
          tag={createTagDraft}
        />
      </>
    ),
    content: <TagCatalogContent compact={compactViewport} />,
  });
}
