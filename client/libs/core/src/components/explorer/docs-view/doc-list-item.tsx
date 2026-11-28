// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListText,
  useDraggable,
} from "@myoxus/ui-facade";
import { useCallback, useContext } from "react";

import { DocExplorerContext } from "../context";
import { CardViewDoc } from "./doc-card";
import {
  type DocListItemProps,
  type DocListItemView,
  DocListViewIcon,
  MixId,
  RawDocIcon,
  RawDocTitle,
} from "./doc-list-primitives";
import { ListViewDoc } from "./doc-list-row";

export {
  CardViewDoc,
  type DocListItemProps,
  type DocListItemView,
  DocListViewIcon,
  ListViewDoc,
};

export const DocListItem = (props: DocListItemProps) => {
  const peekView = useService(PeekViewService).peekView;
  const context = useContext(DocExplorerContext);
  const view = useLiveData(context.view$) ?? "list";
  const groups = useLiveData(context.groups$);
  const selectMode = useLiveData(context.selectMode$);
  const selection$ = props.selectionKey
    ? context.selectedItemKeys$
    : context.selectedDocIds$;
  const selectedKeys = useLiveData(selection$);
  const selectionKey = props.selectionKey ?? props.docId;
  const dragDocIds = props.dragSelectionDocIds ?? selectedKeys;
  const prevAnchor = useLiveData(context.prevCheckAnchorId$);

  const toggleRange = useCallback(
    (anchorCursor: string, targetCursor: string) => {
      const flat = (props.selectionGroups ?? groups).flatMap((group) =>
        group.items.map((itemKey) => MixId.create(group.key, itemKey)),
      );
      const start = flat.indexOf(anchorCursor);
      const end = flat.indexOf(targetCursor);
      const [lo, hi] = start <= end ? [start, end] : [end, start];

      const nextSet = new Set(selection$.value);
      const visited = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const cursor = flat[i];
        const { groupId, docId } = MixId.parse(cursor);
        if (
          groupId === null ||
          docId === null ||
          visited.has(docId) ||
          cursor === anchorCursor
        ) {
          continue;
        }
        if (nextSet.has(docId)) {
          nextSet.delete(docId);
        } else {
          nextSet.add(docId);
        }
        visited.add(docId);
      }

      selection$.next(Array.from(nextSet));
      context.prevCheckAnchorId$?.next(targetCursor);
    },
    [context.prevCheckAnchorId$, groups, props.selectionGroups, selection$],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<Element>) => {
      const cursor = MixId.create(props.groupId, selectionKey);
      if (selectMode || event.shiftKey) {
        event.preventDefault();
      }

      if (selectMode) {
        if (event.shiftKey && prevAnchor) {
          toggleRange(prevAnchor, cursor);
        } else {
          const current = selection$.value;
          selection$.next(
            current.includes(selectionKey)
              ? current.filter((id) => id !== selectionKey)
              : [...current, selectionKey],
          );
          context.prevCheckAnchorId$?.next(cursor);
        }
        return;
      }

      if (event.shiftKey) {
        context.selectMode$?.next(true);
        selection$.next([selectionKey]);
        context.prevCheckAnchorId$?.next(cursor);
        return;
      }

      track.allDocs.list.doc.openDoc();
    },
    [
      context.prevCheckAnchorId$,
      context.selectMode$,
      prevAnchor,
      props.groupId,
      selectMode,
      selection$,
      selectionKey,
      toggleRange,
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
        entity: { type: "doc", id: props.docId },
        selection:
          dragDocIds.includes(props.docId) && dragDocIds.length > 1
            ? { type: "doc", ids: dragDocIds }
            : undefined,
        from: { at: "all-docs:list", groupId: props.groupId },
      },
    }),
    [dragDocIds, props.docId, props.groupId],
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
          ) {
            return;
          }
          event.preventDefault();
          openReading(event.currentTarget);
        }}
        data-selected={selectedKeys.includes(selectionKey)}
        data-myoxus-ui-role="doc-list-row-link"
        data-testid="doc-list-item"
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
