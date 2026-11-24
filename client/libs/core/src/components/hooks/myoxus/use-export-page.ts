import type { RefObject } from "react";
import { EditorService } from "@myoxus/core/modules/editor";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import {
  GraphQLService,
  FetchService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  pushGlobalLoadingEventAtom,
  resolveGlobalLoadingEventAtom,
} from "@myoxus/global-loading";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { useSetAtom } from "jotai";
import { nanoid } from "nanoid";
import { useAsyncCallback } from "../myoxus-async-hooks";
import type { ExportType } from "./page-export-actions";
/** Map a server error_class string to an i18n key. */
function pdfErrorI18nKey(
  errorClass: string | null | undefined,
  t: ReturnType<typeof useI18n>,
): { title: string; message: string } {
  switch (errorClass) {
    case "Unavailable":
      return {
        title: t["com.myoxus.export.pdf.error.unavailable"](),
        message: t["com.myoxus.export.pdf.error.unavailable"](),
      };
    case "PermissionDenied":
      return {
        title: t["com.myoxus.export.pdf.error.permission"](),
        message: t["com.myoxus.export.pdf.error.permission"](),
      };
    case "TemplateError":
      return {
        title: t["com.myoxus.export.pdf.error.template"](),
        message: t["com.myoxus.export.pdf.error.template"](),
      };
    case "Timeout":
      return {
        title: t["com.myoxus.export.pdf.error.timeout"](),
        message: t["com.myoxus.export.pdf.error.timeout"](),
      };
    case "TooLarge":
      return {
        title: t["com.myoxus.export.pdf.error.too-large"](),
        message: t["com.myoxus.export.pdf.error.too-large"](),
      };
    default:
      return {
        title: t["com.myoxus.export.pdf.error.generic"](),
        message: t["com.myoxus.export.pdf.error.generic"](),
      };
  }
}

export const useExportPage = (
  returnFocusRef?: RefObject<HTMLElement | null>,
) => {
  const editor = useService(EditorService).editor;
  const graphqlService = useService(GraphQLService);
  const workspaceService = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const guardService = useService(GuardService);
  const docsService = useService(DocsService);
  const workspaceServerService = useService(WorkspaceServerService);
  const editorContainer = useLiveData(editor.editorContainer$);
  const pageOrigin = useLiveData(editor.nativeOrigin$);
  const editorMode = useLiveData(editor.mode$);
  const virgultumDoc = editor.doc.virgultumDoc;
  const pushGlobalLoadingEvent = useSetAtom(pushGlobalLoadingEventAtom);
  const resolveGlobalLoadingEvent = useSetAtom(resolveGlobalLoadingEventAtom);
  const t = useI18n();

  const onClickHandler = useAsyncCallback(
    async (type: ExportType) => {
      if (type === "docx") {
        track.$.sharePanel.$.export({ type });
        const { startDocxExport } =
          await import("../../../modules/file-export/docx-export-notification");
        await startDocxExport(
          {
            page: virgultumDoc,
            pageMode: editorMode ?? "page",
            workspace: workspaceService.workspace,
            fetchService:
              workspaceServerService.server?.scope.get(FetchService),
          },
          returnFocusRef,
        );
        // DOCX owns its complete result, including neutral save cancellation.
        // It must never enter global loading or the generic success branch.
        return;
      }
      // Only the browser-print export path needs the mounted editor container.
      // Server PDF export opens its own dialog and performs a source-sync
      // preflight before rendering. Blocking it here made narrow Web layouts
      // unusable when the editor-container observable was not populated yet.
      if (type === "pdf" && editorContainer === null && !pageOrigin) {
        console.warn("export: browser print ignored before editor mount", {
          workspaceId: virgultumDoc.workspace.id,
          docId: virgultumDoc.id,
        });
        return;
      }

      const originEditorContainer =
        editorContainer === null
          ? pageOrigin
          : // editor container is the typed MyoxusEditorContainer
            // adapter; .origin resolves to the underlying
            // HTMLDivElement (B-03).
            editorContainer.origin;

      const globalLoadingID = type === "pdf-export" ? null : nanoid();
      if (globalLoadingID) {
        pushGlobalLoadingEvent({
          key: globalLoadingID,
        });
      }
      let actions: typeof import("./page-export-actions") | undefined;
      try {
        actions = await import("./page-export-actions");
        const result = await actions.exportHandler({
          editorRoot: editorContainer?.host ?? null,
          page: virgultumDoc,
          type,
          editorContainer: originEditorContainer,
          graphqlService,
          workspaceDialogService,
          guardService,
          docsService,
          pageMode: editorMode ?? "page",
          workspace: workspaceService.workspace,
          returnFocusRef: returnFocusRef ?? {
            current:
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null,
          },
        });
        if (type === "pdf-export") {
          if (
            result === null ||
            (result && "saved" in result && !result.saved)
          ) {
            return;
          }
          notify.success({
            title: t["com.myoxus.export.pdf.success"](),
            message: t["com.myoxus.export.pdf.success"](),
          });
          const unmapped =
            result && "unmappedFontFamilies" in result
              ? (result.unmappedFontFamilies ?? [])
              : [];
          if (unmapped.length > 0) {
            notify.warning({
              title: t["com.myoxus.export.pdf.unmapped-fonts.title"](),
              message: t["com.myoxus.export.pdf.unmapped-fonts.message"]({
                families: unmapped.join(", "),
              }),
            });
          }
        } else {
          notify.success({
            title: t["com.myoxus.export.success.title"](),
            message: t["com.myoxus.export.success.message"](),
          });
          if (
            result &&
            "markdownDiagnostics" in result &&
            result.markdownDiagnostics &&
            actions.hasMarkdownImportDiagnostics(result.markdownDiagnostics)
          ) {
            if (
              result.markdownDiagnostics.unsupportedAnnotations ||
              result.markdownDiagnostics.normalizedAnnotations
            )
              notify.warning({
                title: t["com.myoxus.markdown.annotation-diagnostics.title"](),
                message: t[
                  "com.myoxus.markdown.annotation-diagnostics.message"
                ]({
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
            if (result.markdownDiagnostics.unsupportedTables)
              notify.warning({
                message: t["com.myoxus.markdown.table-diagnostics"]({
                  count: String(result.markdownDiagnostics.unsupportedTables),
                }),
              });
            if (result.markdownDiagnostics.unsupportedMath)
              notify.warning({
                message: t["com.myoxus.markdown.math-diagnostics"]({
                  count: String(result.markdownDiagnostics.unsupportedMath),
                }),
              });
            if (result.markdownDiagnostics.normalizedEndnotes)
              notify.warning({
                message: t["com.myoxus.markdown.endnote-diagnostics"]({
                  count: String(result.markdownDiagnostics.normalizedEndnotes),
                }),
              });
          }
        }
      } catch (err: any) {
        if (type === "pdf-export") {
          if (err?.errorClass === "WorkspaceConfigurationRequired") {
            notify.warning({
              title:
                t[
                  "com.myoxus.pdf-export.dialog.empty.no-templates.notice-title"
                ](),
              message:
                t["com.myoxus.pdf-export.dialog.empty.no-templates.body"](),
            });
          } else if (err?.errorClass === "PdfExportBootstrapFailed") {
            notify.error({
              title: t["com.myoxus.pdf-export.dialog.error.load-settings"](),
              message: t["com.myoxus.export.pdf.error.unavailable"](),
            });
          } else {
            console.error(err);
            const { title, message } = pdfErrorI18nKey(err?.errorClass, t);
            notify.error({ title, message });
          }
        } else if (actions && err instanceof actions.MermaidRenderSourceError) {
          notify.error({
            title: t["com.myoxus.export.error.title"](),
            message: err.message,
          });
        } else {
          console.error(err);
          notify.error({
            title: t["com.myoxus.export.error.title"](),
            message: t["com.myoxus.export.error.message"](),
          });
        }
      } finally {
        if (globalLoadingID) {
          resolveGlobalLoadingEvent(globalLoadingID);
        }
      }
    },
    [
      virgultumDoc,
      editor,
      editorContainer,
      pageOrigin,
      editorMode,
      pushGlobalLoadingEvent,
      resolveGlobalLoadingEvent,
      graphqlService,
      workspaceService.workspace,
      workspaceDialogService,
      guardService,
      docsService,
      workspaceServerService,
      returnFocusRef,
      t,
    ],
  );

  return onClickHandler;
};
