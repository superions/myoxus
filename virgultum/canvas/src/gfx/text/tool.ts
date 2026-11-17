import { DefaultTool } from "@virgultum/canvas-runtime/surface";

import { TelemetryProvider } from "@virgultum/core/services";
import type { PointerEventState } from "@virgultum/core/runtime";
import { BaseTool } from "@virgultum/core/runtime/gfx";

import { insertEdgelessTextCommand } from "./commands/insert-edgeless-text";

export class TextTool extends BaseTool {
  static override toolName: string = "text";

  override click(e: PointerEventState): void {
    const [x, y] = this.gfx.viewport.toModelCoord(e.x, e.y);
    this.gfx.std.command.exec(insertEdgelessTextCommand, { x, y });
    this.gfx.tool.setTool(DefaultTool);

    this.gfx.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
      control: "canvas:draw",
      page: "whiteboard editor",
      module: "toolbar",
      segment: "toolbar",
      type: "text",
    });
  }
}
