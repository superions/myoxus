import {
  PreconditionStrategy,
  registerMyoxusCommand,
} from "@myoxus/core/commands";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocService } from "@myoxus/core/modules/doc";
import type { Editor } from "@myoxus/core/modules/editor";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { OpenInAppService } from "@myoxus/core/modules/open-in-app";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import {
  EdgelessIcon,
  HistoryIcon,
  LocalWorkspaceIcon,
  PageIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify, useConfirmModal } from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

import { useHistoryNavigation } from "@myoxus/core/modules/doc-versioning/history-navigation";
import { useDocumentOperations } from "./use-document-operations";
import { useExportPage } from "./use-export-page";

export function useRegisterVirgultumEditorCommands(
  editor: Editor,
  active: boolean,
) {
  const doc = useService(DocService).doc;
  const guardService = useService(GuardService);
  const docId = doc.id;
  const mode = useLiveData(editor.mode$);
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;

  const editorSetting = useService(EditorSettingService).editorSetting;
  const defaultPageWidth = useLiveData(editorSetting.settings$).fullWidthLayout;
  const pageWidth = useLiveData(doc.pageWidth$);
  const checked = pageWidth ? pageWidth === "fullWidth" : defaultPageWidth;

  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const favorite = useLiveData(favAdapter.isFavorite$(docId, "doc"));
  const trash = useLiveData(doc.trash$);

  const historyNavigation = useHistoryNavigation();
  const workspaceDialogService = useService(WorkspaceDialogService);

  const openHistory = useCallback(() => {
    historyNavigation.open();
  }, [historyNavigation]);

  const openInfoModal = useCallback(() => {
    workspaceDialogService.open("doc-info", { docId });
  }, [docId, workspaceDialogService]);

  const { duplicate, moveToTrash } = useDocumentOperations();
  const exportHandler = useExportPage();
  const { openConfirmModal } = useConfirmModal();
  const onClickDelete = useCallback(() => {
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.confirmModal.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: doc.title$.value || t["Untitled"](),
      }),
      cancelText: t["com.myoxus.confirmModal.button.cancel"](),
      confirmButtonOptions: {
        variant: "error",
      },
      confirmText: t.Delete(),
      onConfirm: async () => {
        try {
          const canTrash = await guardService.can("Doc_Trash", docId);
          if (!canTrash) {
            notify({ title: t["com.myoxus.no-permission"]() });
            return;
          }
          await moveToTrash(docId);
        } catch (error) {
          console.error(error);
          const userFriendlyError = UserFriendlyError.fromAny(error);
          notify({
            title: t[`error.${userFriendlyError.name}`](userFriendlyError.data),
          });
        }
      },
    });
  }, [doc, docId, guardService, moveToTrash, openConfirmModal, t]);

  const isCloudWorkspace = workspace.flavour !== "local";

  const openInAppService = useServiceOptional(OpenInAppService);

  useEffect(() => {
    if (!active) {
      return;
    }

    const unsubs: Array<() => void> = [];
    const preconditionStrategy = () =>
      PreconditionStrategy.InPaperOrEdgeless && !trash;

    // TODO(@Peng): add back when edgeless presentation is ready

    // this is pretty hack and easy to break. need a better way to communicate with virgultum editor
    // unsubs.push(
    //   registerMyoxusCommand({
    //     id: 'editor:edgeless-presentation-start',
    //     preconditionStrategy: () => PreconditionStrategy.InEdgeless && !trash,
    //     category: 'editor:edgeless',
    //     icon: <EdgelessIcon />,
    //     label: t['com.myoxus.cmdk.editor.edgeless.presentation-start'](),
    //     run() {
    //       document
    //         .querySelector<HTMLElement>('edgeless-toolbar')
    //         ?.shadowRoot?.querySelector<HTMLElement>(
    //           '.edgeless-toolbar-left-part > edgeless-tool-icon-button:last-child'
    //         )
    //         ?.click();
    //     },
    //   })
    // );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-view-info`,
        preconditionStrategy: () =>
          PreconditionStrategy.InPaperOrEdgeless && !trash,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["com.myoxus.page-properties.page-info.view"](),
        run() {
          track.$.cmdk.docInfo.open();

          openInfoModal();
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-${favorite ? "remove-from" : "add-to"}-favourites`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: favorite
          ? t["com.myoxus.favoritePageOperation.remove"]()
          : t["com.myoxus.favoritePageOperation.add"](),
        run() {
          favAdapter.toggle(docId, "doc");
          track.$.cmdk.editor.toggleFavorite();

          notify({
            title: favorite
              ? t["com.myoxus.cmdk.editor.remove-from-favourites"]()
              : t["com.myoxus.cmdk.editor.add-to-favourites"](),
          });
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-convert-to-${
          mode === "page" ? "edgeless" : "page"
        }`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: `${t["Convert to "]()}${
          mode === "page"
            ? t["com.myoxus.pageMode.edgeless"]()
            : t["com.myoxus.pageMode.page"]()
        }`,
        run() {
          track.$.cmdk.editor.switchPageMode({
            mode: mode === "page" ? "edgeless" : "page",
          });

          editor.toggleMode();
          notify({
            title:
              mode === "page"
                ? t["com.myoxus.toastMessage.edgelessMode"]()
                : t["com.myoxus.toastMessage.pageMode"](),
          });
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:page-set-width`,
        preconditionStrategy: () => mode === "page",
        category: `editor:page`,
        icon: <PageIcon />,
        label: checked
          ? t["com.myoxus.cmdk.current-page-width-layout.standard"]()
          : t["com.myoxus.cmdk.current-page-width-layout.full-width"](),
        async run() {
          const canEdit = await guardService.can("Doc_Update", docId);
          if (!canEdit) {
            notify({ title: t["com.myoxus.no-permission"]() });
            return;
          }
          void doc.record.setPageWidth(checked ? "standard" : "fullWidth");
        },
      }),
    );

    // TODO(@Peng): should not show duplicate for journal
    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-duplicate`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["com.myoxus.header.option.duplicate"](),
        run() {
          duplicate(docId);
          track.$.cmdk.editor.createDoc({
            control: "duplicate",
          });
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-export-to-html`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["Export to HTML"](),
        async run() {
          track.$.cmdk.editor.export({
            type: "html",
          });

          exportHandler("html");
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-export-to-png`,
        preconditionStrategy: () => mode === "page" && !trash,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["Export to PNG"](),
        async run() {
          track.$.cmdk.editor.export({
            type: "png",
          });

          exportHandler("png");
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-export-to-markdown`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["Export to Markdown"](),
        async run() {
          track.$.cmdk.editor.export({
            type: "markdown",
          });

          exportHandler("markdown");
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-export-to-snapshot`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["Export to Snapshot"](),
        async run() {
          track.$.cmdk.editor.export({
            type: "snapshot",
          });

          exportHandler("snapshot");
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-move-to-trash`,
        preconditionStrategy,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["com.myoxus.moveToTrash.title"](),
        run() {
          track.$.cmdk.editor.deleteDoc();

          onClickDelete();
        },
      }),
    );

    unsubs.push(
      registerMyoxusCommand({
        id: `editor:${mode}-restore-from-trash`,
        preconditionStrategy: () =>
          PreconditionStrategy.InPaperOrEdgeless && trash,
        category: `editor:${mode}`,
        icon: mode === "page" ? <PageIcon /> : <EdgelessIcon />,
        label: t["com.myoxus.cmdk.editor.restore-from-trash"](),
        async run() {
          const canRestore = await guardService.can("Doc_Restore", docId);
          if (!canRestore) {
            notify({ title: t["com.myoxus.no-permission"]() });
            return;
          }
          track.$.cmdk.editor.restoreDoc();

          doc.restoreFromTrash();
        },
      }),
    );

    if (isCloudWorkspace) {
      unsubs.push(
        registerMyoxusCommand({
          id: `editor:${mode}-page-history`,
          category: `editor:${mode}`,
          icon: <HistoryIcon />,
          label: t["com.myoxus.history.view-history-version"](),
          run() {
            track.$.cmdk.docHistory.open();

            openHistory();
          },
        }),
      );
    }

    if (isCloudWorkspace && BUILD_CONFIG.isWeb) {
      unsubs.push(
        registerMyoxusCommand({
          id: "editor:open-in-app",
          category: `editor:${mode}`,
          icon: <LocalWorkspaceIcon />,
          label: t["com.myoxus.header.option.open-in-desktop"](),
          run() {
            openInAppService?.showOpenInAppPage();
          },
        }),
      );
    }

    unsubs.push(
      registerMyoxusCommand({
        id: "alert-ctrl-s",
        category: "myoxus:general",
        preconditionStrategy: PreconditionStrategy.Never,
        keyBinding: {
          binding: "$mod+s",
        },
        label: "",
        icon: null,
        run() {
          // do nothing
        },
      }),
    );

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [
    editor,
    favorite,
    mode,
    onClickDelete,
    exportHandler,
    t,
    trash,
    isCloudWorkspace,
    openHistory,
    duplicate,
    favAdapter,
    docId,
    doc,
    openInfoModal,
    pageWidth,
    defaultPageWidth,
    checked,
    openInAppService,
    active,
    guardService,
  ]);
}
