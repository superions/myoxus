import {
  type TableBlockPropsSerialized,
  TableBlockSchema,
  TableModelFlavour,
  normalizeTableAppearance,
  normalizeTableDensity,
  normalizeTableHeaderRows,
} from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
  type InlineHtmlAST,
} from "@virgultum/shared/adapters";
import { ThemeProvider } from "@virgultum/shared/services";
import { cssVar } from "@virgultum/shared/theme";
import { nanoid } from "@virgultum/store";

import { DefaultColumnWidth, TableCellPadding } from "../consts";
import { resolveTableColors } from "../color";
import { parseTableFromHtml, processTable, tableHtmlSections } from "./utils";

const TABLE_NODE_TYPES = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "th",
  "td",
  "tr",
]);

export const tableBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: TableBlockSchema.model.flavour,
  toMatch: (o) => {
    return HastUtils.isElement(o.node) && TABLE_NODE_TYPES.has(o.node.tagName);
  },
  fromMatch: (o) => o.node.flavour === TableBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { walkerContext } = context;
      if (o.node.tagName === "table") {
        const astToDelta = context.deltaConverter.astToDelta.bind(
          context.deltaConverter,
        );
        const tableProps = parseTableFromHtml(o.node, astToDelta);
        walkerContext.openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: TableModelFlavour,
            props: tableProps as unknown as Record<string, unknown>,
            children: [],
          },
          "children",
        );
        walkerContext.skipAllChildren();
      }
    },
    leave: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { walkerContext } = context;
      if (o.node.tagName === "table") {
        walkerContext.closeNode();
      }
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext } = context;
      const { columns, rows, cells, headerRows, appearance, density } = o.node
        .props as unknown as TableBlockPropsSerialized;
      const table = processTable(columns, rows, cells);
      const widths = table.widths.some((width) => width !== undefined)
        ? table.widths.map((width) => width ?? DefaultColumnWidth)
        : undefined;
      const totalWidth = widths?.reduce((sum, width) => sum + width, 0);
      const normalizedAppearance = normalizeTableAppearance(appearance);
      const normalizedDensity = normalizeTableDensity(density);
      const theme =
        context.scopeProvider?.getOptional(ThemeProvider) ??
        context.provider?.getOptional(ThemeProvider);
      const border = theme
        ? resolveTableColors(theme, cssVar("borderColor")).backgroundColor
        : undefined;
      const ruledBorder = `border-block:1px solid${border ? ` ${border}` : ""};border-inline:0;`;
      const cellPadding = TableCellPadding[normalizedDensity ?? "normal"];
      const createAstTableCell = (
        children: InlineHtmlAST[],
        isHeader: boolean,
        column: number,
        fill?: string,
      ): InlineHtmlAST => {
        if (fill && !theme)
          throw new Error("Native table paint export requires ThemeService");
        const paint =
          theme && (fill || isHeader)
            ? resolveTableColors(
                theme,
                fill ?? cssVar("backgroundSecondaryColor"),
              )
            : {};
        const style = [
          paint.backgroundColor
            ? `background-color:${paint.backgroundColor}`
            : "",
          paint.color ? `color:${paint.color}` : "",
          table.align[column] ? `text-align:${table.align[column]}` : "",
          widths ? "overflow-wrap:anywhere" : "",
          normalizedAppearance === "plain"
            ? "border:0"
            : normalizedAppearance === "ruled"
              ? ruledBorder
              : "",
        ]
          .filter(Boolean)
          .join(";");
        return {
          type: "element",
          tagName: isHeader ? "th" : "td",
          properties: {
            ...(isHeader ? { scope: "col" } : {}),
            ...(style ? { style } : {}),
          },
          children: [
            {
              type: "element",
              tagName: "div",
              properties: {
                style: `min-height:22px;min-width:${widths ? 0 : DefaultColumnWidth}px;padding:${cellPadding.block} ${cellPadding.inline};`,
              },
              children,
            },
          ],
        };
      };

      const { deltaConverter } = context;

      const normalizedHeaderRows =
        headerRows === undefined
          ? 0
          : normalizeTableHeaderRows(headerRows, table.rows.length);
      const sections = tableHtmlSections(
        table,
        headerRows,
        (cell, header, column) =>
          createAstTableCell(
            deltaConverter.deltaToAST(cell.value.delta),
            header,
            column,
            cell.backgroundColor,
          ),
      );

      walkerContext
        .openNode({
          type: "element",
          tagName: "table",
          properties: {
            ...(normalizedAppearance === "plain" ||
            normalizedAppearance === "ruled"
              ? {}
              : { border: true }),
            style: `border-collapse: collapse;border-spacing: 0;${widths ? "table-layout:fixed;width:100%;" : ""}${
              normalizedAppearance === "plain"
                ? "border:0;"
                : normalizedAppearance === "ruled"
                  ? ruledBorder
                  : ""
            }`,
            ...(headerRows === undefined
              ? {}
              : { dataMyoxusTableHeaderRows: normalizedHeaderRows }),
            ...(normalizedAppearance === undefined
              ? {}
              : { dataMyoxusTableAppearance: normalizedAppearance }),
            ...(normalizedDensity === undefined
              ? {}
              : { dataMyoxusTableDensity: normalizedDensity }),
          },
          children: [
            ...(widths && totalWidth
              ? [
                  {
                    type: "element" as const,
                    tagName: "colgroup",
                    properties: {},
                    children: widths.map((width) => ({
                      type: "element" as const,
                      tagName: "col",
                      properties: {
                        style: `width:${(width / totalWidth) * 100}%`,
                      },
                      children: [],
                    })),
                  },
                ]
              : []),
            ...sections,
          ],
        })
        .closeNode();

      walkerContext.skipAllChildren();
    },
  },
};

export const TableBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  tableBlockHtmlAdapterMatcher,
);
