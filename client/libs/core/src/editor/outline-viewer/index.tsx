import { useI18n } from "@myoxus/i18n";
import { EditorOutlineFloatingFrame } from "@myoxus/ui-facade";
import { OutlineViewer } from "@virgultum/editor/fragments/outline";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useMemo, useRef } from "react";

export const EditorOutlineViewer = ({
  editor,
  show,
  openOutlinePanel,
}: {
  editor: EditorHost | null;
  show: boolean;
  openOutlinePanel?: () => void;
}) => {
  const t = useI18n();
  const labels = useMemo(
    () => ({
      title: t["com.myoxus.sidebar.outline.title"](),
      emptyPlaceholder: t["com.myoxus.sidebar.outline.empty-placeholder"](),
      previewSettings: t["com.myoxus.sidebar.outline.preview-settings"](),
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
  const outlineViewerRef = useRef<OutlineViewer | null>(null);

  const onRefChange = useCallback(
    (container: HTMLDivElement | null) => {
      if (container && editor) {
        if (outlineViewerRef.current) {
          outlineViewerRef.current.remove();
        }
        outlineViewerRef.current = new OutlineViewer();
        outlineViewerRef.current.editor = editor;
        outlineViewerRef.current.labels = labels;
        outlineViewerRef.current.toggleOutlinePanel = openOutlinePanel ?? null;
        container.append(outlineViewerRef.current);
      }
    },
    [editor, labels, openOutlinePanel],
  );

  if (!editor || !show) return null;

  return <EditorOutlineFloatingFrame ref={onRefChange} />;
};
