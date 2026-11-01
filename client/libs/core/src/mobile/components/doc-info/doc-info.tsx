import { useGuard } from "@myoxus/core/components/guard";
import {
  DocumentMetadataDetails,
  DocumentMetadataProvider,
  shouldShowDocumentMetadata,
} from "@myoxus/core/modules/document-metadata";
import { JournalService } from "@myoxus/core/modules/journal";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useLiveData, useServices } from "@myoxus/infra";
import {
  MobileDocInfoSheetRoot,
  MobileDocInfoSheetViewport,
} from "@myoxus/ui-facade";
import { Suspense } from "react";

export const DocInfoSheet = ({ docId }: { docId: string }) => {
  const { journalService, workspaceService } = useServices({
    JournalService,
    WorkspaceService,
  });

  const canEditProperty = useGuard("Doc_Update", docId);
  const journalDate = useLiveData(journalService.journalDate$(docId));
  const showDocumentMetadata = shouldShowDocumentMetadata({
    isJournal: Boolean(journalDate),
    workspaceFlavour: workspaceService.workspace.flavour,
  });

  return (
    <MobileDocInfoSheetRoot>
      <MobileDocInfoSheetViewport data-testid="doc-info-menu">
        <Suspense>
          {showDocumentMetadata ? (
            <DocumentMetadataProvider docId={docId} readonly={!canEditProperty}>
              <DocumentMetadataDetails layout="embedded" />
            </DocumentMetadataProvider>
          ) : null}
        </Suspense>
      </MobileDocInfoSheetViewport>
    </MobileDocInfoSheetRoot>
  );
};
