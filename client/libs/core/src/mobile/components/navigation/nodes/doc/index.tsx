import { Guard } from "@myoxus/core/components/guard";
import type { NodeOperation } from "@myoxus/core/components/structure-tree";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { DocsSearchService } from "@myoxus/core/modules/docs-search";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  LiveData,
  MANUALLY_STOP,
  useLiveData,
  useService,
  useServices,
} from "@myoxus/infra";
import { Loading, StructureTreeLoading } from "@myoxus/ui-facade";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { AddItemPlaceholder } from "../../layouts/add-item-placeholder";
import { StructureTreeNode } from "../../tree/node";
import {
  useStructureTreeDocNodeOperations,
  useStructureTreeDocNodeOperationsMenu,
} from "./operations";

export const StructureTreeDocNode = ({
  docId,
  isLinked,
  operations: additionalOperations,
  parentPath,
}: {
  docId: string;
  isLinked?: boolean;
  operations?: NodeOperation[];
  parentPath: string[];
}) => {
  const t = useI18n();
  const {
    docsSearchService,
    docsService,
    globalContextService,
    docDisplayMetaService,
    workspaceService,
  } = useServices({
    DocsSearchService,
    WorkspaceService,
    DocsService,
    GlobalContextService,
    DocDisplayMetaService,
  });
  const structureTreeStateService = useService(StructureTreeStateService);
  const active =
    useLiveData(globalContextService.globalContext.docId.$) === docId;
  const path = useMemo(
    () => [...parentPath, `doc-${docId}`],
    [parentPath, docId],
  );
  const collapsed = useLiveData(structureTreeStateService.collapsed$(path));
  const setCollapsed = useCallback(
    (value: boolean) => {
      structureTreeStateService.setCollapsed(path, value);
    },
    [structureTreeStateService, path],
  );

  const docRecord = useLiveData(docsService.list.doc$(docId));
  const DocIcon = useLiveData(
    docDisplayMetaService.icon$(docId, {
      reference: isLinked,
    }),
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
      () => LiveData.from(docsSearchService.watchRefsFrom(docId), null),
      [docsSearchService, docId],
    ),
  );

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

  const workspaceDialogService = useService(WorkspaceDialogService);
  const option = useMemo(
    () => ({
      openInfoModal: () => workspaceDialogService.open("doc-info", { docId }),
      openNodeCollapsed: () => setCollapsed(false),
    }),
    [docId, setCollapsed, workspaceDialogService],
  );
  const operations = useStructureTreeDocNodeOperationsMenu(docId, option);
  const { handleAddLinkedPage } = useStructureTreeDocNodeOperations(
    docId,
    option,
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
      extractEmojiAsIcon
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      to={`/${docId}`}
      active={active}
      postfix={
        referencesLoading &&
        !collapsed && (
          <StructureTreeLoading>
            <Loading />
          </StructureTreeLoading>
        )
      }
      operations={finalOperations}
      data-testid={`structure-tree-doc-${docId}`}
    >
      <Guard docId={docId} permission="Doc_Read">
        {(canRead) =>
          canRead
            ? children?.map((child, index) => (
                <StructureTreeDocNode
                  key={`${child.docId}-${index}`}
                  docId={child.docId}
                  isLinked
                  parentPath={path}
                />
              ))
            : null
        }
      </Guard>
      <Guard docId={docId} permission="Doc_Update">
        {(canEdit) =>
          canEdit ? (
            <AddItemPlaceholder
              label={t["com.myoxus.rootAppSidebar.explorer.doc-add-tooltip"]()}
              onClick={handleAddLinkedPage}
            />
          ) : null
        }
      </Guard>
    </StructureTreeNode>
  );
};
