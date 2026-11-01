import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type DeltaInsert,
  type Text,
} from "@virgultum/store";

import { TextAlign } from "../../consts";
import type { BlockMeta, TemplateRepeatBinding } from "../../utils/types";

export type TableCell = {
  text: Text;
  /** Absence inherits column, row or header paint without rewriting old cells. */
  backgroundColor?: string;
};

export interface TableRow {
  rowId: string;
  order: string;
  backgroundColor?: string;
  repeat?: TemplateRepeatBinding;
}

export interface TableColumn {
  columnId: string;
  order: string;
  backgroundColor?: string;
  /** Optional GFM column alignment; absence keeps start-aligned legacy behavior. */
  textAlign?: TextAlign;
  width?: number;
}

export type TableAppearance = "grid" | "ruled" | "plain";
export type TableDensity = "normal" | "compact";

export interface TableBlockProps extends BlockMeta {
  rows: Record<string, TableRow>;
  columns: Record<string, TableColumn>;
  // key = `${rowId}:${columnId}`
  cells: Record<string, TableCell>;
  /** Absent values retain the legacy renderer-specific first-row behavior. */
  headerRows?: number;
  /** Absent values render as the legacy grid without rewriting old source. */
  appearance?: TableAppearance;
  /** Absent values retain the legacy normal cell insets. */
  density?: TableDensity;
  comments?: Record<string, boolean>;
  textAlign?: TextAlign;
}

export interface TableCellSerialized {
  text: {
    delta: DeltaInsert[];
  };
  backgroundColor?: string;
}

export interface TableBlockPropsSerialized {
  rows: Record<string, TableRow>;
  columns: Record<string, TableColumn>;
  cells: Record<string, TableCellSerialized>;
  headerRows?: number;
  appearance?: TableAppearance;
  density?: TableDensity;
}

export const normalizeTableHeaderRows = (value: unknown, rowCount: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), Math.max(rowCount, 0));
};

export const normalizeTableAppearance = (
  value: unknown,
): TableAppearance | undefined =>
  value === "grid" || value === "ruled" || value === "plain"
    ? value
    : undefined;

export const normalizeTableDensity = (
  value: unknown,
): TableDensity | undefined =>
  value === "normal" || value === "compact" ? value : undefined;

export const normalizeTableColumnTextAlign = (
  value: unknown,
): TextAlign | undefined => {
  if (value === TextAlign.Left) return TextAlign.Left;
  if (value === TextAlign.Center) return TextAlign.Center;
  if (value === TextAlign.Right) return TextAlign.Right;
  return undefined;
};

export class TableBlockModel extends BlockModel<TableBlockProps> {}
export const TableModelFlavour = "myoxus:table";
export const TableBlockSchema = defineBlockSchema({
  flavour: TableModelFlavour,
  props: (): TableBlockProps => ({
    rows: {},
    columns: {},
    cells: {},
    headerRows: undefined,
    appearance: undefined,
    density: undefined,
    comments: undefined,
    textAlign: undefined,
    "meta:createdAt": undefined,
    "meta:createdBy": undefined,
    "meta:updatedAt": undefined,
    "meta:updatedBy": undefined,
  }),
  metadata: {
    isFlatData: true,
    role: "content",
    version: 1,
    parent: ["myoxus:footnote-definition", "myoxus:note", "myoxus:paragraph"],
    children: [],
  },
  toModel: () => new TableBlockModel(),
});

export const TableBlockSchemaExtension = BlockSchemaExtension(TableBlockSchema);
