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
  ExplorerItemsView,
  type ExplorerItemComponentProps,
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
    const contextValue = useContext(DocExplorerContext);
    const propertyService = useService(WorkspacePropertyService);
    const allProperties = useLiveData(propertyService.sortedProperties$);
    const groupBy = useLiveData(contextValue.groupBy$);

    const groupType = groupBy?.type;
    const groupKey = groupBy?.key;

    const header = useMemo(() => {
      if (groupType === "system") {
        const property = groupKey && SystemPropertyTypes[groupKey];
        if (!property) return null;
        const GroupHeader = property.groupHeader;
        if (!GroupHeader) return null;
        return (
          <GroupHeader
            groupId={groupId}
            docCount={itemCount}
            collapsed={!!collapsed}
            interactive={interactive}
          />
        );
      } else if (groupType === "property") {
        const property = allProperties.find((p) => p.id === groupKey);
        if (!property) return null;

        const config = WorkspacePropertyTypes[property.type];
        if (!config?.groupHeader) return null;
        return (
          <config.groupHeader
            groupId={groupId}
            docCount={itemCount}
            collapsed={!!collapsed}
            interactive={interactive}
          />
        );
      } else {
        console.warn("unsupported group type", groupType);
        return null;
      }
    }, [
      allProperties,
      collapsed,
      groupId,
      groupKey,
      groupType,
      interactive,
      itemCount,
    ]);

    if (!groupType) {
      return null;
    }

    return header;
  },
);

export const ExplorerPropertyGroupActions = memo(
  function ExplorerPropertyGroupActions({ groupId }: { groupId: string }) {
    const contextValue = useContext(DocExplorerContext);
    const propertyService = useService(WorkspacePropertyService);
    const allProperties = useLiveData(propertyService.sortedProperties$);
    const groupBy = useLiveData(contextValue.groupBy$);

    if (groupBy?.type === "system") {
      const GroupActions = SystemPropertyTypes[groupBy.key]?.groupActions;
      return GroupActions ? <GroupActions groupId={groupId} /> : null;
    }
    if (groupBy?.type === "property") {
      const property = allProperties.find((item) => item.id === groupBy.key);
      const GroupActions = property
        ? WorkspacePropertyTypes[property.type]?.groupActions
        : undefined;
      return GroupActions ? <GroupActions groupId={groupId} /> : null;
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
  /** Override the default delete action */
  onDelete?: (
    ids: string[],
    callbacks?: {
      onFinished?: () => void;
      onAbort?: () => void;
      onError?: (error: Error) => void;
    },
  ) => void | Promise<void>;
}) => {
  const contextValue = useContext(DocExplorerContext);
  const docsService = useService(DocsService);
  const shareDocsListService = useService(ShareDocsListService);

  const groupBy = useLiveData(contextValue.groupBy$);
  const groups = useLiveData(contextValue.groups$);
  const nonTrashDocIds = useLiveData(docsService.list.nonTrashDocsIds$);
  const view = useLiveData(contextValue.view$);
  const previewSize = useLiveData(contextValue.previewSize$);
  const collapsedGroups = useLiveData(contextValue.collapsedGroups$);

  const visibleGroups = useMemo(() => {
    if (!excludeTrashedDocs) {
      return groups;
    }
    const nonTrashSet = new Set(nonTrashDocIds);
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((docId: string) => nonTrashSet.has(docId)),
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
        onCollapsedGroupsChange={(groups) =>
          contextValue.collapsedGroups$.next(groups)
        }
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
