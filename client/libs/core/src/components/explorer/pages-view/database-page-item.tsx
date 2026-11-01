import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { FavoriteService } from "@myoxus/core/modules/favorite";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import {
  DatabasePageMenuItems,
  type DatabasePageRecord,
  useDatabasePageActions,
  WorkspacePageMoveDialog,
} from "@myoxus/core/modules/workspace-pages";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import {
  DatabaseProfileKind,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  DatabaseIcon,
  DeleteIcon,
  MoreVerticalIcon,
  OpenInNewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Checkbox,
  ContextMenu,
  DragHandle as DragHandleIcon,
  IconButton,
  Menu,
  MyoxusText,
  SurfaceListCardHeader,
  SurfaceListDragHandle,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListSelectionSlot,
  SurfaceListSpacer,
  SurfaceListText,
  Tooltip,
  useDraggable,
} from "@myoxus/ui-facade";
import { type MouseEvent, useCallback, useContext, useState } from "react";

import { IsFavoriteIcon } from "../../pure/icons";
import { WorkspaceContentOperationMenuItems } from "../../workspace-content-operation/menu-items";
import { DocExplorerContext } from "../context";
import {
  WorkspacePagesExplorerContext,
  type WorkspacePagesExplorerContextValue,
} from "./context";

export function DatabasePageItem({
  itemId,
}: {
  itemId: string;
  groupId: string;
}) {
  const pagesContext = useContext(WorkspacePagesExplorerContext);
  const database = pagesContext?.databasePages.get(itemId);
  if (!database || !pagesContext) return null;
  return <DatabasePageItemContent database={database} context={pagesContext} />;
}

function DatabasePageItemContent({
  context: pagesContext,
  database,
}: {
  context: WorkspacePagesExplorerContextValue;
  database: DatabasePageRecord;
}) {
  const t = useI18n();
  const explorerContext = useContext(DocExplorerContext);
  const view = useLiveData(explorerContext.view$) ?? "list";
  const selectMode = useLiveData(explorerContext.selectMode$);
  const selectedKeys = useLiveData(explorerContext.selectedItemKeys$);
  const showDragHandle = useLiveData(explorerContext.showDragHandle$);
  const displayProperties = useLiveData(explorerContext.displayProperties$);
  const showIcon = useLiveData(explorerContext.showDocIcon$);
  const showMoreOperation = useLiveData(explorerContext.showMoreOperation$);
  const showPreview = useLiveData(explorerContext.showDocPreview$);
  const quickFavorite = useLiveData(explorerContext.quickFavorite$);
  const quickTab = useLiveData(explorerContext.quickTab$);
  const quickTrash = useLiveData(explorerContext.quickTrash$);
  const favoriteService = useService(FavoriteService);
  const favorite = useLiveData(
    favoriteService.favoriteList.isFavorite$("database", database.id),
  );
  const [moveOpen, setMoveOpen] = useState(false);
  const actions = useDatabasePageActions({
    database,
    workspaceId: pagesContext.workspaceId,
  });
  const { formatDate } = useRegionalFormatters();
  const { dragRef, CustomDragPreview } = useDraggable<MyoxusDNDData>(
    () => ({
      canDrag: !actions.protectedRoot,
      data: {
        entity: { type: "database", id: database.id },
        from: { at: "all-pages:list" },
      },
    }),
    [database],
  );

  const menuItems = (
    <>
      <DatabasePageMenuItems
        actions={actions}
        favorite={Boolean(favorite)}
        onMove={() => setMoveOpen(true)}
      />
      {!actions.protectedRoot ? (
        <WorkspaceContentOperationMenuItems
          selection={{
            type: "resources",
            resources: [
              {
                id: database.id,
                kind: WorkspaceContentResourceKindType.Database,
              },
            ],
          }}
        />
      ) : null}
    </>
  );

  const stopLink = useCallback((event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const toggleFavorite = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopLink(event);
      actions.toggleFavorite();
    },
    [actions, stopLink],
  );
  const openInNewTab = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopLink(event);
      actions.open("new-tab");
    },
    [actions, stopLink],
  );
  const moveToTrash = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopLink(event);
      actions.remove();
    },
    [actions, stopLink],
  );
  const stopSelectionClick = useCallback((event: MouseEvent) => {
    event.stopPropagation();
  }, []);
  const selected = selectedKeys.includes(database.key);
  const toggleSelection = useCallback(
    (event?: MouseEvent) => {
      event?.preventDefault();
      event?.stopPropagation();
      const previous = explorerContext.selectedItemKeys$.value;
      const next = previous.includes(database.key)
        ? previous.filter((key) => key !== database.key)
        : [...previous, database.key];
      explorerContext.selectedItemKeys$.next(next);
      explorerContext.selectMode$?.next(next.length > 0);
    },
    [database.key, explorerContext],
  );
  const handleRowClick = useCallback(
    (event: MouseEvent) => {
      if (!selectMode && !event.shiftKey) return;
      toggleSelection(event);
    },
    [selectMode, toggleSelection],
  );

  const profileLabel =
    database.profileKind === DatabaseProfileKind.Project
      ? t["com.myoxus.database.template.profile.project"]()
      : t["com.myoxus.database.template.profile.database"]();
  const createdLabel = t["com.myoxus.workspace-pages.meta.created"]({
    date: formatDate(database.createdAt),
  });
  const updatedLabel = t["com.myoxus.workspace-pages.meta.updated"]({
    date: formatDate(database.updatedAt),
  });

  if (actions.protectedRoot) return null;

  return (
    <>
      <ContextMenu asChild disabled={!showMoreOperation} items={menuItems}>
        <SurfaceListItemFrame
          component={WorkbenchLink}
          ref={dragRef}
          draggable={false}
          to={`/databases/${database.id}`}
          onClick={handleRowClick}
          data-selected={selected}
          data-database-id={database.id}
          data-testid="database-page-item"
          data-myoxus-ui-role="database-page-link"
        >
          {view === "list" ? (
            <SurfaceListItem
              alignItems="flex-start"
              component="div"
              density="compact"
              fullHeight
              fullWidth
              interactive
              layout="row"
              role="presentation"
              selected={selected}
            >
              {!selectMode && showDragHandle ? (
                <SurfaceListDragHandle>
                  <DragHandleIcon />
                </SurfaceListDragHandle>
              ) : null}
              <SurfaceListSelectionSlot active>
                <Checkbox
                  aria-label={t["com.myoxus.all-docs.quick-action.select"]()}
                  checked={selected}
                  onClick={stopSelectionClick}
                  onChange={() => toggleSelection()}
                  size="xs"
                />
              </SurfaceListSelectionSlot>
              {showIcon ? (
                <SurfaceListItemIcon size="md">
                  <DatabaseIcon />
                </SurfaceListItemIcon>
              ) : null}
              <SurfaceListItemMain grow>
                <SurfaceListText kind="title">{database.title}</SurfaceListText>
                {showPreview && database.description ? (
                  <SurfaceListText kind="description">
                    {database.description}
                  </SurfaceListText>
                ) : null}
                <SurfaceListMeta layout="card">
                  <Badge tone="neutral">{profileLabel}</Badge>
                  {displayProperties?.includes("system:createdAt") ? (
                    <MyoxusText tone="secondary" typographySlot="body-small">
                      {createdLabel}
                    </MyoxusText>
                  ) : null}
                  {displayProperties?.includes("system:updatedAt") ? (
                    <MyoxusText tone="secondary" typographySlot="body-small">
                      {updatedLabel}
                    </MyoxusText>
                  ) : null}
                </SurfaceListMeta>
              </SurfaceListItemMain>
              <SurfaceListSpacer />
              {quickFavorite && !actions.protectedRoot ? (
                <Tooltip
                  content={t["com.myoxus.all-docs.quick-action.favorite"]()}
                >
                  <IconButton
                    aria-label={t[
                      "com.myoxus.all-docs.quick-action.favorite"
                    ]()}
                    data-testid="database-page-operation-favorite"
                    icon={<IsFavoriteIcon favorite={Boolean(favorite)} />}
                    onClick={toggleFavorite}
                    size="small"
                  />
                </Tooltip>
              ) : null}
              {quickTab ? (
                <IconButton
                  aria-label={t["com.myoxus.workbench.tab.page-menu-open"]()}
                  data-testid="database-page-operation-new-tab"
                  icon={<OpenInNewIcon />}
                  onClick={openInNewTab}
                  size="small"
                  tooltip={t["com.myoxus.workbench.tab.page-menu-open"]()}
                />
              ) : null}
              {quickTrash ? (
                <IconButton
                  aria-label={t["com.myoxus.moveToTrash.title"]()}
                  data-testid="database-page-operation-trash"
                  icon={<DeleteIcon />}
                  onClick={moveToTrash}
                  size="small"
                  tooltip={t["com.myoxus.moveToTrash.title"]()}
                  variant="danger"
                />
              ) : null}
              {showMoreOperation ? (
                <Menu items={menuItems}>
                  <IconButton
                    aria-label={t["com.myoxus.database.database.menu"]()}
                    data-testid="database-page-menu-trigger"
                    icon={<MoreVerticalIcon />}
                    onClick={stopLink}
                    size="small"
                  />
                </Menu>
              ) : null}
            </SurfaceListItem>
          ) : (
            <SurfaceListItem
              appearance="card"
              component="div"
              density="card"
              fullHeight
              fullWidth
              interactive
              layout="column"
              role="presentation"
              selected={selected}
            >
              {!selectMode && showDragHandle ? (
                <SurfaceListDragHandle placement="outside-left-top">
                  <DragHandleIcon />
                </SurfaceListDragHandle>
              ) : null}
              <SurfaceListCardHeader>
                {selectMode ? (
                  <SurfaceListSelectionSlot active>
                    <Checkbox
                      aria-label={t[
                        "com.myoxus.all-docs.quick-action.select"
                      ]()}
                      checked={selected}
                      onClick={stopSelectionClick}
                      onChange={() => toggleSelection()}
                      size="xs"
                    />
                  </SurfaceListSelectionSlot>
                ) : null}
                <SurfaceListItemIcon>
                  <DatabaseIcon />
                </SurfaceListItemIcon>
                <SurfaceListText
                  kind="card-title"
                  lineClamp={2}
                  truncate={false}
                >
                  {database.title}
                </SurfaceListText>
                <Tooltip
                  content={t["com.myoxus.all-docs.quick-action.favorite"]()}
                >
                  <IconButton
                    aria-label={t[
                      "com.myoxus.all-docs.quick-action.favorite"
                    ]()}
                    data-testid="database-page-operation-favorite"
                    icon={<IsFavoriteIcon favorite={Boolean(favorite)} />}
                    onClick={toggleFavorite}
                  />
                </Tooltip>
                <Menu items={menuItems}>
                  <IconButton
                    aria-label={t["com.myoxus.database.database.menu"]()}
                    data-testid="database-page-menu-trigger"
                    icon={<MoreVerticalIcon />}
                    onClick={stopLink}
                  />
                </Menu>
              </SurfaceListCardHeader>
              {showPreview ? (
                <SurfaceListText kind="preview" lineClamp={6} truncate={false}>
                  {database.description ||
                    t["com.myoxus.workspace-pages.description.empty"]()}
                </SurfaceListText>
              ) : null}
              <SurfaceListMeta layout="card">
                <Badge tone="neutral">{profileLabel}</Badge>
                <MyoxusText tone="secondary" typographySlot="body-small">
                  {createdLabel}
                </MyoxusText>
                <MyoxusText tone="secondary" typographySlot="body-small">
                  {updatedLabel}
                </MyoxusText>
              </SurfaceListMeta>
            </SurfaceListItem>
          )}
        </SurfaceListItemFrame>
      </ContextMenu>
      <CustomDragPreview>
        <SurfaceListItem
          alignItems="center"
          component="div"
          density="compact"
          fullWidth
          layout="row"
          role="presentation"
        >
          <SurfaceListItemIcon>
            <DatabaseIcon />
          </SurfaceListItemIcon>
          <SurfaceListText kind="title">{database.title}</SurfaceListText>
        </SurfaceListItem>
      </CustomDragPreview>
      <WorkspacePageMoveDialog
        databaseId={database.id}
        open={moveOpen}
        onOpenChange={setMoveOpen}
      />
    </>
  );
}
