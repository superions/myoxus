// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  editorMessage,
  EditorI18nProvider,
  NotificationProvider,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { DiagramToolbarTemplateExtension } from "@virgultum/canvas/widgets";

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

/**
 * Contributes BPMN to the categorized Edgeless Diagram templates menu under
 * Processes so sibling diagram packages stay decoupled.
 */
export const bpmnDiagramTemplate = DiagramToolbarTemplateExtension("bpmn", {
  id: "bpmn",
  label,
  category: "processes",
  run: ({ block, gfx }) => {
    if (block.store.readonly || gfx.viewport.locked) return;
    const [x, y] = gfx.viewport.toViewCoord(
      gfx.viewport.centerX,
      gfx.viewport.centerY,
    );
    insertAndOpen(block.std, { x, y });
  },
});
