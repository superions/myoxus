import { useI18n } from "@myoxus/i18n";
import { EditorDocumentOutline } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome/document-outline";
import { DocumentOutlineController } from "@virgultum/editor/fragments/outline";
import type { EditorHost } from "@virgultum/editor/std";
import { useMemo } from "react";

/** Shares the editor-owned outline controller without a second sidebar title. */
export const EditorOutlinePanel = ({
  editor,
}: {
  editor: EditorHost | null;
}) => {
  const t = useI18n();
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

  const controller = useMemo(
    () =>
      editor
        ? new DocumentOutlineController(editor, {
            labels,
            compactWindowRadius: 4,
            hideHeader: true,
          })
        : null,
    [editor, labels],
  );
  return controller ? <EditorDocumentOutline controls={controller} /> : null;
};
