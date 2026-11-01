import { DefaultTool } from "@virgultum/block-surface";

import { TelemetryProvider } from "@virgultum/shared/services";
import type { PointerEventState } from "@virgultum/std";
import { BaseTool } from "@virgultum/std/gfx";

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
