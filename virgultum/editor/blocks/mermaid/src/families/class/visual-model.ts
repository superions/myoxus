// SPDX-License-Identifier: AGPL-3.0-or-later
import { getMermaidFrontmatterTitle } from "../../engine/diagram-types.js";
import {
  getMermaidClassNoteDisplayText,
  readClassConfig,
  type MermaidClassModel,
} from "../../engine/class/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import {
  classBoundNodeFamilyData,
  classEdgeFamilyData,
  classModelFamilyData,
  classProjectionBinding,
  classNodeGfxData,
} from "./gfx-data.js";
import { createClassMemberDetails } from "./class-projection.js";
import { classNodeMetrics, layoutClassNodes } from "./layout.js";
import { classNamespaceProjection } from "./namespace-projection.js";
import { classRelationProjection } from "./edge-projection.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
export function classStyles(model: MermaidClassModel, id: string) {
  const values: Record<string, string> = {};
  const node = model.nodes.find((n) => n.sourceId === id);
  const definitions = new Set(node?.cssClasses ?? []);
  for (const style of model.styles.filter(
    (s) => s.kind === "assignment" && s.owners.includes(id),
  ))
    for (const name of style.styles) definitions.add(name);
  for (const style of model.styles)
    if (
      (style.kind === "definition" &&
        style.styles.some((o) => definitions.has(o))) ||
      (style.kind === "inline" && style.owners.includes(id))
    )
      for (const property of style.properties)
        values[property.name] = property.value;
  return values;
}
export function classModelToVisual(
  model: MermaidClassModel,
): MermaidVisualModel {
  const { config } = readClassConfig(model.sourceDocument);
  const nodeIds = new Map(model.nodes.map((n) => [n.id, n.sourceKey]));
  const nodes: MermaidVisualNode[] = model.nodes.map((node) => {
    const styles = classStyles(model, node.sourceId),
      metrics = classNodeMetrics(
        node,
        config.padding,
        config.hideEmptyMembersBox,
        styles,
      );
    const isInterface = node.kind === "lollipop-interface";
    return {
      id: node.sourceKey,
      label: node.label,
      displayLabel: metrics.header,
      labelEditable: false,
      details: isInterface
        ? []
        : [
            ...createClassMemberDetails(node.sourceKey, node.members),
            ...(!config.hideEmptyMembersBox || node.members.length
              ? [
                  {
                    id: `${node.sourceKey}:divider:header`,
                    kind: "separator" as const,
                    label: "",
                    order: node.members.length,
                  },
                  {
                    id: `${node.sourceKey}:divider:operation`,
                    kind: "separator" as const,
                    label: "",
                    order: node.members.length + 1,
                  },
                ]
              : []),
          ],
      shape: isInterface ? "text" : "rect",
      textAlign: isInterface ? "center" : "left",
      textVerticalAlign: "top",
      x: node.x,
      y: node.y,
      width: Math.max(1, metrics.width),
      height: isInterface ? metrics.headerHeight : metrics.height,
      familyData: classBoundNodeFamilyData(
        {
          annotations: node.annotations,
          cssClasses: node.cssClasses,
          genericType: node.genericType,
          interaction: node.interaction,
          kind: node.kind,
          members: node.members.map((m) => m.raw),
          memberKeys: node.members.map((m) => m.id),
          noteFor: "",
          noteText: "",
        },
        {
          sourceKey: node.sourceKey,
          sourceId: node.sourceId,
          namespaceId: node.namespaceId,
          headerHeight: metrics.headerHeight,
          rowHeight: metrics.rowHeight,
          padding: config.padding,
          attributeHeight: metrics.attributeHeight,
          hideEmpty: config.hideEmptyMembersBox,
        },
        styles,
      ),
    };
  });
  const typography = resolveMermaidGfxProjectionTheme().typography;
  for (const note of model.notes) {
    const text = getMermaidClassNoteDisplayText(note.text),
      metrics = measureMermaidGfxText(text, typography);
    nodes.push({
      id: note.sourceKey,
      label: text,
      displayLabel: text,
      labelEditable: false,
      shape: "rect",
      textAlign: "left",
      textVerticalAlign: "top",
      x: 48,
      y: 48,
      width: Math.max(
        metrics.width + config.padding * 4,
        typography.fontSize * 4,
      ),
      height: metrics.height + config.padding * 4,
      familyData: classBoundNodeFamilyData(
        {
          annotations: [],
          cssClasses: [],
          genericType: "",
          interaction: "",
          kind: "note",
          members: [],
          noteFor: note.classId ?? "",
          noteText: note.text,
        },
        {
          sourceKey: note.sourceKey,
          sourceId: note.sourceKey,
          namespaceId: note.namespaceId,
          headerHeight: metrics.height,
          rowHeight: 0,
          padding: config.padding,
          attributeHeight: 0,
          hideEmpty: true,
        },
      ),
    });
  }
  const relations = model.relations.map((r) =>
    classRelationProjection(r, nodeIds, model.relations),
  );
  const placed = layoutClassNodes(
    nodes.filter((node) => classNodeGfxData(node)?.kind !== "note"),
    model.direction,
    relations,
    config.rankSpacing,
    config.nodeSpacing,
  );
  placed.push(
    ...nodes.filter((node) => classNodeGfxData(node)?.kind === "note"),
  );
  for (const note of model.notes.filter((n) => n.classId)) {
    const item = placed.find((n) => n.id === note.sourceKey),
      owner = placed.find((n) => n.id === nodeIds.get(note.classId!));
    if (item && owner) {
      item.x = owner.x;
      item.y = owner.y + owner.height + config.nodeSpacing;
    }
  }
  // Keep unrelated Source containers in separate bands; a namespace rectangle
  // must not visually claim a class whose Source owner is outside it.
  for (const namespace of model.namespaces.filter((n) => !n.parentId)) {
    const members = placed.filter((node) => {
      const id = classProjectionBinding(node)?.namespaceId;
      return id === namespace.id || id?.startsWith(namespace.id + ".");
    });
    if (!members.length) continue;
    const bottom = Math.max(...members.map((node) => node.y + node.height));
    const outside = placed.filter(
      (node) =>
        !members.includes(node) && classNodeGfxData(node)?.kind !== "note",
    );
    const shift = Math.max(
      0,
      bottom + config.nodeSpacing - Math.min(...outside.map((node) => node.y)),
    );
    for (const node of outside) node.y += shift;
  }
  let noteY =
    Math.max(
      48,
      ...placed
        .filter((node) => classNodeGfxData(node)?.kind !== "note")
        .map((node) => node.y + node.height),
    ) + config.nodeSpacing;
  for (const note of model.notes.filter((n) => !n.classId)) {
    const item = placed.find((node) => node.id === note.sourceKey)!;
    item.y = noteY;
    noteY += item.height + config.nodeSpacing;
  }
  return {
    version: 1,
    diagramType: model.diagramType,
    direction: model.direction,
    diagramTitle: getMermaidFrontmatterTitle(model.directives),
    accessibilityTitle: model.accessibilityTitle,
    accessibilityDescription: model.accessibilityDescription,
    familyData: classModelFamilyData(model),
    nodes: placed,
    edges: [
      ...relations,
      ...model.notes.flatMap((n) =>
        n.classId && nodeIds.has(n.classId)
          ? [
              {
                id: `${n.sourceKey}:attachment`,
                source: n.sourceKey,
                target: nodeIds.get(n.classId)!,
                label: "",
                labelEditable: false,
                linkType: "open" as const,
                sourceMarker: "none" as const,
                targetMarker: "none" as const,
                style: "dotted" as const,
                connectorMode: "straight" as const,
                familyData: classEdgeFamilyData({
                  fromCardinality: "",
                  toCardinality: "",
                  relationKind: "",
                  noteLink: true,
                }),
              },
            ]
          : [],
      ),
    ],
    subgraphs: classNamespaceProjection(
      model,
      placed,
      config.hierarchicalNamespaces,
    ),
  };
}
