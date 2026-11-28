// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  AllDocsGridViewIcon,
  AllDocsListViewIcon,
  AllDocsMasonryViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Checkbox,
  DragHandle as DragHandleGlyph,
  SurfaceListDragHandle,
  SurfaceListItemIcon,
  SurfaceListSelectionSlot,
  SurfaceListText,
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
} from "react";

import { PagePreview } from "../../page-list/page-content-preview";
import { DocExplorerContext } from "../context";

export type DocListItemView = "list" | "grid" | "masonry";

export interface DocListItemProps {
  docId: string;
  groupId: string;
  inventoryPreview?: "grid" | "masonry";
  /** Typed identity used by mixed-content explorer surfaces. */
  selectionKey?: string;
  selectionGroups?: Array<{ key: string; items: string[] }>;
  /** Document IDs selected by a mixed surface for document-only DnD. */
  dragSelectionDocIds?: string[];
}

export const EXPLORER_MORE_MENU_OFFSET = {
  side: "bottom",
  align: "end",
  sideOffset: 12,
  alignOffset: -4,
} as const;

export const MixId = {
  connector: "||",
  create(groupId: string, docId: string) {
    return `${groupId}${this.connector}${docId}`;
  },
  parse(mixId: string) {
    if (!mixId) return { groupId: null, docId: null };
    const [groupId, docId] = mixId.split(this.connector);
    return { groupId, docId };
  },
};

const VIEW_ICON_MAP = {
  list: AllDocsListViewIcon,
  grid: AllDocsGridViewIcon,
  masonry: AllDocsMasonryViewIcon,
} as const;

export const DocListViewIcon = ({
  view,
  size = "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  ...props
}: {
  size?: number | string;
  view: DocListItemView;
} & SVGProps<SVGSVGElement>) => {
  const IconComponent = VIEW_ICON_MAP[view];
  return <IconComponent size={size} {...props} />;
};

export const RawDocIcon = memo(function RawDocIcon({
  id,
  ...props
}: HTMLProps<SVGSVGElement>) {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const Icon = useLiveData(id ? docDisplayMetaService.icon$(id) : null);
  return Icon ? <Icon {...props} /> : null;
});

export const RawDocTitle = memo(function RawDocTitle({ id }: { id: string }) {
  const docDisplayMetaService = useService(DocDisplayMetaService);
  return useLiveData(docDisplayMetaService.title$(id));
});

export const DocDragHandle = memo(function DocDragHandle({
  id,
  placement,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  placement?: "outside-left-center" | "outside-left-top";
}) {
  const context = useContext(DocExplorerContext);
  const selectMode = useLiveData(context.selectMode$);
  const showDragHandle = useLiveData(context.showDragHandle$);

  if (selectMode || !id || !showDragHandle) {
    return null;
  }

  return (
    <SurfaceListDragHandle placement={placement} {...props}>
      <DragHandleGlyph />
    </SurfaceListDragHandle>
  );
});

export const DocSelectionCheckbox = memo(function DocSelectionCheckbox({
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
  const context = useContext(DocExplorerContext);
  const selectMode = useLiveData(context.selectMode$);
  const selection$ = selectionKey
    ? context.selectedItemKeys$
    : context.selectedDocIds$;
  const selectedKeys = useLiveData(selection$);
  const itemKey = selectionKey ?? id ?? "";

  const handleToggle = useCallback(() => {
    if (!id || !itemKey) return;
    const current = selection$.value;
    const next = current.includes(itemKey)
      ? current.filter((candidate) => candidate !== itemKey)
      : [...current, itemKey];
    selection$.next(next);
    context.selectMode$?.next(next.length > 0);
    context.prevCheckAnchorId$?.next(
      next.length > 0 ? MixId.create(groupId, itemKey) : null,
    );
  }, [
    context.prevCheckAnchorId$,
    context.selectMode$,
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
      data-testid="doc-list-item-select"
      {...props}
    >
      <Checkbox
        aria-label={t["com.myoxus.all-docs.quick-action.select"]()}
        checked={selectedKeys.includes(itemKey)}
        onClick={(event) => event.stopPropagation()}
        onChange={handleToggle}
        size="xs"
      />
    </SurfaceListSelectionSlot>
  );
});

export const DocIcon = memo(function DocIcon({
  id,
  ...props
}: ComponentProps<typeof SurfaceListItemIcon>) {
  const showDocIcon = useLiveData(useContext(DocExplorerContext).showDocIcon$);
  if (!showDocIcon) return null;

  return (
    <SurfaceListItemIcon {...props}>
      <RawDocIcon id={id} />
    </SurfaceListItemIcon>
  );
});

export const DocTitle = memo(function DocTitle({
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

export const DocPreview = memo(function DocPreview({
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
  const showDocPreview = useLiveData(
    useContext(DocExplorerContext).showDocPreview$,
  );
  const isCloud = useService(WorkspaceService).workspace.flavour !== "local";

  if (!id || !showDocPreview) return null;

  if (kind === "preview" && isCloud) {
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

  return (
    <SurfaceListText
      kind={kind}
      lineClamp={kind === "preview" ? 6 : undefined}
      truncate={kind === "preview" ? false : undefined}
      {...props}
    >
      <PagePreview
        edgelessFallback={edgelessFallback}
        enableLocalTextFallback={enableLocalTextFallback}
        emptyFallback={emptyFallback}
        pageId={id}
        fallback={loading}
        visibleListSnippet={isCloud && kind === "description"}
      />
    </SurfaceListText>
  );
});
