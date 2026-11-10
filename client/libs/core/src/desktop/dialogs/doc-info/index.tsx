import { useGuard } from "@myoxus/core/components/guard";
import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { type Doc, DocService, DocsService } from "@myoxus/core/modules/doc";
import {
  DocumentMetadataCacheService,
  DocumentMetadataEditorView,
} from "@myoxus/core/modules/document-metadata";
import {
  GraphQLService,
  ServerService,
  UserFeatureService,
} from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServiceOptional,
  useServices,
} from "@myoxus/infra";
import { Modal } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

function DocInfoDialogContent({
  docId,
  readonly,
}: {
  docId: string;
  readonly?: boolean;
}) {
  const {
    documentMetadataCacheService: metadataCache,
    graphQLService,
    serverService,
    userFeatureService,
    workspaceDialogService,
  } = useServices({
    GraphQLService,
    DocumentMetadataCacheService,
    ServerService,
    UserFeatureService,
    WorkspaceDialogService,
  });
  const canEditDocument = useGuard("Doc_Update", docId);
  const canConfigureWorkspaceDocumentSettings = useGuard(
    "Workspace_Settings_Update",
  );
  const isMyoxusAdmin = useLiveData(userFeatureService.userFeature.isAdmin$);

  useEffect(() => {
    userFeatureService.userFeature.revalidate();
  }, [userFeatureService]);

  const onConfigureWorkspaceDocumentSettings = useCallback(() => {
    workspaceDialogService.open("workspace-settings", {
      activeTab: "workspace:documents",
    });
  }, [workspaceDialogService]);

  const onOpenGlobalDocumentPolicy = useCallback(() => {
    const adminUrl = new URL(
      "/adminfrontend/documents?tab=metadata",
      serverService.server.baseUrl,
    );
    window.open(adminUrl.toString(), "_blank", "noopener,noreferrer");
  }, [serverService.server.baseUrl]);
  return (
    <DocumentMetadataEditorView
      canConfigureWorkspaceDefaults={
        !readonly && canConfigureWorkspaceDocumentSettings
      }
      canOpenGlobalPolicy={!readonly && Boolean(isMyoxusAdmin)}
      detailsLayout="dialog"
      docId={docId}
      graphqlService={graphQLService}
      metadataCache={metadataCache}
      onConfigureWorkspaceDefaults={onConfigureWorkspaceDocumentSettings}
      onOpenGlobalPolicy={onOpenGlobalDocumentPolicy}
      readonly={readonly || !canEditDocument}
      showSummary={false}
    />
  );
}

function DocInfoDialogTitle() {
  const docService = useService(DocService);
  const title = useLiveData(docService.doc.record.title$);
  const t = useI18n();

  return title || t["Untitled"]();
}

export const DocInfoDialog = ({
  close,
  docId,
  returnFocusRef,
  readonly,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["doc-info"]>) => {
  const docsService = useService(DocsService);
  const t = useI18n();

  const [doc, setDoc] = useState<Doc | null>(null);
  const [open, setOpen] = useState(true);
  const [returnFocus, setReturnFocus] = useState(true);
  const workbench = useServiceOptional(WorkbenchService)?.workbench;
  useEffect(() => {
    if (!workbench) return;
    const origin = workbench.location$.value;
    // Native Review links may activate a retained Workbench view. Close this
    // document's outer information dialog without focusing its inactive opener.
    const sub = workbench.location$.subscribe((location) => {
      if (
        location.pathname !== origin.pathname ||
        location.search !== origin.search
      ) {
        setReturnFocus(false);
        setOpen(false);
      }
    });
    return () => sub.unsubscribe();
  }, [workbench]);
  useEffect(() => {
    if (!docId) return;
    const docRef = docsService.open(docId);
    if (!docRef) return;
    setDoc(docRef.doc);
    return () => {
      docRef.release();
      setDoc(null);
    };
  }, [docId, docsService]);

  if (!doc || !docId) return null;

  return (
    <FrameworkScope scope={doc.scope}>
      <Modal
        contentOptions={{
          "aria-label": t["com.myoxus.document-metadata.title"](),
          "data-testid": "document-metadata-dialog",
        }}
        open={open}
        onOpenChange={setOpen}
        // Release scope after native exit; navigation keeps focus in its target.
        onExitTransitionEnd={close}
        returnFocusRef={returnFocusRef}
        returnFocus={returnFocus}
        title={<DocInfoDialogTitle />}
        width="xl"
      >
        <DocInfoDialogContent docId={docId} readonly={readonly} />
      </Modal>
    </FrameworkScope>
  );
};
