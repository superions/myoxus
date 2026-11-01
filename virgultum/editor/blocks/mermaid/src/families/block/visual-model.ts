// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidMessages as blockMessages } from "../../i18n.js";
import { blockBodyGeometry } from "./layout.js";
import type { MermaidBlockDiagramModel } from "../../engine/block/index.js";
import { getMermaidFrontmatterTitle } from "../../engine/diagram-types.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { distributeBlockConnectionPorts } from "./connection-projection.js";
import { layoutBlockModel } from "./layout.js";
import { blockModelFamilyData } from "./gfx-data.js";
import { blockArrowContour, blockArrowTextBox } from "./block-projection.js";
import { blockStyles } from "./grid-projection.js";
import { projectBlockComposites } from "./composite-projection.js";
import { projectBlockConnection } from "./connection-projection.js";
export function blockModelToVisual(
  m: MermaidBlockDiagramModel,
): MermaidVisualModel {
  const layout = layoutBlockModel(m),
    ids = new Map([...m.nodes, ...m.groups].map((n) => [n.id, n.sourceKey])),
    // The Source owner preserves whole preamble records; the shared title
    // reader consumes lines, including multiline YAML scalars.
    title = getMermaidFrontmatterTitle(
      m.directives.flatMap((record) => record.split(/\r\n|\r|\n/)),
    ),
    nodes: MermaidVisualNode[] = m.nodes.map((n) => {
      const geometry = layout.objects.get(n.sourceKey)!,
        styles = blockStyles(m, n),
        contour =
          n.syntax === "block-arrow"
            ? blockArrowContour(
                n.directions,
                geometry.width,
                geometry.height,
                layout.padding,
              )
            : undefined,
        textBox = contour ? blockArrowTextBox(contour) : undefined;
      return {
        id: n.sourceKey,
        label: n.label,
        displayLabel: n.label.replace(/<br\s*\/?\s*>/gi, "\n"),
        labelEditable: false,
        shape: n.shape,
        ...blockBodyGeometry(geometry),
        ...(textBox
          ? {
              details: [
                {
                  id: `${n.sourceKey}:label`,
                  kind: "metadata" as const,
                  label: n.label.replace(/<br\s*\/?\s*>/gi, "\n"),
                  order: 0,
                },
              ],
            }
          : {}),
        familyData: createMermaidVisualFamilyData("block", {
          binding: {
            role: "block",
            sourceKey: n.sourceKey,
            sourceId: n.id,
            parentKey: n.parentKey,
          },
          styles,
          span: Number.isFinite(n.span) ? n.span : null,
          gridX: geometry.x,
          gridY: geometry.y,
          row: geometry.row,
          column: geometry.column,
          order: n.order,
          padding: layout.padding,
          ...(contour ? { contour, textBox: textBox! } : {}),
        }),
      };
    });
  for (const space of m.spaces) {
    const geometry = layout.objects.get(space.sourceKey);
    if (!geometry) continue;
    nodes.push({
      id: space.sourceKey,
      label: blockMessages.blockSpace(),
      displayLabel: "",
      labelEditable: false,
      shape: "rect",
      ...blockBodyGeometry(geometry),
      familyData: createMermaidVisualFamilyData("block", {
        binding: {
          role: "space",
          sourceKey: space.sourceKey,
          sourceId: "",
          parentKey: space.parentKey,
        },
        span: Number.isFinite(space.span) ? space.span : null,
        gridX: geometry.x,
        gridY: geometry.y,
        row: geometry.row,
        column: geometry.column,
        order: space.order,
        padding: layout.padding,
      }),
    });
  }
  const subgraphs = projectBlockComposites(m, layout),
    edges = m.edges
      .filter((e) => e.resolved && ids.has(e.from) && ids.has(e.to))
      .map((e) => projectBlockConnection(e, ids, m.edges));
  const base = blockModelFamilyData(m),
    data = {
      ...base,
      payload: {
        ...base.payload,
        grids: [...layout.grids.values()].map((g) => ({
          ...g,
          columns: Number.isFinite(g.columns) ? g.columns : null,
          parent: g.parent,
          rows: g.rows.map((r) => ({ ...r })),
        })),
      },
    };
  return {
    diagramType: "block",
    direction: "TB",
    version: 1,
    diagramTitle: title,
    accessibilityTitle: title || m.nodes.map((n) => n.label).join(", "),
    accessibilityDescription: [...m.nodes, ...m.groups]
      .map((n) => n.label || n.id)
      .join(", "),
    nodes,
    subgraphs,
    edges: distributeBlockConnectionPorts(edges, nodes, subgraphs),
    familyData: data,
    sourcePreamble: m.directives,
    sourceAnnotations: [],
    styleStatements: [],
  };
}
