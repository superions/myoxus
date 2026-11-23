// SPDX-License-Identifier: AGPL-3.0-or-later
import { NoteTool } from "@virgultum/canvas/gfx";
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  editorMessage,
  EditorI18nProvider,
  NotificationProvider,
  resolveEditorMessage,
} from "@virgultum/core/services";
import {
  type QuickTool,
  QuickToolExtension,
  EDGELESS_TOOLBAR_WIDGET,
  type EdgelessToolbarWidget,
  type ToolBuilder,
} from "@virgultum/canvas/widgets";

import { insertBpmnEdgelessNote } from "./edgeless-insertion.js";
import { requestBpmnEditor } from "./session-request.js";

const label = editorMessage(
  "com.myoxus.editor.bpmn.slash-name",
  "BPMN diagram",
);
const failure = editorMessage(
  "com.myoxus.common.operation-failed",
  "Operation failed",
);

function insertAndOpen(
  std: BlockStdScope,
  point: { x: number; y: number },
  width?: number,
  height?: number,
) {
  const failed = () =>
    std
      .getOptional(NotificationProvider)
      ?.toast(
        resolveEditorMessage(
          failure,
          std.getOptional(EditorI18nProvider) ?? undefined,
        ),
      );
  try {
    const result = insertBpmnEdgelessNote(std, point, width, height);
    if (!result.ok) {
      failed();
      return;
    }
    // Host-open failure retains the valid note/block for its existing Open retry.
    void requestBpmnEditor(std, result.blockId).catch(failed);
  } catch {
    failed();
  }
}

const insertionByScope = new WeakMap<
  BlockStdScope,
  (point: { x: number; y: number }, width?: number, height?: number) => void
>();

export const buildBpmnQuickTool: ToolBuilder<QuickTool> = ({
  block,
  gfx,
  toolbarContainer,
}) => {
  const std = block.std;
  let insert = insertionByScope.get(std);
  if (!insert) {
    insert = (point, width, height) => insertAndOpen(std, point, width, height);
    insertionByScope.set(std, insert);
  }
  const text = resolveEditorMessage(
    label,
    std.getOptional(EditorI18nProvider) ?? undefined,
  );
  const insertAtCenter = () => {
    const [x, y] = gfx.viewport.toViewCoord(
      gfx.viewport.centerX,
      gfx.viewport.centerY,
    );
    insert({ x, y });
  };
  const currentTool = gfx.tool.currentToolOption$.value;
  return {
    type: "bpmn",
    content: {
      type: "control",
      controls: {
        action: {
          id: "myoxus-bpmn-edgeless-toolbar-button",
          icon: "WorkflowIcon",
          label: text,
          disabled: false,
          active:
            currentTool?.toolType === NoteTool &&
            currentTool.options?.createNote === insert,
          run: (_anchor, event) => {
            if (block.store.readonly || gfx.viewport.locked) return;
            const toolbar = toolbarContainer.closest<EdgelessToolbarWidget>(
              EDGELESS_TOOLBAR_WIDGET,
            );
            toolbar?.activePopper?.dispose();
            if (toolbar) toolbar.activePopper = null;
            // Keyboard activation has no pointer target; use the visible center.
            if ((event as MouseEvent).detail === 0) {
              insertAtCenter();
              return;
            }
            gfx.tool.setTool(NoteTool, {
              childFlavour: "myoxus:paragraph",
              childType: "text",
              tip: text,
              createNote: insert,
            });
          },
        },
      },
    },
    enable: !block.store.readonly,
    priority: 84,
    menu: {
      id: "canvas-overflow-bpmn",
      label: text,
      icon: "WorkflowIcon",
      disabled: block.store.readonly,
      run: insertAtCenter,
    },
  };
};

export const bpmnQuickTool = QuickToolExtension("bpmn", buildBpmnQuickTool);
