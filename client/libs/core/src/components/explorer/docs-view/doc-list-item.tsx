import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import {
  AllDocsGridViewIcon,
  AllDocsListViewIcon,
  AllDocsMasonryViewIcon,
  ViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Checkbox,
  ContextMenu,
  DragHandle as DragHandleIcon,
  Group,
  IconButton,
  SurfaceListCardHeader,
  SurfaceListDragHandle,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListSelectionSlot,
  SurfaceListSpacer,
  SurfaceListText,
  Tooltip,
  useDraggable,
  useResponsiveElementSize,
} from "@myoxus/ui-facade";
import {
  type ComponentProps,
  type HTMLAttributes,
  type HTMLProps,
  memo,
  type ReactNode,
  type SVGProps,
  useCallback,
  useContext,
  useMemo,
} from "react";

import { PagePreview } from "../../page-list/page-content-preview";
import { DocExplorerContext } from "../context";
import { listQuickActions, quickActions } from "../quick-actions.constants";
import { MoreMenuButton, MoreMenuContent } from "./more-menu";
import {
  CardViewProperties,
  type DocListDensity,
  ListViewProperties,
} from "./properties";
import { AllDocsPublicStatusAction } from "./public-status-action";

export type DocListItemView = "list" | "grid" | "masonry";

export const DocListViewIcon = ({
  view,
  size = "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  ...props
}: {
  size?: number | string;
  view: DocListItemView;
} & SVGProps<SVGSVGElement>) => {
  const Component = {
    list: AllDocsListViewIcon,
    grid: AllDocsGridViewIcon,
    masonry: AllDocsMasonryViewIcon,
  }[view];

  return <Component size={size} {...props} />;
};

export interface DocListItemProps {
  docId: string;
  groupId: string;
  inventoryPreview?: "grid" | "masonry";
  /** Stable typed identity used only by a mixed content surface. */
  selectionKey?: string;
  selectionGroups?: Array<{ key: string; items: string[] }>;
  /** Raw document IDs selected by a mixed surface for document-only DnD. */
  dragSelectionDocIds?: string[];
}

class MixId {
  static connector = "||";
  static create(groupId: string, docId: string) {
    return `${groupId}${this.connector}${docId}`;
  }
  static parse(mixId: string) {
    if (!mixId) {
      return { groupId: null, docId: null };
    }
    const [groupId, docId] = mixId.split(this.connector);
    return { groupId, docId };
  }
}
export const DocListItem = ({ ...props }: DocListItemProps) => {
  const peekView = useService(PeekViewService).peekView;
  const contextValue = useContext(DocExplorerContext);
  const view = useLiveData(contextValue.view$) ?? "list";
  const groups = useLiveData(contextValue.groups$);
  const selectMode = useLiveData(contextValue.selectMode$);
  const selection$ = props.selectionKey
    ? contextValue.selectedItemKeys$
    : contextValue.selectedDocIds$;
  const selectedKeys = useLiveData(selection$);
  const selectionKey = props.selectionKey ?? props.docId;
  const dragSelectionDocIds = props.dragSelectionDocIds ?? selectedKeys;
  const prevCheckAnchorId = useLiveData(contextValue.prevCheckAnchorId$);

  const handleMultiSelect = useCallback(
    (prevCursor: string, currCursor: string) => {
      const flattenList = (props.selectionGroups ?? groups).flatMap((group) =>
        group.items.map((itemKey) => MixId.create(group.key, itemKey)),
      );

      const prev = selection$.value;
      const prevIndex = flattenList.indexOf(prevCursor);
      const currIndex = flattenList.indexOf(currCursor);

      const lowerIndex = Math.min(prevIndex, currIndex);
      const upperIndex = Math.max(prevIndex, currIndex);

      const resSet = new Set(prev);
      const handledSet = new Set<string>();
      for (let i = lowerIndex; i <= upperIndex; i++) {
        const mixId = flattenList[i];
        const { groupId, docId } = MixId.parse(mixId);
        if (groupId === null || docId === null) {
          continue;
        }
        if (handledSet.has(docId) || mixId === prevCursor) {
          continue;
        }
        if (resSet.has(docId)) {
          resSet.delete(docId);
        } else {
          resSet.add(docId);
        }
        handledSet.add(docId);
      }

      selection$.next(Array.from(resSet));
      contextValue.prevCheckAnchorId$?.next(currCursor);
    },
    [
      contextValue.prevCheckAnchorId$,
      groups,
      props.selectionGroups,
      selection$,
    ],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<Element>) => {
      const { groupId } = props;
      const currCursor = MixId.create(groupId, selectionKey);
      if (selectMode || e.shiftKey) {
        e.preventDefault();
      }

      if (selectMode) {
        if (e.shiftKey && prevCheckAnchorId) {
          // do multi select
          handleMultiSelect(prevCheckAnchorId, currCursor);
        } else {
          selection$.next(
            selection$.value.includes(selectionKey)
              ? selection$.value.filter((id) => id !== selectionKey)
              : [...selection$.value, selectionKey],
          );
          contextValue.prevCheckAnchorId$?.next(currCursor);
        }
      } else {
        if (e.shiftKey) {
          contextValue.selectMode$?.next(true);
          selection$.next([selectionKey]);
          contextValue.prevCheckAnchorId$?.next(currCursor);
          return;
        } else {
          // as link
          track.allDocs.list.doc.openDoc();
          return;
        }
      }
    },
    [
      contextValue,
      handleMultiSelect,
      prevCheckAnchorId,
      props,
      selectMode,
      selection$,
      selectionKey,
    ],
  );

  const openReading = useCallback(
    (element: HTMLElement) => {
      void peekView
        .open({ element, docRef: { docId: props.docId }, purpose: "reading" })
        .catch(console.error);
    },
    [peekView, props.docId],
  );

  const { dragRef, CustomDragPreview } = useDraggable<MyoxusDNDData>(
    () => ({
      canDrag: true,
      data: {
        entity: {
          type: "doc",
          id: props.docId as string,
        },
        selection:
          dragSelectionDocIds.includes(props.docId) &&
          dragSelectionDocIds.length > 1
            ? {
                type: "doc",
                ids: dragSelectionDocIds,
              }
            : undefined,
        from: {
          at: "all-docs:list",
          groupId: props.groupId,
        },
      },
    }),
    [dragSelectionDocIds, props.docId, props.groupId],
  );

  return (
    <>
      <SurfaceListItemFrame
        component={WorkbenchLink}
        ref={dragRef}
        draggable={false}
        to={`/${props.docId}`}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (
            !props.inventoryPreview ||
            selectMode ||
            event.target !== event.currentTarget ||
            event.key !== " " ||
            !event.currentTarget.querySelector(
              '[data-myoxus-ui-role="document-reading-action"]',
            ) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          openReading(event.currentTarget);
        }}
        data-selected={selectedKeys.includes(selectionKey)}
        data-myoxus-ui-role="doc-list-row-link"
        data-testid={`doc-list-item`}
        data-doc-id={props.docId}
        data-item-key={props.selectionKey}
      >
        {view === "list" ? (
          <ListViewDoc {...props} />
        ) : (
          <CardViewDoc {...props} onReading={openReading} />
        )}
      </SurfaceListItemFrame>
      <CustomDragPreview>
        <SurfaceListItem
          alignItems="center"
          component="div"
          density="compact"
          fullWidth
          layout="row"
          role="presentation"
          data-myoxus-ui-role="surface-list-drag-preview"
        >
          <SurfaceListItemIcon>
            <RawDocIcon id={props.docId} />
          </SurfaceListItemIcon>
          <SurfaceListText kind="title">
            <RawDocTitle id={props.docId} />
          </SurfaceListText>
        </SurfaceListItem>
      </CustomDragPreview>
    </>
  );
};

const RawDocIcon = memo(function RawDocIcon({
  id,
  ...props
}: HTMLProps<SVGSVGElement>) {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const Icon = useLiveData(id ? docDisplayMetaService.icon$(id) : null);
  return <Icon {...props} />;
});
const RawDocTitle = memo(function RawDocTitle({ id }: { id: string }) {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const title = useLiveData(docDisplayMetaService.title$(id));
  return title;
});
const RawDocPreview = memo(function RawDocPreview({
  edgelessFallback,
  emptyFallback,
  enableLocalTextFallback,
  id,
  loading,
  visibleListSnippet,
}: {
  edgelessFallback?: ReactNode;
  emptyFallback?: ReactNode;
  enableLocalTextFallback?: boolean;
  id: string;
  loading?: ReactNode;
  visibleListSnippet?: boolean;
}) {
  return (
    <PagePreview
      edgelessFallback={edgelessFallback}
      enableLocalTextFallback={enableLocalTextFallback}
      emptyFallback={emptyFallback}
      pageId={id}
      fallback={loading}
      visibleListSnippet={visibleListSnippet}
    />
  );
});
const DragHandle = memo(function DragHandle({
  id,
  placement,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  placement?: "outside-left-center" | "outside-left-top";
}) {
  const contextValue = useContext(DocExplorerContext);
  const selectMode = useLiveData(contextValue.selectMode$);
  const showDragHandle = useLiveData(contextValue.showDragHandle$);

  if (selectMode || !id || !showDragHandle) {
    return null;
  }

  return (
    <SurfaceListDragHandle placement={placement} {...props}>
      <DragHandleIcon />
    </SurfaceListDragHandle>
  );
});
const Select = memo(function Select({
  groupId,
  id,
  selectionKey,
  visible = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  groupId: string;
  selectionKey?: string;
  visible?: boolean;
}) {
  const t = useI18n();
  const contextValue = useContext(DocExplorerContext);
  const selectMode = useLiveData(contextValue.selectMode$);
  const selection$ = selectionKey
    ? contextValue.selectedItemKeys$
    : contextValue.selectedDocIds$;
  const selectedKeys = useLiveData(selection$);
  const itemKey = selectionKey ?? id ?? "";

  const handleSelectChange = useCallback(() => {
    if (!id || !itemKey) {
      return;
    }
    const selectedIds = selection$.value;
    const nextIds = selectedIds.includes(itemKey)
      ? selectedIds.filter((selectedId) => selectedId !== itemKey)
      : [...selectedIds, itemKey];
    selection$.next(nextIds);
    contextValue.selectMode$?.next(nextIds.length > 0);
    contextValue.prevCheckAnchorId$?.next(
      nextIds.length > 0 ? MixId.create(groupId, itemKey) : null,
    );
  }, [
    contextValue.prevCheckAnchorId$,
    contextValue.selectMode$,
    groupId,
    id,
    itemKey,
    selection$,
  ]);

  if (!id || !itemKey) {
    return null;
  }

  return (
    <SurfaceListSelectionSlot
      active={visible || selectMode}
      data-testid={`doc-list-item-select`}
      {...props}
    >
      <Checkbox
        aria-label={t["com.myoxus.all-docs.quick-action.select"]()}
        checked={selectedKeys.includes(itemKey)}
        onClick={(event) => event.stopPropagation()}
        onChange={handleSelectChange}
        size="xs"
      />
    </SurfaceListSelectionSlot>
  );
});
// Different with RawDocIcon, refer to `ExplorerDisplayPreference.showDocIcon`
const DocIcon = memo(function DocIcon({
  id,
  ...props
}: ComponentProps<typeof SurfaceListItemIcon>) {
  const contextValue = useContext(DocExplorerContext);
  const showDocIcon = useLiveData(contextValue.showDocIcon$);
  if (!showDocIcon) {
    return null;
  }
  return (
    <SurfaceListItemIcon {...props}>
      <RawDocIcon id={id} />
    </SurfaceListItemIcon>
  );
});
const DocTitle = memo(function DocTitle({
  id,
  kind = "title",
  ...props
}: ComponentProps<typeof SurfaceListText> & { id: string }) {
  if (!id) return null;
  return (
    <SurfaceListText kind={kind} {...props}>
      <RawDocTitle id={id} />
    </SurfaceListText>
  );
});
const DocPreview = memo(function DocPreview({
  edgelessFallback,
  emptyFallback,
  enableLocalTextFallback,
  id,
  inventoryPreview,
  kind = "description",
  loading,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  edgelessFallback?: ReactNode;
  emptyFallback?: ReactNode;
  enableLocalTextFallback?: boolean;
  kind?: "description" | "preview";
  inventoryPreview?: "grid" | "masonry";
  loading?: ReactNode;
}) {
  const contextValue = useContext(DocExplorerContext);
  const showDocPreview = useLiveData(contextValue.showDocPreview$);
  const cloudPreview =
    useService(WorkspaceService).workspace.flavour !== "local";

  if (!id || !showDocPreview) return null;

  if (kind === "preview" && cloudPreview) {
    return (
      <PagePreview
        pageId={id}
        variant="image"
        inventoryPreview={inventoryPreview}
        fill
        edgelessFallback={edgelessFallback}
        emptyFallback={emptyFallback}
        fallback={loading}
        enableLocalTextFallback={enableLocalTextFallback}
      />
    );
  }

  // Keep the native description line while an optional snippet loads, including
  // empty documents, so its arrival does not move the surrounding list rows.
  const reservedLine = kind === "description" ? "\u00a0" : undefined;

  return (
    <SurfaceListText
      kind={kind}
      lineClamp={kind === "preview" ? 6 : undefined}
      truncate={kind === "preview" ? false : undefined}
      {...props}
    >
      <RawDocPreview
        edgelessFallback={edgelessFallback}
        enableLocalTextFallback={enableLocalTextFallback}
        emptyFallback={emptyFallback ?? reservedLine}
        id={id}
        loading={loading ?? reservedLine}
        visibleListSnippet={cloudPreview && kind === "description"}
      />
    </SurfaceListText>
  );
});

const listMoreMenuContentOptions = {
  side: "bottom",
  align: "end",
  sideOffset: 12,
  alignOffset: -4,
} as const;
export const ListViewDoc = ({
  docId,
  groupId,
  selectionKey,
}: DocListItemProps) => {
  const t = useI18n();
  const docsService = useService(DocsService);
  const doc = useLiveData(docsService.list.doc$(docId));
  const contextValue = useContext(DocExplorerContext);
  const showMoreOperation = useLiveData(contextValue.showMoreOperation$);
  const displayPreference = useLiveData(contextValue.displayPreference$);
  const selectedKeys = useLiveData(
    selectionKey
      ? contextValue.selectedItemKeys$
      : contextValue.selectedDocIds$,
  );
  const { ref: rowRef, width: rowWidth } =
    useResponsiveElementSize<HTMLDivElement>();
  const density: DocListDensity =
    rowWidth > 0 && rowWidth <= 560
      ? "compact"
      : rowWidth > 0 && rowWidth <= 750
        ? "medium"
        : "regular";

  if (!doc) {
    return null;
  }

  return (
    <ContextMenu
      asChild
      disabled={!showMoreOperation}
      items={<MoreMenuContent docId={docId} />}
    >
      <SurfaceListItem
        ref={rowRef}
        data-list-density={density}
        component="div"
        density="compact"
        fullHeight
        fullWidth
        interactive
        layout="row"
        alignItems="center"
        role="presentation"
        selected={selectedKeys.includes(selectionKey ?? docId)}
      >
        <DragHandle id={docId} />
        <Select
          groupId={groupId}
          id={docId}
          selectionKey={selectionKey}
          visible
        />
        <DocIcon id={docId} size="md" />
        <SurfaceListItemMain compact={density === "compact"} grow>
          <DocTitle
            id={docId}
            data-myoxus-ui-role="doc-list-title"
            data-testid="doc-list-item-title"
          />
          <DocPreview id={docId} />
        </SurfaceListItemMain>
        <SurfaceListSpacer />
        <ListViewProperties density={density} docId={docId} />
        <AllDocsPublicStatusAction docId={docId} />
        {listQuickActions
          .filter((action) => displayPreference?.[action.key])
          .map((action) => {
            return (
              <Tooltip key={action.key} content={t.t(action.name)}>
                <action.Component
                  aria-label={t.t(action.name)}
                  doc={doc}
                  size="small"
                />
              </Tooltip>
            );
          })}
        <MoreMenuButton
          docId={docId}
          contentOptions={listMoreMenuContentOptions}
          iconProps={{ size: "small" }}
        />
      </SurfaceListItem>
    </ContextMenu>
  );
};

const cardMoreMenuContentOptions = {
  side: "bottom",
  align: "end",
  sideOffset: 12,
  alignOffset: -4,
} as const;

export const CardViewDoc = ({
  docId,
  groupId,
  selectionKey,
  inventoryPreview,
  onReading,
}: DocListItemProps & { onReading?: (element: HTMLElement) => void }) => {
  const t = useI18n();
  const contextValue = useContext(DocExplorerContext);
  const selectMode = useLiveData(contextValue.selectMode$);
  const selectedKeys = useLiveData(
    selectionKey
      ? contextValue.selectedItemKeys$
      : contextValue.selectedDocIds$,
  );
  const docsService = useService(DocsService);
  const metadata = useService(DocumentMetadataCacheService);
  const doc = useLiveData(docsService.list.doc$(docId));
  const mode$ = useMemo(
    () => docsService.list.primaryMode$(docId),
    [docsService, docId],
  );
  useLiveData(mode$);
  const index = useLiveData(metadata.watchIndexState());
  const indexed =
    index.phase === "ready"
      ? metadata.getIndexRowByExternalId(docId)
      : undefined;
  const pageMode =
    !!indexed &&
    (docsService.list.getPrimaryMode(docId) ??
      indexed.primaryMode ??
      "page") === "page";
  const showMoreOperation = useLiveData(contextValue.showMoreOperation$);
  const displayPreference = useLiveData(contextValue.displayPreference$);

  if (!doc) {
    return null;
  }

  const preview = (
    <DocPreview
      edgelessFallback={t["com.myoxus.edgelessMode"]()}
      emptyFallback={t["com.myoxus.selectPage.empty"]()}
      enableLocalTextFallback
      id={docId}
      kind="preview"
      inventoryPreview={inventoryPreview}
    />
  );
  const actions = (
    <>
      {inventoryPreview && pageMode && !selectMode && onReading ? (
        <IconButton
          data-myoxus-ui-role="document-reading-action"
          icon={<ViewIcon />}
          tooltip={t["com.myoxus.editor.toolbar.preview"]()}
          aria-label={t["com.myoxus.editor.toolbar.preview"]()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onReading(event.currentTarget);
          }}
        />
      ) : null}
      <AllDocsPublicStatusAction docId={docId} />
      {quickActions
        .filter((action) => displayPreference?.[action.key])
        .map((action) => (
          <Tooltip key={action.key} content={t.t(action.name)}>
            <action.Component aria-label={t.t(action.name)} doc={doc} />
          </Tooltip>
        ))}
      {selectMode ? (
        <Select groupId={groupId} id={docId} selectionKey={selectionKey} />
      ) : (
        <MoreMenuButton
          docId={docId}
          contentOptions={cardMoreMenuContentOptions}
        />
      )}
    </>
  );

  return (
    <ContextMenu
      asChild
      disabled={!showMoreOperation}
      items={<MoreMenuContent docId={docId} />}
    >
      <SurfaceListItem
        appearance="card"
        component="div"
        density="card"
        fullHeight
        fullWidth
        interactive
        layout="column"
        role="presentation"
        selected={selectedKeys.includes(selectionKey ?? docId)}
      >
        <DragHandle id={docId} placement="outside-left-top" />
        {inventoryPreview ? (
          <>
            {preview}
            <SurfaceListCardHeader>
              <DocTitle
                id={docId}
                kind="card-title"
                lineClamp={2}
                truncate={false}
                data-myoxus-ui-role="doc-card-title"
                data-testid="doc-list-item-title"
              />
            </SurfaceListCardHeader>
            <Group justify="space-between" wrap="wrap">
              <Group wrap="wrap">
                <DocIcon id={docId} />
                <CardViewProperties docId={docId} />
              </Group>
              <Group wrap="nowrap">{actions}</Group>
            </Group>
          </>
        ) : (
          <>
            <SurfaceListCardHeader>
              <DocIcon id={docId} />
              <DocTitle
                id={docId}
                kind="card-title"
                data-myoxus-ui-role="doc-card-title"
                data-testid="doc-list-item-title"
              />
              {actions}
            </SurfaceListCardHeader>
            {preview}
            <CardViewProperties docId={docId} />
          </>
        )}
      </SurfaceListItem>
    </ContextMenu>
  );
};
