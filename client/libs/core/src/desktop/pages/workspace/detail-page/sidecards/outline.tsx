// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorDocumentOutline } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome/document-outline";
import { createPageOutlineController } from "@myoxus/core/editor/virgultum/doc-editor/page-outline-controller";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { EditorService } from "@myoxus/core/modules/editor";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useService, useServiceOptional } from "@myoxus/infra";
import { DocumentOutlineController } from "@virgultum/editor/fragments/outline";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useMemo } from "react";

export function EditorOutlinePanel({ editor }: { editor: EditorHost | null }) {
  const t = useI18n();
  const owner = useService(EditorService).editor;
  const displayMeta = useServiceOptional(DocDisplayMetaService);
  const guard = useServiceOptional(GuardService);
  const workspaceService = useServiceOptional(WorkspaceService);
  const store = owner.doc.virgultumDoc;

  const labels = useMemo(
    () => ({
      title: t["com.myoxus.sidebar.outline.title"](),
      emptyPlaceholder: t["com.myoxus.sidebar.outline.empty-placeholder"](),
      previewSettings: t["com.myoxus.sidebar.outline.preview-settings"](),
      settings: t["com.myoxus.sidebar.outline.settings"](),
      showTypeIcon: t["com.myoxus.sidebar.outline.show-type-icon"](),
      visibilityAndSort: t["com.myoxus.sidebar.outline.visibility-and-sort"](),
      hiddenContents: t["com.myoxus.sidebar.outline.hidden-contents"](),
      hiddenNoticeTitle: t["com.myoxus.sidebar.outline.hidden-notice-title"](),
      hiddenNoticeBody: t["com.myoxus.sidebar.outline.hidden-notice-body"](),
      hiddenNoticeActionPrefix:
        t["com.myoxus.sidebar.outline.hidden-notice-action-prefix"](),
      hiddenNoticeActionSuffix:
        t["com.myoxus.sidebar.outline.hidden-notice-action-suffix"](),
      modeBoth: t["com.myoxus.sidebar.outline.mode-both"](),
      modeEdgeless: t["com.myoxus.sidebar.outline.mode-edgeless"](),
      modePage: t["com.myoxus.sidebar.outline.mode-page"](),
      next: t["common.next"](),
      previous: t["common.previous"](),
    }),
    [t],
  );

  const resolveMessage = useCallback(
    (key: string, fallback: string) => {
      const lookup = t as unknown as Record<string, (() => string) | undefined>;
      const translator = lookup[key];
      return typeof translator === "function" ? translator() : fallback;
    },
    [t],
  );

  const resolveReference = useCallback(
    (pageId: string, workspaceId?: string) => {
      const currentWorkspaceId =
        workspaceService?.workspace.id ?? store.workspace.id;
      const meta = store.workspace.meta.docMetas.find(
        (docMeta) => docMeta.id === pageId,
      );
      const readable =
        Boolean(meta) &&
        (!workspaceId || workspaceId === currentWorkspaceId) &&
        (guard ? guard.can$("Doc_Read", pageId).value !== false : true);
      if (!readable) {
        return {
          text: t["com.myoxus.reference.target-unavailable"](),
          unavailable: true,
        };
      }
      const title =
        displayMeta?.title$(pageId).value || meta?.title || t["Untitled"]();
      return { text: title, docId: pageId };
    },
    [displayMeta, guard, store, t, workspaceService],
  );

  const controller = useMemo(
    () =>
      editor
        ? new DocumentOutlineController(editor, {
            labels,
            compactWindowRadius: 4,
            hideHeader: true,
          })
        : createPageOutlineController({
            store,
            origin$: owner.nativeOrigin$,
            labels,
            resolveReference,
            resolveMessage,
            compactWindowRadius: 4,
            hideHeader: true,
          }),
    [
      editor,
      labels,
      owner.nativeOrigin$,
      resolveMessage,
      resolveReference,
      store,
    ],
  );

  return <EditorDocumentOutline controls={controller} />;
}
