import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type DeltaInsert,
  type Text,
} from "../../../store/index";

import { TextAlign } from "../../consts";
import type {
  BlockMeta,
  TemplateRepeatBinding,
  TextProtection,
} from "../../utils/types";

export type TableCell = {
  text: Text;
  textProtection?: TextProtection;
  /** Absence inherits column, row or header paint without rewriting old cells. */
  backgroundColor?: string;
  /** Merged horizontal span (>= 2). Omitted or 1 renders a standard single cell. */
  colspan?: number;
  /** Merged vertical span (>= 2). Omitted or 1 renders a standard single cell. */
  rowspan?: number;
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
  /** Highlights the first column as a semantic row header when true. */
  headerColumn?: boolean;
  /** Renders subtle alternating row backgrounds on body rows when true. */
  striped?: boolean;
  /** Optional table caption rendered beneath the table. */
  caption?: string;
  /** Absent values render as the legacy grid without rewriting old source. */
  appearance?: TableAppearance;
  /** Absent values retain the legacy normal cell insets. */
  density?: TableDensity;
  comments?: Record<string, boolean>;
  textAlign?: TextAlign;
}

export interface TableCellSerialized {
  textProtection?: TextProtection;
  text: {
    delta: DeltaInsert[];
  };
  backgroundColor?: string;
  colspan?: number;
  rowspan?: number;
}

export interface TableBlockPropsSerialized {
  rows: Record<string, TableRow>;
  columns: Record<string, TableColumn>;
  cells: Record<string, TableCellSerialized>;
  headerRows?: number;
  headerColumn?: boolean;
  striped?: boolean;
  caption?: string;
  appearance?: TableAppearance;
  density?: TableDensity;
}

export const normalizeTableSpan = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n >= 2 ? n : undefined;
};

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

export type TableCellSpan = { colspan: number; rowspan: number };

export type TableMergeMap = {
  /** Effective clipped spans by `"rowIndex:colIndex"` for every visible cell. */
  spans: Map<string, TableCellSpan>;
  /** Covered cell coordinates mapped to their owning anchor cell coordinates. */
  coveredBy: Map<string, { row: number; col: number }>;
};

/** Computes a deterministic, non-overlapping merge layout for an R×C grid. */
export function computeTableMergeMap(
  rowCount: number,
  colCount: number,
  getSpan: (
    row: number,
    col: number,
  ) => { colspan?: number; rowspan?: number } | undefined,
): TableMergeMap {
  const spans = new Map<string, TableCellSpan>();
  const coveredBy = new Map<string, { row: number; col: number }>();
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const key = `${r}:${c}`;
      if (coveredBy.has(key)) continue;
      const raw = getSpan(r, c);
      let colspan = Math.min(
        normalizeTableSpan(raw?.colspan) ?? 1,
        colCount - c,
      );
      let rowspan = Math.min(
        normalizeTableSpan(raw?.rowspan) ?? 1,
        rowCount - r,
      );
      // Clip span if an earlier anchor already occupies part of the rectangle.
      if (colspan > 1 || rowspan > 1) {
        let validCols = 1;
        while (validCols < colspan && !coveredBy.has(`${r}:${c + validCols}`)) {
          validCols++;
        }
        colspan = validCols;
        let validRows = 1;
        outer: while (validRows < rowspan) {
          for (let dc = 0; dc < colspan; dc++) {
            if (coveredBy.has(`${r + validRows}:${c + dc}`)) break outer;
          }
          validRows++;
        }
        rowspan = validRows;
      }
      spans.set(key, { colspan, rowspan });
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (dr === 0 && dc === 0) continue;
          coveredBy.set(`${r + dr}:${c + dc}`, { row: r, col: c });
        }
      }
    }
  }
  return { spans, coveredBy };
}

export class TableBlockModel extends BlockModel<TableBlockProps> {}
export const TableModelFlavour = "myoxus:table";
export const TableBlockSchema = defineBlockSchema({
  flavour: TableModelFlavour,
  props: (): TableBlockProps => ({
    rows: {},
    columns: {},
    cells: {},
    headerRows: undefined,
    headerColumn: undefined,
    striped: undefined,
    caption: undefined,
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
