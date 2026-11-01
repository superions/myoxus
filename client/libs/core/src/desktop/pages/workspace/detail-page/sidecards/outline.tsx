import { useI18n } from "@myoxus/i18n";
import { Box } from "@myoxus/ui-facade";
import { OutlinePanel } from "@virgultum/editor/fragments/outline";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useEffect, useMemo, useRef } from "react";

/** Mounts the Virgultum outline without a second tool header inside Context. */
export const EditorOutlinePanel = ({
  editor,
}: {
  editor: EditorHost | null;
}) => {
  const t = useI18n();
  const outlinePanelRef = useRef<OutlinePanel | null>(null);
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

  const onRefChange = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || !editor || container.children.length > 0) return;
      const outline = new OutlinePanel();
      outline.compactWindowRadius = 4;
      outline.editor = editor;
      outline.hideHeader = true;
      outline.labels = labels;
      outlinePanelRef.current = outline;
      container.append(outline);
    },
    [editor, labels],
  );

  useEffect(() => {
    if (!outlinePanelRef.current || !editor) return;
    outlinePanelRef.current.editor = editor;
    outlinePanelRef.current.labels = labels;
  }, [editor, labels]);

  return (
    <Box
      ref={onRefChange}
      w="100%"
      data-myoxus-ui-role="editor-outline-panel-mount"
    />
  );
};
