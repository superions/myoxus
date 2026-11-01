// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExplorerDisplayPreference } from "@myoxus/core/components/explorer/types";
import {
  ExplorerListGroupFrame,
  type ExplorerListGroupFrameProps,
} from "@myoxus/core/components/explorer/explorer-items-view";
import { useWorkspaceTagCommands } from "@myoxus/core/components/tags";
import { DocsService } from "@myoxus/core/modules/doc";
import { type TagCatalogState, TagService } from "@myoxus/core/modules/tag";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  Button,
  type DropTargetDropEvent,
  Loading,
  Notice,
  Stack,
  useDropTarget,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

type DocumentGroup = { key: string; items: string[] };

export const tagsGroupBy = {
  type: "system",
  key: "tags",
} as const;

export const isTagsGroupBy = (groupBy: ExplorerDisplayPreference["groupBy"]) =>
  groupBy?.type === tagsGroupBy.type && groupBy.key === tagsGroupBy.key;

type DocumentDragSource = DropTargetDropEvent<MyoxusDNDData>["source"];

const droppedDocumentIds = (source: DocumentDragSource) => {
  const selection = source.data.selection;
  if (selection?.type === "doc") {
    return [...new Set(selection.ids)];
  }
  const entity = source.data.entity;
  return entity?.type === "doc" ? [entity.id] : [];
};

const droppedSourceTagGroupId = (source: DocumentDragSource) => {
  const from = source.data.from;
  return from?.at === "all-docs:list" ? from.groupId : undefined;
};

const changesTagAssignment = (
  currentTagIds: readonly string[],
  sourceTagGroupId: string | undefined,
  targetTagId: string,
) =>
  sourceTagGroupId === undefined
    ? !currentTagIds.includes(targetTagId)
    : (sourceTagGroupId !== "" && currentTagIds.includes(sourceTagGroupId)) ||
      !currentTagIds.includes(targetTagId);

/**
 * Turns a tag group into the list view's semantic assignment target. Dropping
 * on the untagged group clears the complete assignment through the same
 * server-backed controller used by the tag selector.
 *
 * The shared Explorer frame retains its native Mantine density and uses its
 * selected state as drag feedback; no route-local visual styling is required.
 */
export function AllContentTagGroupFrame({
  children,
  groupId,
}: ExplorerListGroupFrameProps) {
  const tagService = useService(TagService);
  const docsService = useService(DocsService);
  const commands = useWorkspaceTagCommands();
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const untagged = groupId === "";
  const tag = useLiveData(
    groupId ? tagService.tagList.tagByTagId$(groupId) : null,
  );
  const archived = useLiveData(tag?.archived$);
  const writable =
    catalogState.status === "ready" &&
    (untagged || (Boolean(tag) && !archived));
  const tagIdsForDocument = useCallback(
    (docId: string) =>
      docsService.list.docsMap$.value.get(docId)?.tagIds$.value ?? [],
    [docsService],
  );
  const handleDrop = useCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>) => {
      const docIds = droppedDocumentIds(data.source);
      if (!writable || docIds.length === 0) return;

      const sourceTagGroupId = droppedSourceTagGroupId(data.source);
      if (sourceTagGroupId === groupId) return;

      const actionableDocIds = untagged
        ? docIds.filter((docId) => tagIdsForDocument(docId).length > 0)
        : tag
          ? docIds.filter((docId) =>
              changesTagAssignment(
                tagIdsForDocument(docId),
                sourceTagGroupId,
                tag.id,
              ),
            )
          : [];
      if (actionableDocIds.length === 0) return;

      try {
        if (untagged) {
          await Promise.all(
            actionableDocIds.map((docId) =>
              tagService.tagList.clearPageTags(docId),
            ),
          );
        } else if (tag) {
          await Promise.all(
            actionableDocIds.map((docId) =>
              sourceTagGroupId === undefined
                ? tag.tag(docId)
                : tagService.tagList.movePageTag(
                    docId,
                    sourceTagGroupId || null,
                    tag.id,
                  ),
            ),
          );
        }
        track.$.navigationPanel.tags.tagDoc({ control: "drag" });
        track.$.navigationPanel.tags.drop({ type: "doc" });
      } catch (error) {
        commands.reportError(error);
      }
    },
    [
      commands,
      groupId,
      tag,
      tagIdsForDocument,
      tagService.tagList,
      untagged,
      writable,
    ],
  );
  const { draggedOver, dropTargetRef } = useDropTarget<MyoxusDNDData>(
    () => ({
      canDrop: ({ source }) => {
        const docIds = droppedDocumentIds(source);
        if (!writable || docIds.length === 0) return false;
        const sourceTagGroupId = droppedSourceTagGroupId(source);
        if (sourceTagGroupId === groupId) return false;
        if (untagged) {
          return docIds.some((docId) => tagIdsForDocument(docId).length > 0);
        }
        return Boolean(
          tag &&
          docIds.some((docId) =>
            changesTagAssignment(
              tagIdsForDocument(docId),
              sourceTagGroupId,
              tag.id,
            ),
          ),
        );
      },
      data: {
        at: "all-content:tag-group",
        tagId: groupId,
      },
      dropEffect: "move",
      onDrop: handleDrop,
    }),
    [groupId, handleDrop, tag, tagIdsForDocument, untagged, writable],
  );

  return (
    <ExplorerListGroupFrame
      ref={dropTargetRef}
      groupId={groupId}
      selected={draggedOver}
    >
      {children}
    </ExplorerListGroupFrame>
  );
}

/**
 * Projects the complete canonical tag catalog onto document groups.
 *
 * Empty tags and the untagged clear-target remain visible. The server catalog
 * remains authoritative; this hook owns no tag state or lifecycle commands.
 */
export function useAllContentTagScope(
  documentGroups: DocumentGroup[],
  active: boolean,
) {
  const tagList = useService(TagService).tagList;
  const catalogState =
    useLiveData(active ? tagList.catalogState$ : null) ??
    tagList.catalogState$.value;
  const groups = useMemo(() => {
    if (!active) return documentGroups;

    const groupsByKey = new Map(
      documentGroups.map((group) => [group.key, group] as const),
    );
    return [
      groupsByKey.get("") ?? { key: "", items: [] },
      ...catalogState.tags.map(
        (tag) => groupsByKey.get(tag.id) ?? { key: tag.id, items: [] },
      ),
    ];
  }, [active, catalogState.tags, documentGroups]);
  const retry = useCallback(() => {
    void tagList.retryCatalog().catch(() => undefined);
  }, [tagList]);

  return { catalogState, groups, retry };
}

export function AllContentTagCatalogState({
  state,
  onRetry,
}: {
  state: TagCatalogState;
  onRetry: () => void;
}) {
  const t = useI18n();

  if (state.status === "ready") return null;
  if (state.status === "loading") {
    return (
      <Stack data-testid="all-content-tags-loading">
        <Loading />
      </Stack>
    );
  }

  return (
    <Notice
      data-testid="all-content-tags-error"
      title={t["com.myoxus.tags.catalog.load-failed"]()}
      tone="error"
    >
      <Button variant="secondary" onClick={onRetry}>
        {t["Retry"]()}
      </Button>
    </Notice>
  );
}
