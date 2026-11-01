import {
  type TableBlockPropsSerialized,
  TableBlockSchema,
  TableModelFlavour,
  normalizeTableHeaderRows,
} from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  type MarkdownAST,
  markdownHtmlTableNode,
  markdownTableHtml,
  parseMarkdownTableHtml,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";
import type { TableRow } from "mdast";

import {
  parseTableFromHtml,
  parseTableFromMarkdown,
  processTable,
  tableHtmlSections,
} from "./utils";

const TABLE_NODE_TYPES = new Set(["table", "tableRow"]);

const isTableNode = (node: MarkdownAST) => TABLE_NODE_TYPES.has(node.type);

export const tableBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: TableBlockSchema.model.flavour,
  toMatch: (o) => isTableNode(o.node) || !!markdownHtmlTableNode(o.node),
  fromMatch: (o) => o.node.flavour === TableBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext } = context;
      const html = markdownHtmlTableNode(o.node);
      if (o.node.type === "table" || html) {
        const astToDelta = context.deltaConverter.astToDelta.bind(
          context.deltaConverter,
        );
        walkerContext.openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: TableModelFlavour,
            props: {
              ...(html
                ? parseTableFromHtml(html, (cell) =>
                    astToDelta({
                      type: "html",
                      value: markdownTableHtml({
                        type: "root",
                        children: "children" in cell ? cell.children : [],
                      }),
                    }),
                  )
                : parseTableFromMarkdown(
                    o.node as import("mdast").Table,
                    astToDelta,
                  )),
            },
            children: [],
          },
          "children",
        );
        walkerContext.skipAllChildren();
      }
    },
    leave: (o, context) => {
      const { walkerContext } = context;
      if (o.node.type === "table" || markdownHtmlTableNode(o.node)) {
        walkerContext.closeNode();
      }
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext, deltaConverter } = context;
      const { columns, rows, cells, headerRows } = o.node
        .props as unknown as TableBlockPropsSerialized;
      const table = processTable(columns, rows, cells);
      const count =
        headerRows === undefined
          ? 0
          : normalizeTableHeaderRows(headerRows, table.rows.length);
      if (count !== 1 && table.rows.length) {
        const element: import("hast").Element = {
          type: "element",
          tagName: "table",
          properties: {},
          children: tableHtmlSections(
            table,
            headerRows,
            (cell, header, column) => ({
              type: "element",
              tagName: header ? "th" : "td",
              properties: table.align[column]
                ? { style: `text-align: ${table.align[column]}` }
                : {},
              children: deltaConverter.deltaToHtmlAST(cell.value.delta),
            }),
          ),
        };
        const value = markdownTableHtml(element);
        if (
          !parseMarkdownTableHtml(value) ||
          table.rows.some((row) =>
            row.cells.some((cell) =>
              cell.value.delta.some(
                (delta) =>
                  delta.attributes &&
                  "annotation" in delta.attributes &&
                  delta.attributes.annotation,
              ),
            ),
          )
        ) {
          if (deltaConverter.exportDiagnostics)
            deltaConverter.exportDiagnostics.unsupportedTables =
              (deltaConverter.exportDiagnostics.unsupportedTables ?? 0) + 1;
        }
        walkerContext.openNode({ type: "html", value }).closeNode();
        walkerContext.skipAllChildren();
        return;
      }
      const result: TableRow[] = [];
      table.rows.forEach((v) => {
        result.push({
          type: "tableRow",
          children: v.cells.map((v) => ({
            type: "tableCell",
            children: deltaConverter
              .deltaToAST(v.value.delta)
              .map((child) =>
                child.type === "break"
                  ? ({ type: "html", value: "<br>" } as const)
                  : child,
              ),
          })),
        });
      });

      walkerContext
        .openNode({
          type: "table",
          align: table.align,
          children: result,
        })
        .closeNode();

      walkerContext.skipAllChildren();
    },
  },
};

export const TableBlockMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  tableBlockMarkdownAdapterMatcher,
);
