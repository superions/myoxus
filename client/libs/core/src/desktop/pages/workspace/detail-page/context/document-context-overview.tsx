// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useGuard } from "@myoxus/core/components/guard";
import { DocumentVersionsSidebar } from "@myoxus/core/modules/doc-versioning/versions-sidebar";
import { waitForDocumentVersionSync } from "@myoxus/core/modules/doc-versioning/document-sync";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useIsActiveView } from "@myoxus/core/modules/workbench";
import {
  DocumentMetadataCacheService,
  DocumentMetadataEditorView,
} from "@myoxus/core/modules/document-metadata";
import { PdfExportHistoryPanel } from "@myoxus/core/modules/pdf-export/history-panel";
import { GraphQLService } from "@myoxus/core/modules/server";
import { useService } from "@myoxus/infra";
import { Divider, Stack } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useMemo,
} from "react";

import { EditorOutlinePanel } from "../sidecards/outline";
import { DocumentOrganizationContext } from "./document-organization-context";

interface DocumentToolContentModel {
  canEdit: boolean;
  docId: string;
  docTitle: string;
  editor: EditorHost | null;
  graphQLService: GraphQLService;
  metadataCache: DocumentMetadataCacheService;
  workspaceId: string;
}

const DocumentToolContentContext =
  createContext<DocumentToolContentModel | null>(null);

export function DocumentToolContentProvider({
  children,
  docId,
  docTitle,
  editor,
  workspaceId,
}: PropsWithChildren<{
  docId: string;
  docTitle: string;
  editor: EditorHost | null;
  workspaceId: string;
}>) {
  const canEdit = useGuard("Doc_Update", docId);
  const metadataCache = useService(DocumentMetadataCacheService);
  const graphQLService = useService(GraphQLService);
  const model = useMemo<DocumentToolContentModel>(
    () => ({
      canEdit,
      docId,
      docTitle,
      editor,
      graphQLService,
      metadataCache,
      workspaceId,
    }),
    [
      canEdit,
      docId,
      docTitle,
      editor,
      graphQLService,
      metadataCache,
      workspaceId,
    ],
  );

  return (
    <DocumentToolContentContext.Provider value={model}>
      {children}
    </DocumentToolContentContext.Provider>
  );
}

function useDocumentToolContent(): DocumentToolContentModel {
  const model = useContext(DocumentToolContentContext);
  if (!model) {
    throw new Error(
      "Document tool bodies must be rendered inside DocumentToolContentProvider",
    );
  }
  return model;
}

export function DocumentOutlineToolBody() {
  const { editor } = useDocumentToolContent();

  return (
    <Stack
      data-myoxus-ui-role="document-outline-tool"
      data-testid="document-outline-tool"
    >
      <EditorOutlinePanel editor={editor} />
    </Stack>
  );
}

export function DocumentInfoToolBody() {
  const { canEdit, docId, graphQLService, metadataCache } =
    useDocumentToolContent();

  return (
    <Stack
      data-myoxus-ui-role="document-info-tool"
      data-testid="document-info-tool"
    >
      <DocumentOrganizationContext docId={docId} />
      <Divider />
      <DocumentMetadataEditorView
        detailsLayout="context"
        docId={docId}
        graphqlService={graphQLService}
        metadataCache={metadataCache}
        readonly={!canEdit}
        showSummary={false}
      />
    </Stack>
  );
}

export function DocumentVersionsToolBody() {
  const visible = useIsActiveView();
  const { workspace } = useService(WorkspaceService);
  const { canEdit, docId, graphQLService, metadataCache, workspaceId } =
    useDocumentToolContent();
  return (
    <DocumentVersionsSidebar
      beforeCapture={() => waitForDocumentVersionSync(workspace, docId)}
      refreshMetadata={() =>
        metadataCache.hydrateMetadata(docId, undefined, { refresh: true })
      }
      workspaceId={workspaceId}
      docId={docId}
      graphqlService={graphQLService}
      readonly={!canEdit}
      visible={visible}
    />
  );
}

export function DocumentPdfExportsToolBody() {
  const { docId, docTitle, graphQLService, workspaceId } =
    useDocumentToolContent();

  return (
    <PdfExportHistoryPanel
      workspaceId={workspaceId}
      docId={docId}
      docTitle={docTitle}
      graphqlService={graphQLService}
    />
  );
}
