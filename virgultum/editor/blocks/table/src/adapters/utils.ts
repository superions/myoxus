import { rgbaToHex8 } from "@virgultum/components/color-picker/utils";
import type {
  TableBlockPropsSerialized,
  TableAppearance,
  TableCellSerialized,
  TableColumn,
  TableDensity,
  TableRow,
} from "@virgultum/model";
import {
  normalizeTableAppearance,
  normalizeTableColumnTextAlign,
  normalizeTableDensity,
  normalizeTableHeaderRows,
} from "@virgultum/model";
import {
  HastUtils,
  type HtmlAST,
  type InlineHtmlAST,
  type MarkdownAST,
} from "@virgultum/shared/adapters";
import { generateFractionalIndexingKeyBetween } from "@virgultum/shared/utils";
import { type DeltaInsert, nanoid } from "@virgultum/store";
import type { Element } from "hast";
import type { Table as MarkdownTable } from "mdast";

import { cellColorList, colorList } from "../color";
import { compareTableOrder } from "../utils";

type RichTextType = DeltaInsert[];
const createRichText = (text: RichTextType) => {
  return {
    "$virgultum:internal:text$": true,
    delta: text,
  };
};
function calculateColumnWidths(rows: string[][]): number[] {
  return (
    rows[0]?.map((_, colIndex) =>
      Math.max(...rows.map((row) => (row[colIndex] || "").length)),
    ) ?? []
  );
}

function formatRow(
  row: string[],
  columnWidths: number[],
  isHeader: boolean,
): string {
  const cells = row.map((cell, colIndex) =>
    cell?.padEnd(columnWidths[colIndex] ?? 0, " "),
  );
  const rowString = `| ${cells.join(" | ")} |`;
  return isHeader
    ? `${rowString}\n${formatSeparator(columnWidths)}`
    : rowString;
}

function formatSeparator(columnWidths: number[]): string {
  const separator = columnWidths.map((width) => "-".repeat(width)).join(" | ");
  return `| ${separator} |`;
}

export function formatTable(rows: string[][]): string {
  const columnWidths = calculateColumnWidths(rows);
  const formattedRows = rows.map((row, index) =>
    formatRow(row, columnWidths, index === 0),
  );
  return formattedRows.join("\n");
}
type Table = {
  align: Array<"left" | "center" | "right" | null>;
  widths: Array<number | undefined>;
  rows: Row[];
};
type Row = {
  cells: Cell[];
};
type Cell = {
  value: { delta: DeltaInsert[] };
  backgroundColor?: string;
};
export const processTable = (
  columns: Record<string, TableColumn>,
  rows: Record<string, TableRow>,
  cells: Record<string, TableCellSerialized>,
): Table => {
  const sortedColumns = Object.values(columns).sort((a, b) =>
    compareTableOrder(a.order, a.columnId, b.order, b.columnId),
  );
  const sortedRows = Object.values(rows).sort((a, b) =>
    compareTableOrder(a.order, a.rowId, b.order, b.rowId),
  );
  const table: Table = {
    align: sortedColumns.map(
      (column) => normalizeTableColumnTextAlign(column.textAlign) ?? null,
    ),
    widths: sortedColumns.map((column) =>
      typeof column.width === "number" &&
      Number.isFinite(column.width) &&
      column.width > 0
        ? column.width
        : undefined,
    ),
    rows: [],
  };
  sortedRows.forEach((r) => {
    const row: Row = {
      cells: [],
    };
    sortedColumns.forEach((col) => {
      const cell = cells[`${r.rowId}:${col.columnId}`];
      const backgroundColor =
        cell?.backgroundColor ?? col.backgroundColor ?? r.backgroundColor;
      row.cells.push({
        value: cell?.text ?? { delta: [] },
        ...(backgroundColor === undefined ? {} : { backgroundColor }),
      });
    });
    table.rows.push(row);
  });
  return table;
};

/** Common semantic sections; HTML layout and Markdown cell syntax stay separate. */
export const tableHtmlSections = (
  table: Table,
  headerRows: number | undefined,
  cell: (cell: Cell, header: boolean, column: number) => InlineHtmlAST,
): Element[] => {
  const count =
    headerRows === undefined
      ? 0
      : normalizeTableHeaderRows(headerRows, table.rows.length);
  const section = (
    tagName: "thead" | "tbody",
    rows: Row[],
    header: boolean,
  ): Element => ({
    type: "element",
    tagName,
    properties: {},
    children: rows.map((row) => ({
      type: "element",
      tagName: "tr",
      properties: {},
      children: row.cells.map((value, column) => cell(value, header, column)),
    })),
  });
  return [
    ...(count > 0 ? [section("thead", table.rows.slice(0, count), true)] : []),
    ...(count < table.rows.length
      ? [section("tbody", table.rows.slice(count), false)]
      : []),
  ];
};

export const createTableProps = (
  deltasLists: RichTextType[][],
  headerRows = 0,
  presentation?: {
    appearance?: TableAppearance;
    density?: TableDensity;
  },
  align?: MarkdownTable["align"],
) => {
  const createIdAndOrder = (count: number) => {
    const result: { id: string; order: string }[] = Array.from({
      length: count,
    });
    for (let i = 0; i < count; i++) {
      const id = nanoid();
      const order = generateFractionalIndexingKeyBetween(
        result[i - 1]?.order ?? null,
        null,
      );
      result[i] = { id, order };
    }
    return result;
  };
  const columnCount = Math.max(...deltasLists.map((row) => row.length));
  const rowCount = deltasLists.length;

  const columns: TableColumn[] = createIdAndOrder(columnCount).map(
    (v, index) => {
      const textAlign = normalizeTableColumnTextAlign(align?.[index]);
      return {
        columnId: v.id,
        order: v.order,
        ...(textAlign === undefined ? {} : { textAlign }),
      };
    },
  );
  const rows: TableRow[] = createIdAndOrder(rowCount).map((v) => ({
    rowId: v.id,
    order: v.order,
  }));

  const cells: Record<string, TableCellSerialized> = {};
  for (let i = 0; i < rowCount; i++) {
    for (let j = 0; j < columnCount; j++) {
      const row = rows[i];
      const column = columns[j];
      if (!row || !column) {
        continue;
      }
      const cellId = `${row.rowId}:${column.columnId}`;
      const text = deltasLists[i]?.[j];
      cells[cellId] = {
        text: createRichText(text ?? []),
      };
    }
  }
  return {
    columns: Object.fromEntries(
      columns.map((column) => [column.columnId, column]),
    ),
    rows: Object.fromEntries(rows.map((row) => [row.rowId, row])),
    cells,
    headerRows: normalizeTableHeaderRows(headerRows, rowCount),
    ...(presentation?.appearance === undefined
      ? {}
      : { appearance: presentation.appearance }),
    ...(presentation?.density === undefined
      ? {}
      : { density: presentation.density }),
  };
};

const directElements = (element: Element) =>
  element.children.filter(HastUtils.isElement);

const directRows = (element: Element) =>
  directElements(element).filter((child) => child.tagName === "tr");

const rowCells = (row: Element) =>
  directElements(row).filter(
    (child) => child.tagName === "th" || child.tagName === "td",
  );

const parseExplicitHeaderRows = (value: unknown) => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return Number.NaN;
};

const tableFillReferences = new Set(
  [...colorList, ...cellColorList].map(({ color }) =>
    color.replace(/^var\((--[\w-]+)\)$/, "$1"),
  ),
);

/** Admit literal paint and known table tokens without evaluating imported CSS. */
const normalizeTableCellFill = (value: string | undefined) => {
  if (!value) return;
  const fill = value.trim().toLowerCase();
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(fill)?.[1] ?? fill;
  if (tableFillReferences.has(reference)) return reference;
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(fill))
    return fill;

  const rgb = /^rgba?\(([^()]*)\)$/.exec(fill)?.[1];
  if (!rgb) return;
  const commaSyntax = rgb.includes(",");
  const parts = rgb.split("/");
  const components = parts[0];
  if (components === undefined) return;
  if (parts.length > 2 || (commaSyntax && parts.length > 1)) return;
  const channels = commaSyntax
    ? rgb.split(",").map((part) => part.trim())
    : components.trim().split(/\s+/);
  if (!commaSyntax) {
    if (channels.length !== 3) return;
    if (parts[1] !== undefined) channels.push(parts[1].trim());
  }
  if (channels.length !== 3 && channels.length !== 4) return;
  const values = channels.map((part, index) => {
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(part)) return Number.NaN;
    const max = part.endsWith("%") ? 100 : index < 3 ? 255 : 1;
    const value = parseFloat(part);
    return value <= max ? value / max : Number.NaN;
  });
  const [r, g, b, a = 1] = values;
  if (
    r === undefined ||
    g === undefined ||
    b === undefined ||
    !values.every(Number.isFinite)
  )
    return;
  return rgbaToHex8({
    r,
    g,
    b,
    a,
  });
};

const cellStyle = (
  cell: Element,
  property: "background-color" | "text-align",
) => {
  const style = cell.properties.style;
  if (typeof style !== "string") return;
  const declaration = style
    .split(";")
    .reverse()
    .find(
      (part) =>
        part.slice(0, part.indexOf(":")).trim().toLowerCase() === property,
    );
  return declaration?.slice(declaration.indexOf(":") + 1).trim();
};

export const parseTableFromHtml = (
  element: Element,
  astToDelta: (ast: HtmlAST) => RichTextType,
): TableBlockPropsSerialized => {
  const sections = directElements(element);
  const rowSections = sections.filter((section) =>
    ["tr", "thead", "tbody", "tfoot"].includes(section.tagName),
  );
  const allRows = rowSections.flatMap((section) =>
    section.tagName === "tr" ? [section] : directRows(section),
  );
  const rowTextLists: RichTextType[][] = [];
  allRows.forEach((tableRow) => {
    const row: RichTextType[] = [];
    rowCells(tableRow).forEach((cell) => {
      row.push(astToDelta(cell));
    });
    rowTextLists.push(row);
  });

  const explicit = Object.hasOwn(
    element.properties,
    "dataMyoxusTableHeaderRows",
  );
  let headerRows: number;
  if (explicit) {
    headerRows = parseExplicitHeaderRows(
      element.properties.dataMyoxusTableHeaderRows,
    );
  } else if (rowSections.some((section) => section.tagName === "thead")) {
    headerRows = 0;
    for (const section of rowSections) {
      if (section.tagName !== "thead") break;
      headerRows += directRows(section).length;
    }
  } else {
    headerRows = 0;
    for (const row of allRows) {
      const cells = rowCells(row);
      if (cells.length === 0 || cells.some((cell) => cell.tagName !== "th")) {
        break;
      }
      headerRows += 1;
    }
  }
  const align = Array.from(
    { length: Math.max(0, ...allRows.map((row) => rowCells(row).length)) },
    (_, column) => {
      for (const row of allRows) {
        const cell = rowCells(row)[column];
        const value = cell && cellStyle(cell, "text-align")?.toLowerCase();
        if (value) return normalizeTableColumnTextAlign(value) ?? null;
      }
      return null;
    },
  );
  const props = createTableProps(
    rowTextLists,
    headerRows,
    {
      appearance: normalizeTableAppearance(
        element.properties.dataMyoxusTableAppearance,
      ),
      density: normalizeTableDensity(element.properties.dataMyoxusTableDensity),
    },
    align,
  );
  const rows = Object.keys(props.rows);
  const columns = Object.keys(props.columns);
  allRows.forEach((row, rowIndex) => {
    rowCells(row).forEach((cell, columnIndex) => {
      const fill = normalizeTableCellFill(cellStyle(cell, "background-color"));
      const nativeCell =
        props.cells[`${rows[rowIndex]}:${columns[columnIndex]}`];
      if (fill && nativeCell) nativeCell.backgroundColor = fill;
    });
  });
  return props;
};

export const parseTableFromMarkdown = (
  node: MarkdownTable,
  astToDelta: (ast: MarkdownAST) => RichTextType,
) => {
  const rowTextLists: RichTextType[][] = [];
  node.children.forEach((row) => {
    const rowText: RichTextType[] = [];
    row.children.forEach((cell) => {
      rowText.push(astToDelta(cell));
    });
    rowTextLists.push(rowText);
  });
  return createTableProps(
    rowTextLists,
    rowTextLists.length > 0 ? 1 : 0,
    undefined,
    node.align,
  );
};
