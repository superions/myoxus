import type { DataViewSelection } from "@virgultum/data-view";
import {
  KanbanViewSelectionWithTypeSchema,
  TableViewSelectionWithTypeSchema,
} from "@virgultum/data-view/view-presets";
import { BaseSelection, SelectionExtension } from "@virgultum/store";
import { z } from "zod";

const ViewSelectionSchema = z.union([
  TableViewSelectionWithTypeSchema,
  KanbanViewSelectionWithTypeSchema,
]);

const DataViewBlockSelectionSchema = z.object({
  blockId: z.string(),
  viewSelection: ViewSelectionSchema,
});

/** Selection envelope owned by the generic `myoxus:data-view` block. */
export class DataViewBlockSelection extends BaseSelection {
  static override group = "note";

  static override type = "data-view";

  readonly viewSelection: DataViewSelection;

  constructor({
    blockId,
    viewSelection,
  }: {
    blockId: string;
    viewSelection: DataViewSelection;
  }) {
    super({ blockId });
    this.viewSelection = viewSelection;
  }

  static override fromJSON(json: Record<string, unknown>) {
    return new DataViewBlockSelection(DataViewBlockSelectionSchema.parse(json));
  }

  override equals(other: BaseSelection) {
    return (
      other instanceof DataViewBlockSelection && this.blockId === other.blockId
    );
  }

  override toJSON(): Record<string, unknown> {
    return {
      type: DataViewBlockSelection.type,
      blockId: this.blockId,
      viewSelection: this.viewSelection,
    };
  }
}

export const DataViewBlockSelectionExtension = SelectionExtension(
  DataViewBlockSelection,
);
