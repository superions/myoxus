// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocsService } from "@myoxus/core/modules/doc";
import { ShareDocsListService } from "@myoxus/core/modules/share-doc";
import { WorkspacePropertyService } from "@myoxus/core/modules/workspace-property";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type ComponentType,
  memo,
  useContext,
  useEffect,
  useMemo,
} from "react";

import { EmptyDocs } from "../../myoxus/empty";
import { SystemPropertyTypes } from "../../system-property-types";
import { WorkspacePropertyTypes } from "../../workspace-property-types";
import { DocExplorerContext } from "../context";
import {
  type ExplorerItemComponentProps,
  ExplorerItemsView,
  type ExplorerListGroupFrameProps,
  type ExplorerListScrollOwner,
} from "../explorer-items-view";
import { ExplorerSelectionToolbar } from "../selection-toolbar";
import { DocListItem } from "./doc-list-item";
import { DocGroupSelection } from "./group-header";

export const ExplorerPropertyGroupHeader = memo(
  function ExplorerPropertyGroupHeader({
    groupId,
    collapsed,
    interactive,
    itemCount,
  }: {
    groupId: string;
    collapsed?: boolean;
    interactive?: boolean;
    itemCount: number;
  }) {
    const context = useContext(DocExplorerContext);
    const properties = useLiveData(
      useService(WorkspacePropertyService).sortedProperties$,
    );
    const groupBy = useLiveData(context.groupBy$);

    return useMemo(() => {
      if (!groupBy) return null;

      if (groupBy.type === "system") {
        const Header = SystemPropertyTypes[groupBy.key]?.groupHeader;
        return Header ? (
          <Header
            groupId={groupId}
            docCount={itemCount}
            collapsed={Boolean(collapsed)}
            interactive={interactive}
          />
        ) : null;
      }

      if (groupBy.type === "property") {
        const property = properties.find((item) => item.id === groupBy.key);
        const Header = property
          ? WorkspacePropertyTypes[property.type]?.groupHeader
          : undefined;
        return Header ? (
          <Header
            groupId={groupId}
            docCount={itemCount}
            collapsed={Boolean(collapsed)}
            interactive={interactive}
          />
        ) : null;
      }

      return null;
    }, [collapsed, groupBy, groupId, interactive, itemCount, properties]);
  },
);

export const ExplorerPropertyGroupActions = memo(
  function ExplorerPropertyGroupActions({ groupId }: { groupId: string }) {
    const context = useContext(DocExplorerContext);
    const properties = useLiveData(
      useService(WorkspacePropertyService).sortedProperties$,
    );
    const groupBy = useLiveData(context.groupBy$);

    if (groupBy?.type === "system") {
      const Actions = SystemPropertyTypes[groupBy.key]?.groupActions;
      return Actions ? <Actions groupId={groupId} /> : null;
    }

    if (groupBy?.type === "property") {
      const property = properties.find((item) => item.id === groupBy.key);
      const Actions = property
        ? WorkspacePropertyTypes[property.type]?.groupActions
        : undefined;
      return Actions ? <Actions groupId={groupId} /> : null;
    }

    return null;
  },
);

export const DocListItemComponent = memo(function DocListItemComponent({
  itemId,
  groupId,
  inventoryPreview,
}: ExplorerItemComponentProps) {
  return (
    <DocListItem
      docId={itemId}
      groupId={groupId}
      inventoryPreview={inventoryPreview}
    />
  );
});

export const DocsExplorer = ({
  className,
  disableMultiSelectToolbar,
  disableMultiDelete,
  excludeTrashedDocs = true,
  listScrollOwner,
  ListGroupFrameComponent,
  masonryItemWidthMin,
  measuredCards = false,
  preserveEmptyGroups = false,
  onRestore,
  onDelete,
}: {
  className?: string;
  disableMultiSelectToolbar?: boolean;
  disableMultiDelete?: boolean;
  excludeTrashedDocs?: boolean;
  listScrollOwner?: ExplorerListScrollOwner;
  ListGroupFrameComponent?: ComponentType<ExplorerListGroupFrameProps>;
  masonryItemWidthMin?: number;
  measuredCards?: boolean;
  preserveEmptyGroups?: boolean;
  onRestore?: (ids: string[]) => void;
  onDelete?: (
    ids: string[],
    callbacks?: {
      onFinished?: () => void;
      onAbort?: () => void;
      onError?: (error: Error) => void;
    },
  ) => void | Promise<void>;
}) => {
  const context = useContext(DocExplorerContext);
  const docsService = useService(DocsService);
  const shareDocsListService = useService(ShareDocsListService);

  const groupBy = useLiveData(context.groupBy$);
  const groups = useLiveData(context.groups$);
  const nonTrashDocIds = useLiveData(docsService.list.nonTrashDocsIds$);
  const view = useLiveData(context.view$);
  const previewSize = useLiveData(context.previewSize$);
  const collapsedGroups = useLiveData(context.collapsedGroups$);

  const visibleGroups = useMemo(() => {
    if (!excludeTrashedDocs) return groups;
    const allowed = new Set(nonTrashDocIds);
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((docId) => allowed.has(docId)),
      }))
      .filter((group) => preserveEmptyGroups || group.items.length > 0);
  }, [excludeTrashedDocs, groups, nonTrashDocIds, preserveEmptyGroups]);

  useEffect(() => {
    shareDocsListService.shareDocs?.revalidate();
  }, [shareDocsListService]);

  return (
    <>
      <ExplorerItemsView
        className={className}
        collapsedGroups={collapsedGroups}
        empty={
          <EmptyDocs
            allowCreate={false}
            data-myoxus-ui-role="docs-empty-state"
          />
        }
        groups={visibleGroups}
        groupBy={Boolean(groupBy)}
        GroupActionsComponent={ExplorerPropertyGroupActions}
        GroupHeaderComponent={ExplorerPropertyGroupHeader}
        ListGroupFrameComponent={ListGroupFrameComponent}
        GroupSelectionComponent={DocGroupSelection}
        ItemComponent={DocListItemComponent}
        listScrollOwner={listScrollOwner}
        masonryItemWidthMin={masonryItemWidthMin}
        measuredCards={measuredCards}
        previewSize={previewSize}
        onCollapsedGroupsChange={(next) => context.collapsedGroups$.next(next)}
        view={view ?? "list"}
      />
      <ExplorerSelectionToolbar
        disableDelete={disableMultiDelete}
        disableToolbar={disableMultiSelectToolbar}
        onDelete={onDelete}
        onRestore={onRestore}
      />
    </>
  );
};
