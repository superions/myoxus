import {
  ImportMenuItems,
  type ImportResult,
  type ImportType,
  useWorkspaceImport,
} from "@myoxus/core/desktop/dialogs/import";
import { useI18n } from "@myoxus/i18n";
import { ImportIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import { MenuPanel, MenuSub, notify } from "@myoxus/ui-facade";
import { hasMarkdownImportDiagnostics } from "@virgultum/editor/shared/adapters";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { useService } from "@myoxus/infra";
import { type RefObject, useCallback } from "react";

type ImportProps = {
  onComplete: (result: ImportResult) => void;
  disabled?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function notifyImportResult(
  t: ReturnType<typeof useI18n>,
  result: ImportResult,
) {
  if (
    result.markdownDiagnostics &&
    hasMarkdownImportDiagnostics(result.markdownDiagnostics)
  ) {
    if (
      result.markdownDiagnostics.unresolvedReferences ||
      result.markdownDiagnostics.unsupportedReferences
    )
      notify.warning({
        title: t["com.myoxus.import.markdown.reference-diagnostics.title"](),
        message: t["com.myoxus.import.markdown.reference-diagnostics.message"]({
          unresolved: String(result.markdownDiagnostics.unresolvedReferences),
          unsupported: String(result.markdownDiagnostics.unsupportedReferences),
        }),
      });
    if (
      result.markdownDiagnostics.unsupportedAnnotations ||
      result.markdownDiagnostics.normalizedAnnotations
    )
      notify.warning({
        title: t["com.myoxus.markdown.annotation-diagnostics.title"](),
        message: t["com.myoxus.markdown.annotation-diagnostics.message"]({
          unsupported: String(
            result.markdownDiagnostics.unsupportedAnnotations ?? 0,
          ),
          normalized: String(
            result.markdownDiagnostics.normalizedAnnotations ?? 0,
          ),
        }),
      });
    if (result.markdownDiagnostics.unsupportedCallouts)
      notify.warning({
        message: t["com.myoxus.markdown.callout-diagnostics"]({
          count: String(result.markdownDiagnostics.unsupportedCallouts),
        }),
      });
    if (result.markdownDiagnostics.unsupportedMath)
      notify.warning({
        message: t["com.myoxus.markdown.math-diagnostics"]({
          count: String(result.markdownDiagnostics.unsupportedMath),
        }),
      });
    if (result.markdownDiagnostics.unsupportedTables)
      notify.warning({
        message: t["com.myoxus.markdown.table-diagnostics"]({
          count: String(result.markdownDiagnostics.unsupportedTables),
        }),
      });
    return;
  }
  notify.success({
    title: t["com.myoxus.import.status.success.title"](),
    message: t["com.myoxus.import.status.success.message"](),
  });
}

export const Import = ({
  disabled,
  onComplete,
  returnFocusRef,
}: ImportProps) => {
  const t = useI18n();
  const dialogs = useService(WorkspaceDialogService);
  const importDocuments = useWorkspaceImport({
    returnFocusRef,
    onComplete: (result) => {
      if (result.bpmn) {
        // The shared import result surface owns per-file recovery. Do not turn
        // partial or rejected input into a generic success toast or lost attempt.
        dialogs.open("import", { bpmnImport: result.bpmn }, (completed) => {
          if (completed) onComplete(completed);
        });
        return;
      }
      onComplete(result);
      notifyImportResult(t, result);
    },
    onError: (message) => {
      if (!message) {
        return;
      }
      notify.error({
        title: t["com.myoxus.import.status.failed.title"](),
        message,
      });
    },
  });

  const handleImport = useCallback(
    (type: ImportType) => importDocuments(type),
    [importDocuments],
  );

  const handleImportMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      track.$.header.importModal.open();
    }
  }, []);

  return (
    <MenuSub
      items={
        <MenuPanel panelWidth="wide">
          <ImportMenuItems onImport={handleImport} />
        </MenuPanel>
      }
      narrowBehavior="inline"
      triggerOptions={{
        disabled,
        prefixIcon: <ImportIcon />,
        "data-testid": "editor-option-menu-import",
      }}
      subOptions={{
        onOpenChange: handleImportMenuOpenChange,
      }}
    >
      {t["Import"]()}
    </MenuSub>
  );
};
