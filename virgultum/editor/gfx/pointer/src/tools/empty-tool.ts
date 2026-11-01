import { BaseTool } from "@virgultum/std/gfx";

/**
 * Empty tool that does nothing.
 */
export class EmptyTool extends BaseTool {
  static override toolName: string = "empty";
}
