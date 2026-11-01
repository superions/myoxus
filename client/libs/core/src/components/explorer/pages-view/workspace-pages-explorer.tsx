import { DocsService } from "@myoxus/core/modules/doc";
import {
  DatabasePageActionsProvider,
  type DatabasePageRecord,
  type DatabasePagesLoadState,
  parseWorkspacePageKey,
  type WorkspacePageGroup,
} from "@myoxus/core/modules/workspace-pages";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Checkbox,
  EmptyState,
  EmptyStateTitle,
  Group,
  Loading,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useContext, useMemo } from "react";

import { DocExplorerContext } from "../context";
import {
  ExplorerPropertyGroupActions,
  ExplorerPropertyGroupHeader,
} from "../docs-view/docs-list";
import { ExplorerItemsView } from "../explorer-items-view";
import { WorkspacePagesExplorerContext } from "./context";
import { WorkspacePageItem } from "./workspace-page-item";
import { WorkspacePagesSelectionToolbar } from "./workspace-pages-selection-toolbar";

const WorkspacePageGroupSelection = ({ groupId }: { groupId: string }) => {
  const t = useI18n();
  const context = useContext(WorkspacePagesExplorerContext);
  const docContext = useContext(DocExplorerContext);
  const selected = useLiveData(docContext.selectedItemKeys$);
  const itemKeys = useMemo(
    () =>
      context?.groups
        .find((group) => group.key === groupId)
        ?.items.filter((key) => parseWorkspacePageKey(key) !== null) ?? [],
    [context?.groups, groupId],
  );
  const allSelected =
    itemKeys.length > 0 && itemKeys.every((id) => selected.includes(id));
  const selectedCount = itemKeys.filter((id) => selected.includes(id)).length;
  const toggle = useCallback(() => {
    const previous = docContext.selectedItemKeys$.value;
    const next = allSelected
      ? previous.filter((id) => !itemKeys.includes(id))
      : [...new Set([...previous, ...itemKeys])];
    docContext.selectedItemKeys$.next(next);
    docContext.selectMode$?.next(next.length > 0);
  }, [allSelected, docContext, itemKeys]);
  if (itemKeys.length === 0) return null;
  return (
    <Checkbox
      aria-label={t[
        allSelected
          ? "com.myoxus.common.clear-selection"
          : "com.myoxus.page.group-header.select-all"
      ]()}
      checked={allSelected}
      indeterminate={selectedCount > 0 && !allSelected}
      onChange={toggle}
      onClick={(event) => event.stopPropagation()}
      size="xs"
    />
  );
};

export function WorkspacePagesExplorer({
  databases,
  groups,
  loadState,
  reload,
  retry,
  workspaceId,
  preserveEmptyGroups = false,
}: {
  databases: readonly DatabasePageRecord[];
  groups: readonly WorkspacePageGroup[];
  loadState: DatabasePagesLoadState;
  reload: () => void;
  retry: () => void;
  workspaceId: string;
  preserveEmptyGroups?: boolean;
}) {
  const t = useI18n();
  const context = useContext(DocExplorerContext);
  const docsService = useService(DocsService);
  const nonTrashDocIds = useLiveData(docsService.list.nonTrashDocsIds$);
  const groupBy = useLiveData(context.groupBy$);
  const view = useLiveData(context.view$);
  const previewSize = useLiveData(context.previewSize$);
  const collapsedGroups = useLiveData(context.collapsedGroups$);
  const visibleGroups = useMemo(() => {
    const documentIds = new Set(nonTrashDocIds);
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((key) => {
          const identity = parseWorkspacePageKey(key);
          return (
            identity?.kind === "database" ||
            (identity?.kind === "document" && documentIds.has(identity.id))
          );
        }),
      }))
      .filter((group) => preserveEmptyGroups || group.items.length > 0);
  }, [groups, nonTrashDocIds, preserveEmptyGroups]);
  const value = useMemo(
    () => ({
      databasePages: new Map(
        databases.map((database) => [database.key, database]),
      ),
      groups: visibleGroups,
      loadState,
      reload,
      retry,
      workspaceId,
    }),
    [databases, loadState, reload, retry, visibleGroups, workspaceId],
  );

  return (
    <DatabasePageActionsProvider>
      <WorkspacePagesExplorerContext.Provider value={value}>
        <Stack flex="1 1 auto" mih={0} miw={0} w="100%">
          {loadState.status === "error" ? (
            <Notice
              title={t["com.myoxus.database.selector.error-title"]()}
              tone="error"
              data-testid="workspace-pages-database-error"
            >
              <Group justify="space-between" wrap="wrap">
                {t["com.myoxus.database.selector.error-description"]()}
                <Button variant="secondary" onClick={retry}>
                  {t["Retry"]()}
                </Button>
              </Group>
            </Notice>
          ) : null}
          <ExplorerItemsView
            collapsedGroups={collapsedGroups}
            empty={
              loadState.status === "loading" ? (
                <Group justify="center">
                  <Loading />
                </Group>
              ) : loadState.status === "error" ? null : (
                <EmptyState
                  title={
                    <EmptyStateTitle icon={<DatabaseIcon />}>
                      {t["com.myoxus.workspace-pages.empty.title"]()}
                    </EmptyStateTitle>
                  }
                  description={t[
                    "com.myoxus.workspace-pages.empty.description"
                  ]()}
                />
              )
            }
            groups={visibleGroups}
            groupBy={Boolean(groupBy)}
            GroupActionsComponent={ExplorerPropertyGroupActions}
            GroupHeaderComponent={ExplorerPropertyGroupHeader}
            GroupSelectionComponent={WorkspacePageGroupSelection}
            ItemComponent={WorkspacePageItem}
            listScrollOwner="parent"
            measuredCards
            previewSize={previewSize}
            onCollapsedGroupsChange={(next) =>
              context.collapsedGroups$.next(next)
            }
            view={view ?? "list"}
          />
          <WorkspacePagesSelectionToolbar />
        </Stack>
      </WorkspacePagesExplorerContext.Provider>
    </DatabasePageActionsProvider>
  );
}
