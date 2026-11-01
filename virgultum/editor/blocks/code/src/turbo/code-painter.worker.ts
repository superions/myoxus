import type {
  BlockLayout,
  BlockLayoutPainter,
  WorkerToHostMessage,
} from "@virgultum/gfx-turbo-renderer";
import { BlockLayoutPainterExtension } from "@virgultum/gfx-turbo-renderer/painter";

export interface CodeLayout extends BlockLayout {
  type: "myoxus:code";
}

function isCodeLayout(layout: BlockLayout): layout is CodeLayout {
  return layout.type === "myoxus:code";
}

class CodeLayoutPainter implements BlockLayoutPainter {
  paint(
    ctx: OffscreenCanvasRenderingContext2D,
    layout: BlockLayout,
    layoutBaseX: number,
    layoutBaseY: number,
  ): void {
    if (!isCodeLayout(layout)) {
      const message: WorkerToHostMessage = {
        type: "paintError",
        error: "Invalid layout format",
        blockType: "myoxus:code",
      };
      self.postMessage(message);
      return;
    }

    // Get the layout dimensions
    const x = layout.rect.x - layoutBaseX;
    const y = layout.rect.y - layoutBaseY;
    const width = layout.rect.w;
    const height = layout.rect.h;

    // Simple white rectangle for now
    ctx.fillStyle = "white";
    ctx.fillRect(x, y, width, height);

    // Add a border to visualize the code block
    ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
  }
}

export const CodeLayoutPainterExtension = BlockLayoutPainterExtension(
  "myoxus:code",
  CodeLayoutPainter,
);
