// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MindmapLayoutType as LayoutType,
  MindmapDesign as MindmapStyle,
} from "./projection/types.js";
import { readMindmapAppearanceMap } from "./projection/designs.js";

import type {
  MindmapLayout,
  MindmapMeasuredNode,
  MindmapProjectionOptions,
} from "./projection/layout.js";

import type {
  MermaidMindmapModel,
  MermaidMindmapNode,
} from "../../engine/mindmap/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonObject,
  type MermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";
import { hashMermaidSource } from "../../utils.js";

export type MindmapRecordBinding = {
  key: string;
  kind: string;
  start: number;
  end: number;
  hash: string;
};

export function mindmapRecordBindings(
  visual?: Pick<MermaidVisualModel, "familyData">,
): MindmapRecordBinding[] {
  const records =
    visual && mermaidVisualFamilyPayload(visual.familyData, "mindmap")?.records;
  if (!Array.isArray(records)) return [];
  const result: MindmapRecordBinding[] = [];
  for (const value of records) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.key === "string" &&
      typeof value.kind === "string" &&
      typeof value.start === "number" &&
      typeof value.end === "number" &&
      typeof value.hash === "string"
    )
      result.push({
        key: value.key,
        kind: value.kind,
        start: value.start,
        end: value.end,
        hash: value.hash,
      });
  }
  return result;
}

export function mindmapModelFamilyData(
  model: MermaidMindmapModel,
  geometryKey: string,
  layout: MindmapLayout,
) {
  const liveKeys = new Set(model.nodes.map((node) => node.sourceKey));
  return createMermaidVisualFamilyData("mindmap", {
    sourceHash: model.sourceHash,
    geometryKey,
    projection: {
      nodeAppearance: [...(layout.options.nodeAppearance ?? [])].filter(
        ([key]) => liveKeys.has(key),
      ),
      branchAppearance: [...(layout.options.branchAppearance ?? [])].filter(
        ([key]) => liveKeys.has(key),
      ),
      layout: layout.options.layout ?? LayoutType.RIGHT,
      design: layout.options.design ?? MindmapStyle.ONE,
      rootSides: [...layout.rootSides],
      collapsed: [...(layout.options.collapsed ?? [])].filter((key) =>
        liveKeys.has(key),
      ),
    },
    records: model.sourceDocument.records.map((record) => ({
      key: record.sourceKey,
      kind: record.kind,
      start: record.range.start,
      end: record.range.end,
      hash: hashMermaidSource(record.raw + record.eol),
    })),
  });
}

export function mindmapNodeFamilyData(
  node: MermaidMindmapNode,
  parentKey: string | null,
  measured: MindmapMeasuredNode,
) {
  return createMermaidVisualFamilyData("mindmap", {
    presentation: {
      path: measured.path,
      typography: measured.typography,
      padding: measured.padding,
      runs: measured.runs,
      displayLabel: measured.displayLabel,
      iconSize: measured.iconSize,
      collapseSize: measured.collapseSize,
      textBox: measured.textBox,
    },
    sourceKey: node.sourceKey,
    syntaxId: node.syntaxId,
    runtimeId: node.runtimeId,
    parentKey,
    order: node.order,
    shape: node.shape,
    icon: node.icon ?? null,
    class: node.class ?? null,
  });
}

// Family payloads are immutable values. Decode their app-only roles once per
// projection; rebuilding the override maps for every painted child is quadratic.
const optionCache = new WeakMap<
  MermaidVisualFamilyData,
  MindmapProjectionOptions
>();

export function readMindmapProjectionOptions(
  visual?: Pick<MermaidVisualModel, "familyData">,
): MindmapProjectionOptions {
  return readMindmapProjectionData(visual?.familyData);
}

export function readMindmapProjectionData(
  familyData?: MermaidVisualFamilyData,
): MindmapProjectionOptions {
  const cached = familyData && optionCache.get(familyData);
  if (cached) return cached;
  const raw = mermaidVisualFamilyPayload(familyData, "mindmap")?.projection;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as MermaidGfxJsonObject;
  const rootSides = new Map<string, LayoutType.LEFT | LayoutType.RIGHT>();
  if (Array.isArray(value.rootSides))
    for (const entry of value.rootSides) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        (entry[1] === LayoutType.LEFT || entry[1] === LayoutType.RIGHT)
      )
        rootSides.set(entry[0], entry[1]);
    }
  const collapsed = new Set<string>();
  if (Array.isArray(value.collapsed))
    for (const key of value.collapsed)
      if (typeof key === "string") collapsed.add(key);
  const options: MindmapProjectionOptions = Object.freeze({
    layout:
      value.layout === LayoutType.LEFT || value.layout === LayoutType.BALANCE
        ? value.layout
        : LayoutType.RIGHT,
    design:
      value.design === MindmapStyle.TWO ||
      value.design === MindmapStyle.THREE ||
      value.design === MindmapStyle.FOUR
        ? value.design
        : MindmapStyle.ONE,
    rootSides,
    collapsed,
    nodeAppearance: readMindmapAppearanceMap(value.nodeAppearance),
    branchAppearance: readMindmapAppearanceMap(value.branchAppearance),
  });
  if (familyData) optionCache.set(familyData, options);
  return options;
}
