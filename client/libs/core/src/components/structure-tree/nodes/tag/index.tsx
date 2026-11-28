// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useWorkspaceTagCommands } from "@myoxus/core/components/tags";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { type Tag, TagService } from "@myoxus/core/modules/tag";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  type DropTargetDropEvent,
  type DropTargetOptions,
  notify,
  StructureTreeColorIcon,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import {
  StructureTreeNode,
  type StructureTreeNodeDropEffect,
} from "../../tree";
import { StructureTreeDocNode } from "../doc";
import type { GenericStructureTreeNode } from "../types";
import { Empty } from "./empty";
import { useStructureTreeTagNodeOperations } from "./operations";

export function StructureTreeTagNode({
  tagId,
  onDrop,
  location,
  reorderable,
  operations: additionalOperations,
  dropEffect,
  canDrop,
  parentPath,
}: {
  tagId: string;
} & GenericStructureTreeNode) {
  const t = useI18n();
  const commands = useWorkspaceTagCommands();
  const { tagService, globalContextService } = useServices({
    TagService,
    GlobalContextService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);

  const active =
    useLiveData(globalContextService.globalContext.tagId.$) === tagId;
  const path = useMemo(
    () => [...(parentPath ?? []), `tag-${tagId}`],
    [parentPath, tagId],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [path, structureTreeStateService],
  );

  const tagRecord = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const tagArchived = useLiveData(tagRecord?.archived$);
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const writable = catalogState.status === "ready" && !tagArchived;
  const tagColor = useLiveData(tagRecord?.color$);
  const tagName = useLiveData(tagRecord?.value$);

  const Icon = useCallback(
    ({ className }: { className?: string }) => (
      <StructureTreeColorIcon className={className} color={tagColor} />
    ),
    [tagColor],
  );

  const dndData = useMemo<MyoxusDNDData>(
    () => ({
      draggable: {
        entity: { type: "tag", id: tagId },
        from: location,
      },
      dropTarget: { at: "structure-tree:tag" },
    }),
    [location, tagId],
  );

  const handleRename = useCallback(
    async (newName: string) => {
      if (!writable || !tagRecord || tagRecord.value$.value === newName) {
        return;
      }
      if (await commands.renameTag(tagRecord.id, newName)) {
        track.$.navigationPanel.organize.renameOrganizeItem({ type: "tag" });
      }
    },
    [commands, tagRecord, writable],
  );

  const tagDroppedDoc = useCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>, trackDrop: boolean) => {
      if (!tagRecord || !writable) {
        return;
      }
      if (data.source.data.entity?.type !== "doc") {
        notify({ title: t["com.myoxus.rootAppSidebar.tag.doc-only"]() });
        return;
      }
      try {
        await tagRecord.tag(data.source.data.entity.id);
        if (trackDrop) {
          track.$.navigationPanel.tags.tagDoc({ control: "drag" });
          track.$.navigationPanel.tags.drop({
            type: data.source.data.entity.type,
          });
        }
      } catch (error) {
        commands.reportError(error);
      }
    },
    [commands, t, tagRecord, writable],
  );

  const handleDropOnTag = useCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (
        data.treeInstruction?.type === "make-child" &&
        tagRecord &&
        writable
      ) {
        await tagDroppedDoc(data, true);
        return;
      }
      onDrop?.(data);
    },
    [onDrop, tagDroppedDoc, tagRecord, writable],
  );

  const handleDropEffectOnTag = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (writable && data.treeInstruction?.type === "make-child") {
        return data.source.data.entity?.type === "doc" ? "link" : undefined;
      }
      return dropEffect?.(data);
    },
    [dropEffect, writable],
  );

  const handleDropOnPlaceholder = useCallback(
    (data: DropTargetDropEvent<MyoxusDNDData>) => tagDroppedDoc(data, false),
    [tagDroppedDoc],
  );

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) =>
      args.treeInstruction?.type !== "make-child"
        ? ((typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true)
        : writable && args.source.data.entity?.type === "doc",
    [canDrop, writable],
  );

  const operations = useStructureTreeTagNodeOperations(
    tagId,
    useMemo(
      () => ({ openNodeCollapsed: () => setCollapsed(false) }),
      [setCollapsed],
    ),
  );
  const finalOperations = useMemo(
    () =>
      additionalOperations
        ? [...operations, ...additionalOperations]
        : operations,
    [additionalOperations, operations],
  );

  if (!tagRecord) {
    return null;
  }

  return (
    <StructureTreeNode
      icon={Icon}
      name={tagName || t["Untitled"]()}
      dndData={dndData}
      onDrop={handleDropOnTag}
      renameable={writable}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      to={`/tag/${tagId}`}
      active={active}
      reorderable={reorderable}
      onRename={handleRename}
      canDrop={handleCanDrop}
      childrenPlaceholder={<Empty onDrop={handleDropOnPlaceholder} />}
      operations={finalOperations}
      dropEffect={handleDropEffectOnTag}
      data-testid={`structure-tree-tag-${tagId}`}
      explorerIconConfig={{ where: "tag", id: tagId }}
    >
      <StructureTreeTagNodeDocs tag={tagRecord} path={path} />
    </StructureTreeNode>
  );
}

// Keep tag child subscriptions isolated so collapsed tag rows do not watch tag.pageIds$.
export function StructureTreeTagNodeDocs({
  tag,
  path,
}: {
  tag: Tag;
  path: string[];
}) {
  const tagDocIds = useLiveData(tag.pageIds$);

  return tagDocIds.map((docId) => (
    <StructureTreeDocNode
      key={docId}
      docId={docId}
      reorderable={false}
      location={{ at: "structure-tree:tags:docs" }}
      parentPath={path}
    />
  ));
}
