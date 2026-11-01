import { registerMyoxusCommand } from "@myoxus/core/commands";
import { EditorService } from "@myoxus/core/modules/editor";
import { ViewService, WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { EdgelessIcon, PageIcon } from "@myoxus/icons/react";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { ViewSwitcher, type ViewSwitcherItem } from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import { useCallback, useEffect, useMemo } from "react";

export interface EditorModeSwitchProps {
  pageId: string;
  isPublic?: boolean;
  publicMode?: DocMode;
}

export const EditorModeSwitch = () => {
  const t = useI18n();
  const editor = useService(EditorService).editor;
  const trash = useLiveData(editor.doc.trash$);
  const isSharedMode = editor.isSharedMode;
  const currentMode = useLiveData(editor.mode$);
  const view = useServiceOptional(ViewService)?.view;
  const workbench = useServiceOptional(WorkbenchService)?.workbench;
  const activeView = useLiveData(workbench?.activeView$);
  const isActiveView = activeView?.id && activeView?.id === view?.id;

  const togglePage = useCallback(() => {
    if (currentMode === "page" || isSharedMode || trash) return;
    editor.setMode("page");
    editor.setSelector(undefined);
    track.$.header.actions.switchPageMode({ mode: "page" });
  }, [currentMode, editor, isSharedMode, trash]);

  const toggleEdgeless = useCallback(() => {
    if (currentMode === "edgeless" || isSharedMode || trash) return;
    editor.setMode("edgeless");
    editor.setSelector(undefined);
    track.$.header.actions.switchPageMode({ mode: "edgeless" });
  }, [currentMode, editor, isSharedMode, trash]);

  const onModeChange = useCallback(
    (mode: DocMode) => {
      mode === "page" ? togglePage() : toggleEdgeless();
    },
    [toggleEdgeless, togglePage],
  );

  const shouldHide = useCallback(
    (mode: DocMode) => (trash || isSharedMode) && currentMode !== mode,
    [currentMode, isSharedMode, trash],
  );

  useEffect(() => {
    if (trash || isSharedMode || currentMode === undefined || !isActiveView)
      return;
    return registerMyoxusCommand({
      id: "myoxus:doc-mode-switch",
      category: "editor:page",
      label:
        currentMode === "page"
          ? t["com.myoxus.cmdk.switch-to-edgeless"]()
          : t["com.myoxus.cmdk.switch-to-page"](),
      icon: currentMode === "page" ? <EdgelessIcon /> : <PageIcon />,
      keyBinding: {
        binding: "Alt+KeyS",
        capture: true,
      },
      run: () => onModeChange(currentMode === "edgeless" ? "page" : "edgeless"),
    });
  }, [currentMode, isActiveView, isSharedMode, onModeChange, t, trash]);

  return (
    <PureEditorModeSwitch
      mode={currentMode}
      setMode={onModeChange}
      hidePage={shouldHide("page")}
      hideEdgeless={shouldHide("edgeless")}
    />
  );
};

export interface PureEditorModeSwitchProps {
  mode?: DocMode;
  setMode?: (mode: DocMode) => void;
  hidePage?: boolean;
  hideEdgeless?: boolean;
}

export const PureEditorModeSwitch = ({
  mode,
  setMode,
  hidePage,
  hideEdgeless,
}: PureEditorModeSwitchProps) => {
  const t = useI18n();
  const items = useMemo<ViewSwitcherItem<DocMode>[]>(() => {
    const next: ViewSwitcherItem<DocMode>[] = [];
    if (!hidePage) {
      next.push({
        value: "page",
        icon: <PageIcon />,
        label: t["Page"](),
        testId: "switch-page-mode-button",
      });
    }
    if (!hideEdgeless) {
      next.push({
        value: "edgeless",
        icon: <EdgelessIcon />,
        label: t["Edgeless"](),
        testId: "switch-edgeless-mode-button",
      });
    }
    return next;
  }, [hideEdgeless, hidePage, t]);
  return (
    <ViewSwitcher
      value={mode}
      items={items}
      onChange={setMode}
      data-myoxus-ui-role="workbench-document-header-mode-switch"
    />
  );
};
