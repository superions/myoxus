// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import {
  resolveMermaidGitGraphSource,
  gitGraphDocument,
  readGitGraphConfig,
  orderedGitGraphBranches,
  type MermaidGitGraphModel,
} from "../../engine/gitgraph/index.js";
import { hashMermaidSource } from "../../utils.js";
export type GitGraphRole =
  | "commit"
  | "id"
  | "message"
  | "tag"
  | "branch"
  | "rail"
  | "statement"
  | "comment"
  | "relationship";
export type GitGraphBinding = {
  role: GitGraphRole;
  sourceKey: string;
  branch?: string;
  tagIndex?: number;
  attributeKey?: string;
};
export const gitGraphData = (payload: Readonly<Record<string, unknown>>) =>
  createMermaidVisualFamilyData("gitgraph", payload);
export const gitGraphPayload = (object: {
  familyData?: MermaidVisualModel["familyData"];
}) => mermaidVisualFamilyPayload(object.familyData, "gitgraph");
export function gitGraphBinding(object: {
  familyData?: MermaidVisualNode["familyData"];
}) {
  const value = gitGraphPayload(object);
  return value &&
    typeof value.sourceKey === "string" &&
    typeof value.role === "string"
    ? (value as unknown as GitGraphBinding)
    : null;
}
export function gitGraphModelData(model: MermaidGitGraphModel) {
  return gitGraphData({
    sourceHash: model.sourceHash,
    direction: model.direction,
    branches: orderedGitGraphBranches(model).map((b) => b.id),
    titleTopMargin: readGitGraphConfig(gitGraphDocument(model)).config
      .titleTopMargin,
    records: gitGraphDocument(model).records.map((r) => ({
      key: r.sourceKey,
      kind: r.kind,
      start: r.range.start,
      end: r.range.end,
      hash: hashMermaidSource(r.raw),
      attributes: r.attributes.map((a) => ({
        key: a.sourceKey,
        name: a.name,
        start: a.range.start,
        end: a.range.end,
        hash: hashMermaidSource(a.raw),
      })),
    })),
  });
}
export function readGitGraphProjectionModel(
  source: string,
  stored?: MermaidVisualModel,
) {
  return readGitGraphBoundSource(source, stored?.familyData).model;
}
/** Retained drawing metadata describes its own Source orientation. The current
 * repair model still comes exclusively from the current authored Source. */
export function readGitGraphProjectionOwner(
  model: MermaidVisualModel,
): MermaidVisualModel {
  const direction = gitGraphPayload(model)?.direction;
  return direction === "LR" || direction === "TB" || direction === "BT"
    ? { ...model, direction }
    : model;
}
/** Reconcile Source occurrences from metadata only. Invalid repair must not
 * obtain command data from retained child geometry or a past derived graph. */
export function readGitGraphBoundSource(
  source: string,
  familyData?: MermaidVisualModel["familyData"],
) {
  const first = resolveMermaidGitGraphSource(source),
    records = first.document.records,
    payload = mermaidVisualFamilyPayload(familyData, "gitgraph"),
    bindings = Array.isArray(payload?.records)
      ? payload.records.filter(
          (r): r is MermaidGfxJsonObject =>
            !!r && typeof r === "object" && !Array.isArray(r),
        )
      : [],
    mapping = new Map<number, string>(),
    used = new Set<string>();
  const hashes = records.map((r) => hashMermaidSource(r.raw));
  // Reserve exact retained occurrences first. Unique moved bytes are secondary;
  // identical Source occurrences need writer-advanced bindings, not a hash ID.
  for (const exact of [true, false])
    for (const [i, r] of records.entries()) {
      if (mapping.has(r.range.start)) continue;
      const candidates = bindings.filter(
        (b) =>
          typeof b.key === "string" &&
          !used.has(b.key) &&
          b.kind === r.kind &&
          b.hash === hashes[i] &&
          (exact
            ? b.start === r.range.start && b.end === r.range.end
            : hashes.filter((h) => h === hashes[i]).length === 1),
      );
      if (candidates.length === 1) {
        mapping.set(r.range.start, candidates[0]!.key as string);
        used.add(candidates[0]!.key as string);
      }
    }
  const attributeMapping = new Map<number, string>();
  for (const record of records) {
    const key = mapping.get(record.range.start),
      old = bindings.find((b) => b.key === key);
    const oldStart = old?.start;
    if (typeof oldStart !== "number") continue;
    const attributes = Array.isArray(old?.attributes) ? old.attributes : [];
    // A title or metadata edit can shift the entire unchanged owning record.
    // Relative slots distinguish even repeated identical tag occurrences.
    for (const a of record.attributes) {
      const matches = attributes.filter(
        (b) =>
          b &&
          typeof b === "object" &&
          !Array.isArray(b) &&
          b.name === a.name &&
          typeof b.start === "number" &&
          typeof b.end === "number" &&
          b.start - oldStart === a.range.start - record.range.start &&
          b.end - oldStart === a.range.end - record.range.start &&
          b.hash === hashMermaidSource(a.raw),
      );
      const match = matches.length === 1 ? matches[0] : undefined;
      if (
        match &&
        typeof match === "object" &&
        !Array.isArray(match) &&
        typeof match.key === "string"
      )
        attributeMapping.set(a.range.start, match.key);
    }
  }
  return resolveMermaidGitGraphSource(source, { mapping, attributeMapping });
}
