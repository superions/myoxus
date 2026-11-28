// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Guard } from "@myoxus/core/components/guard";
import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import {
  navigationTargets,
  OutgoingNavigationService,
} from "@myoxus/core/modules/doc-link";
import { DocsSearchService } from "@myoxus/core/modules/docs-search";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { GuardService } from "@myoxus/core/modules/permissions";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import {
  LiveData,
  MANUALLY_STOP,
  useLiveData,
  useService,
  useServices,
} from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  type DropTargetDropEvent,
  type DropTargetOptions,
  Loading,
  notify,
  StructureTreeLoading,
  Tooltip,
} from "@myoxus/ui-facade";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { map, NEVER } from "rxjs";

import {
  StructureTreeNode,
  type StructureTreeNodeDropEffect,
} from "../../tree";
import type { GenericStructureTreeNode } from "../types";
import { Empty } from "./empty";
import { useStructureTreeDocNodeOperations } from "./operations";

export interface StructureTreeDocNodeProps extends GenericStructureTreeNode {
  docId: string;
  isLinked?: boolean;
  targetParams?: URLSearchParams;
  allowLinkedDocuments?: boolean;
  forwardKey?: string;
}

export function StructureTreeDocNode({
  docId,
  onDrop,
  location,
  reorderable,
  isLinked,
  targetParams,
  allowLinkedDocuments = true,
  canDrop,
  operations: additionalOperations,
  dropEffect,
  parentPath,
}: StructureTreeDocNodeProps) {
  const t = useI18n();
  const {
    docsSearchService,
    workspaceService,
    docsService,
    globalContextService,
    docDisplayMetaService,
    guardService,
  } = useServices({
    WorkspaceService,
    DocsSearchService,
    DocsService,
    GlobalContextService,
    DocDisplayMetaService,
    GuardService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);
  const outgoing = useService(OutgoingNavigationService);
  const workspaceDialogService = useService(WorkspaceDialogService);

  const serverTree =
    BUILD_CONFIG.isWeb && workspaceService.workspace.flavour !== "local";
  const { effectivePreferences } = useUserPreferences();
  const showLinkedDocuments =
    allowLinkedDocuments && (effectivePreferences?.showLinkedDocuments ?? true);

  const active =
    useLiveData(globalContextService.globalContext.docId.$) === docId;
  const path = useMemo(
    () => [...(parentPath ?? []), `doc-${docId}`],
    [parentPath, docId],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [path, structureTreeStateService],
  );
  const isCollapsed = showLinkedDocuments ? collapsed : true;

  const docRecord = useLiveData(docsService.list.doc$(docId));
  const DocIcon = useLiveData(
    docDisplayMetaService.icon$(docId, { reference: isLinked }),
  );
  const docTitle = useLiveData(docDisplayMetaService.title$(docId));
  const isInTrash = useLiveData(docRecord?.trash$);

  const Icon = useCallback(
    ({ className }: { className?: string }) => (
      <DocIcon className={className} />
    ),
    [DocIcon],
  );

  const children = useLiveData(
    useMemo(
      () =>
        LiveData.from(
          isCollapsed
            ? NEVER
            : serverTree
              ? outgoing
                  .watch(docId)
                  .pipe(
                    map(
                      (blocks) => blocks && navigationTargets(blocks, [docId]),
                    ),
                  )
              : docsSearchService.watchRefsFrom(docId),
          null,
        ),
      [docId, docsSearchService, isCollapsed, outgoing, serverTree],
    ),
  );
  const searching = children === null;

  const [referencesLoading, setReferencesLoading] = useState(true);
  useLayoutEffect(() => {
    if (serverTree || collapsed) {
      return;
    }
    const controller = new AbortController();
    const releaseSync = workspaceService.workspace.engine.doc.addPriority(
      docId,
      10,
    );
    const releaseIndex = docsSearchService.indexer.addPriority(docId, 10);
    docsSearchService.indexer
      .waitForDocCompleted(docId, controller.signal)
      .then(() => setReferencesLoading(false))
      .catch((error) => {
        if (error !== MANUALLY_STOP) {
          console.error(error);
        }
      });
    return () => {
      releaseSync();
      releaseIndex();
      controller.abort(MANUALLY_STOP);
    };
  }, [collapsed, docId, docsSearchService, serverTree, workspaceService]);

  const dndData = useMemo<MyoxusDNDData>(
    () => ({
      draggable: {
        entity: { type: "doc", id: docId },
        from: location,
      },
      dropTarget: { at: "structure-tree:doc" },
    }),
    [docId, location],
  );

  const handleRename = useAsyncCallback(
    async (newName: string) => {
      await docsService.changeDocTitle(docId, newName);
      track.$.navigationPanel.organize.renameOrganizeItem({ type: "doc" });
    },
    [docId, docsService],
  );

  const linkDroppedDoc = useAsyncCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (data.source.data.entity?.type !== "doc") {
        notify({ title: t["com.myoxus.rootAppSidebar.doc.link-doc-only"]() });
        return;
      }
      const canEdit = await guardService.can("Doc_Update", docId);
      if (!canEdit) {
        notify({ title: t["com.myoxus.no-permission"]() });
        return;
      }
      await docsService.addLinkedDoc(docId, data.source.data.entity.id);
      track.$.navigationPanel.docs.linkDoc({ control: "drag" });
      track.$.navigationPanel.docs.drop({ type: data.source.data.entity.type });
    },
    [docId, docsService, guardService, t],
  );

  const handleDropOnDoc = useAsyncCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (data.treeInstruction?.type === "make-child") {
        await linkDroppedDoc(data);
        return;
      }
      onDrop?.(data);
    },
    [linkDroppedDoc, onDrop],
  );

  const handleDropEffectOnDoc = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (data.treeInstruction?.type === "make-child") {
        return data.source.data.entity?.type === "doc" ? "link" : undefined;
      }
      return dropEffect?.(data);
    },
    [dropEffect],
  );

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) =>
      args.treeInstruction?.type !== "make-child"
        ? ((typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true)
        : args.source.data.entity?.type === "doc",
    [canDrop],
  );

  const operations = useStructureTreeDocNodeOperations(
    docId,
    useMemo(
      () => ({
        openInfoModal: () => workspaceDialogService.open("doc-info", { docId }),
        openNodeCollapsed: () => setCollapsed(false),
        showLinkedDocuments,
      }),
      [docId, setCollapsed, showLinkedDocuments, workspaceDialogService],
    ),
  );

  const finalOperations = useMemo(
    () =>
      additionalOperations
        ? [...operations, ...additionalOperations]
        : operations,
    [additionalOperations, operations],
  );

  if (isInTrash || !docRecord) {
    return null;
  }

  return (
    <StructureTreeNode
      icon={Icon}
      name={docTitle}
      dndData={dndData}
      onDrop={handleDropOnDoc}
      renameable
      extractEmojiAsIcon
      collapsed={isCollapsed}
      setCollapsed={setCollapsed}
      collapsible={showLinkedDocuments}
      canDrop={handleCanDrop}
      to={targetParams?.size ? `/${docId}?${targetParams}` : `/${docId}`}
      onClick={() => {
        track.$.navigationPanel.docs.openDoc();
      }}
      active={active}
      postfix={
        (serverTree ? searching : referencesLoading) &&
        !isCollapsed && (
          <Tooltip
            content={t["com.myoxus.rootAppSidebar.docs.references-loading"]()}
          >
            <StructureTreeLoading>
              <Loading />
            </StructureTreeLoading>
          </Tooltip>
        )
      }
      reorderable={reorderable}
      renameableGuard={{ docId, action: "Doc_Update" }}
      onRename={handleRename}
      childrenPlaceholder={
        searching ? null : (
          <Empty
            onDrop={linkDroppedDoc}
            noAccessible={!!children && children.length > 0}
          />
        )
      }
      operations={finalOperations}
      dropEffect={handleDropEffectOnDoc}
      data-testid={`structure-tree-doc-${docId}`}
      explorerIconConfig={{ where: "doc", id: docId }}
    >
      {showLinkedDocuments ? (
        <Guard docId={docId} permission="Doc_Read">
          {(canRead) =>
            canRead
              ? children?.map((child, index) => (
                  <StructureTreeDocNode
                    key={`${child.docId}-${index}`}
                    docId={child.docId}
                    targetParams={serverTree ? child.params : undefined}
                    reorderable={false}
                    location={{
                      at: "structure-tree:doc:linked-docs",
                      docId,
                    }}
                    parentPath={path}
                    isLinked
                  />
                ))
              : null
          }
        </Guard>
      ) : null}
    </StructureTreeNode>
  );
}
