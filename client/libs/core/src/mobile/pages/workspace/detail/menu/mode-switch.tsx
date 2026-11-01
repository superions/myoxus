import { EditorService } from "@myoxus/core/modules/editor";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  RadioGroup,
  type RadioItem,
  useMobileMenuController,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import { useCallback } from "react";

const EdgelessRadioItem: RadioItem = {
  value: "edgeless",
  label: "Edgeless",
  testId: "switch-edgeless-mode-button",
};
const PageRadioItem: RadioItem = {
  value: "page",
  label: "Page",
  testId: "switch-page-mode-button",
};
const items = [PageRadioItem, EdgelessRadioItem];

export const EditorModeSwitch = () => {
  const { close } = useMobileMenuController();
  const editor = useService(EditorService).editor;
  const trash = useLiveData(editor.doc.trash$);
  const isSharedMode = editor.isSharedMode;
  const currentMode = useLiveData(editor.mode$);

  const onToggle = useCallback(
    (mode: DocMode) => {
      editor.setMode(mode);
      editor.setSelector(undefined);
      track.$.header.actions.switchPageMode({ mode });
      close();
    },
    [close, editor],
  );

  if (trash || isSharedMode) {
    return null;
  }

  return (
    <RadioGroup block value={currentMode} items={items} onChange={onToggle} />
  );
};
