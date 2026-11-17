// SPDX-License-Identifier: AGPL-3.0-or-later
import { NoteTool } from "@virgultum/canvas/gfx";
import { type BlockStdScope, ShadowlessElement } from "@virgultum/core/runtime";
import {
  editorMessage,
  EditorI18nProvider,
  EditorChromeHostIdentifier,
  NotificationProvider,
  resolveEditorMessage,
} from "@virgultum/core/services";
import {
  type QuickTool,
  QuickToolExtension,
  QuickToolMixin,
  type ToolBuilder,
} from "@virgultum/canvas/widgets";
import { css, html, nothing } from "lit";

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

export class EdgelessBpmnToolButton extends QuickToolMixin(ShadowlessElement) {
  static override styles = css`
    myoxus-bpmn-edgeless-tool-button {
      display: flex;
    }
  `;
  override type = NoteTool;

  private get label() {
    return resolveEditorMessage(
      label,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  private readonly insert = (
    point: { x: number; y: number },
    width?: number,
    height?: number,
  ) => {
    insertAndOpen(this.edgeless.std, point, width, height);
  };

  private activate(event: MouseEvent) {
    if (this.edgeless.store.readonly || this.gfx.viewport.locked) return;
    this.toolbar.activePopper?.dispose();
    this.toolbar.activePopper = null;
    if (event.detail === 0) {
      // Keyboard activation has no canvas pointer target. Use the current visible
      // center through the same native note coordinate owner, including pan/zoom.
      const [x, y] = this.gfx.viewport.toViewCoord(
        this.gfx.viewport.centerX,
        this.gfx.viewport.centerY,
      );
      this.insert({ x, y });
      return;
    }
    this.gfx.tool.setTool(NoteTool, {
      childFlavour: "myoxus:paragraph",
      childType: "text",
      tip: this.label,
      createNote: this.insert,
    });
  }

  override render() {
    return (
      this.edgeless.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderCanvasTool({
          action: {
            id: "myoxus-bpmn-edgeless-toolbar-button",
            icon: "WorkflowIcon",
            label: this.label,
            active:
              this.active &&
              this.edgelessTool?.options?.createNote === this.insert,
            disabled: false,
            // Preserve detail=0 keyboard placement through the existing note coordinate owner.
            run: (_anchor, event) => this.activate(event as MouseEvent),
          },
        }) ?? nothing
    );
  }
}

export const buildBpmnQuickTool: ToolBuilder<QuickTool> = ({ block, gfx }) => ({
  type: "bpmn",
  content: html`<myoxus-bpmn-edgeless-tool-button
    .edgeless=${block}
  ></myoxus-bpmn-edgeless-tool-button>`,
  enable: !block.store.readonly,
  priority: 84,
  menu: {
    id: "canvas-overflow-bpmn",
    label: resolveEditorMessage(
      label,
      block.std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    icon: "WorkflowIcon",
    disabled: block.store.readonly,
    run: () => {
      const [x, y] = gfx.viewport.toViewCoord(
        gfx.viewport.centerX,
        gfx.viewport.centerY,
      );
      insertAndOpen(block.std, { x, y });
    },
  },
});

export const bpmnQuickTool = QuickToolExtension("bpmn", buildBpmnQuickTool);
