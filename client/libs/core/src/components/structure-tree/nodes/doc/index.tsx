import { Guard } from "@myoxus/core/components/guard";
import { useUserPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
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
import { NEVER } from "rxjs";

import {
  StructureTreeNode,
  type StructureTreeNodeDropEffect,
} from "../../tree";
import type { GenericStructureTreeNode } from "../types";
import { Empty } from "./empty";
import { useStructureTreeDocNodeOperations } from "./operations";

export const StructureTreeDocNode = ({
  docId,
  onDrop,
  location,
  reorderable,
  isLinked,
  allowLinkedDocuments = true,
  canDrop,
  operations: additionalOperations,
  dropEffect,
  parentPath,
}: {
  docId: string;
  isLinked?: boolean;
  allowLinkedDocuments?: boolean;
  forwardKey?: string;
} & GenericStructureTreeNode) => {
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
    [structureTreeStateService, path],
  );
  const isCollapsed = showLinkedDocuments ? collapsed : true;

  const docRecord = useLiveData(docsService.list.doc$(docId));
  const DocIcon = useLiveData(
    docDisplayMetaService.icon$(docId, {
      reference: isLinked,
    }),
  );
  const docTitle = useLiveData(docDisplayMetaService.title$(docId));
  const isInTrash = useLiveData(docRecord?.trash$);

  const Icon = useCallback(
    ({ className }: { className?: string }) => {
      return <DocIcon className={className} />;
    },
    [DocIcon],
  );

  const children = useLiveData(
    useMemo(
      () =>
        LiveData.from(
          !isCollapsed ? docsSearchService.watchRefsFrom(docId) : NEVER,
          null,
        ),
      [docsSearchService, docId, isCollapsed],
    ),
  );
  const searching = children === null;

  const [referencesLoading, setReferencesLoading] = useState(true);
  useLayoutEffect(() => {
    if (collapsed) {
      return;
    }
    const abortController = new AbortController();
    const undoSync = workspaceService.workspace.engine.doc.addPriority(
      docId,
      10,
    );
    const undoIndexer = docsSearchService.indexer.addPriority(docId, 10);
    docsSearchService.indexer
      .waitForDocCompleted(docId, abortController.signal)
      .then(() => {
        setReferencesLoading(false);
      })
      .catch((err) => {
        if (err !== MANUALLY_STOP) {
          console.error(err);
        }
      });
    return () => {
      undoSync();
      undoIndexer();
      abortController.abort(MANUALLY_STOP);
    };
  }, [docId, docsSearchService, workspaceService, collapsed]);

  const dndData = useMemo(() => {
    return {
      draggable: {
        entity: {
          type: "doc",
          id: docId,
        },
        from: location,
      },
      dropTarget: {
        at: "structure-tree:doc",
      },
    } satisfies MyoxusDNDData;
  }, [docId, location]);

  const handleRename = useAsyncCallback(
    async (newName: string) => {
      await docsService.changeDocTitle(docId, newName);
      track.$.navigationPanel.organize.renameOrganizeItem({ type: "doc" });
    },
    [docId, docsService],
  );

  const handleDropOnDoc = useAsyncCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (data.treeInstruction?.type === "make-child") {
        if (data.source.data.entity?.type === "doc") {
          const canEdit = await guardService.can("Doc_Update", docId);
          if (!canEdit) {
            notify({ title: t["com.myoxus.no-permission"]() });
            return;
          }
          await docsService.addLinkedDoc(docId, data.source.data.entity.id);
          track.$.navigationPanel.docs.linkDoc({
            control: "drag",
          });
          track.$.navigationPanel.docs.drop({
            type: data.source.data.entity.type,
          });
        } else {
          notify({ title: t["com.myoxus.rootAppSidebar.doc.link-doc-only"]() });
        }
      } else {
        onDrop?.(data);
      }
    },
    [docId, docsService, guardService, onDrop, t],
  );

  const handleDropEffectOnDoc = useCallback<StructureTreeNodeDropEffect>(
    (data) => {
      if (data.treeInstruction?.type === "make-child") {
        if (data.source.data.entity?.type === "doc") {
          return "link";
        }
      } else {
        return dropEffect?.(data);
      }
      return;
    },
    [dropEffect],
  );

  const handleDropOnPlaceholder = useAsyncCallback(
    async (data: DropTargetDropEvent<MyoxusDNDData>) => {
      if (data.source.data.entity?.type === "doc") {
        const canEdit = await guardService.can("Doc_Update", docId);
        if (!canEdit) {
          notify({ title: t["com.myoxus.no-permission"]() });
          return;
        }
        // TODO(eyhn): timeout&error handling
        await docsService.addLinkedDoc(docId, data.source.data.entity.id);
        track.$.navigationPanel.docs.linkDoc({
          control: "drag",
        });
        track.$.navigationPanel.docs.drop({
          type: data.source.data.entity.type,
        });
      } else {
        notify({ title: t["com.myoxus.rootAppSidebar.doc.link-doc-only"]() });
      }
    },
    [docId, docsService, guardService, t],
  );

  const handleCanDrop = useMemo<DropTargetOptions<MyoxusDNDData>["canDrop"]>(
    () => (args) => {
      const entityType = args.source.data.entity?.type;
      return args.treeInstruction?.type !== "make-child"
        ? ((typeof canDrop === "function" ? canDrop(args) : canDrop) ?? true)
        : entityType === "doc";
    },
    [canDrop],
  );

  const workspaceDialogService = useService(WorkspaceDialogService);
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

  const finalOperations = useMemo(() => {
    if (additionalOperations) {
      return [...operations, ...additionalOperations];
    }
    return operations;
  }, [additionalOperations, operations]);

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
      to={`/${docId}`}
      onClick={() => {
        track.$.navigationPanel.docs.openDoc();
      }}
      active={active}
      postfix={
        referencesLoading &&
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
      renameableGuard={{
        docId,
        action: "Doc_Update",
      }}
      onRename={handleRename}
      childrenPlaceholder={
        searching ? null : (
          <Empty
            onDrop={handleDropOnPlaceholder}
            noAccessible={!!children && children.length > 0}
          />
        )
      }
      operations={finalOperations}
      dropEffect={handleDropEffectOnDoc}
      data-testid={`structure-tree-doc-${docId}`}
      explorerIconConfig={{
        where: "doc",
        id: docId,
      }}
    >
      {showLinkedDocuments ? (
        <Guard docId={docId} permission="Doc_Read">
          {(canRead) =>
            canRead
              ? children?.map((child, index) => (
                  <StructureTreeDocNode
                    key={`${child.docId}-${index}`}
                    docId={child.docId}
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
};
