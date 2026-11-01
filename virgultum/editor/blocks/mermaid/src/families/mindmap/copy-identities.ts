// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseMermaidMindmapSource } from "../../engine/mindmap/index.js";
import {
  parseMermaidVisualFamilyData,
  serializeMermaidVisualFamilyData,
  createMermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";
import { readMindmapProjectionModel } from "./source-application.js";
import { readMindmapProjectionData } from "./gfx-data.js";
import { projectMindmapTree } from "./projection/tree.js";
import { copiedMindmapProjection } from "./interaction/clipboard.js";

/** Whole-owner copies retain bytes and runtime syntax IDs. Only actual record
 * identities and the roles referring to them cross this explicit remap. */
export function remapCopiedMindmapIdentities(
  source: string,
  familyData: string,
) {
  const data = parseMermaidVisualFamilyData(familyData);
  const original = readMindmapProjectionModel(source, { familyData: data });
  if (!original) return null;
  const identityMap = new Map(
    original.sourceDocument.records.map((record) => [
      record.sourceKey,
      `mindmap-source-${crypto.randomUUID()}`,
    ]),
  );
  const mapping = new Map(
    original.sourceDocument.records.map((record) => [
      record.range.start,
      identityMap.get(record.sourceKey)!,
    ]),
  );
  const model = parseMermaidMindmapSource(source, { mapping });
  if (!model) return null;
  const options = readMindmapProjectionData(data);
  const visual = projectMindmapTree(model, {
    ...options,
    ...copiedMindmapProjection(
      { layout: options.layout, design: options.design },
      options,
      identityMap,
      true,
    ),
  });
  return {
    identityMap,
    familyData: serializeMermaidVisualFamilyData(visual.familyData),
    remapElement: (props: Readonly<Record<string, unknown>>) => {
      const next: Record<string, unknown> = {};
      for (const key of [
        "mermaidNodeId",
        "mermaidEdgeSemanticSource",
        "mermaidEdgeSemanticTarget",
      ])
        if (typeof props[key] === "string" && identityMap.has(props[key]))
          next[key] = identityMap.get(props[key]);
      if (
        typeof next.mermaidEdgeSemanticSource === "string" &&
        typeof next.mermaidEdgeSemanticTarget === "string"
      )
        next.mermaidEdgeId = `branch:${next.mermaidEdgeSemanticSource}:${next.mermaidEdgeSemanticTarget}`;
      for (const key of ["mermaidNodeFamilyData", "mermaidEdgeFamilyData"]) {
        const value = parseMermaidVisualFamilyData(props[key]);
        if (value?.family !== "mindmap") continue;
        const payload = { ...value.payload };
        for (const field of ["sourceKey", "parentKey"])
          if (
            typeof payload[field] === "string" &&
            identityMap.has(payload[field])
          )
            payload[field] = identityMap.get(payload[field])!;
        next[key] = serializeMermaidVisualFamilyData(
          createMermaidVisualFamilyData("mindmap", payload),
        );
      }
      return next;
    },
  };
}
