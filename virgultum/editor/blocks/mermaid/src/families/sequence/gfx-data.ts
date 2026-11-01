// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidSequenceModel,
  SequenceRecordKind,
  SequenceParticipantType,
  SequenceConfig,
} from "../../engine/sequence/index.js";
import { readSequenceConfig } from "../../engine/sequence/index.js";
import { hashMermaidSource } from "../../utils.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import type { MermaidGfxTypography } from "../../mermaid-gfx-theme.js";

export type SequenceGfxRole =
  "participant" | "lifeline" | "activation" | "note" | "branch" | "lifecycle";
export type SequenceNodeBinding = {
  role: SequenceGfxRole;
  sourceKey: string;
  participantId?: string;
  participantKey?: string;
  participantType?: SequenceParticipantType;
  mirror?: boolean;
  typography?: MermaidGfxTypography;
  padding?: number;
};
export function sequenceNodeFamilyData(binding: SequenceNodeBinding) {
  return createMermaidVisualFamilyData("sequence", binding);
}
export function sequenceNodeBinding(node: {
  familyData?: MermaidVisualModel["familyData"];
}): SequenceNodeBinding | undefined {
  const value = mermaidVisualFamilyPayload(node.familyData, "sequence");
  return value &&
    typeof value.sourceKey === "string" &&
    [
      "participant",
      "lifeline",
      "activation",
      "note",
      "branch",
      "lifecycle",
    ].includes(String(value.role))
    ? (value as unknown as SequenceNodeBinding)
    : undefined;
}
export function sequenceFamilyPayload(object: {
  familyData?: MermaidVisualModel["familyData"];
}) {
  return mermaidVisualFamilyPayload(object.familyData, "sequence");
}
export function sequenceObjectFamilyData(
  payload: Readonly<Record<string, unknown>>,
) {
  return createMermaidVisualFamilyData("sequence", payload);
}
export type SequenceRecordBinding = {
  key: string;
  kind: SequenceRecordKind;
  start: number;
  end: number;
  hash: string;
  primaryBranchKey?: string;
};
/** Only identity and derived projection metadata are stored on the existing GFX
 * owner. Original Source and opaque payloads remain exclusively on the block. */
export function sequenceModelFamilyData(
  model: MermaidSequenceModel,
  rows: readonly {
    key: string;
    y: number;
    top: number;
    bottom: number;
    parentId: string | null;
    branchId: string | null;
  }[],
  typography: Readonly<Record<string, MermaidGfxTypography>>,
) {
  return sequenceObjectFamilyData({
    sourceHash: model.sourceHash,
    config: readSequenceConfig(model.sourceDocument).config,
    typography,
    rows,
    participants: model.participants.map((p) => ({
      sourceId: p.id,
      sourceKey: p.sourceKey,
    })),
    comments: model.commentRecords.map((c) => ({
      key: c.id,
      anchorKind: c.anchorKind,
      anchorId: c.anchorId,
      position: c.position,
    })),
    records: model.sourceDocument.records.map((r) => ({
      key: r.sourceKey,
      kind: r.kind,
      start: r.range.start,
      end: r.range.end,
      hash: hashMermaidSource(r.raw),
      primaryBranchKey: r.primaryBranchKey,
    })),
  });
}
export function sequenceRecordBindings(
  visual?: MermaidVisualModel,
): SequenceRecordBinding[] {
  const records = visual && sequenceFamilyPayload(visual)?.records;
  return Array.isArray(records)
    ? (records.filter((value): value is MermaidGfxJsonObject =>
        Boolean(
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          typeof value.key === "string" &&
          typeof value.kind === "string" &&
          typeof value.start === "number" &&
          typeof value.end === "number" &&
          typeof value.hash === "string",
        ),
      ) as unknown as SequenceRecordBinding[])
    : [];
}
export function sequenceProjectionConfig(
  visual: MermaidVisualModel,
): SequenceConfig {
  const value = sequenceFamilyPayload(visual)?.config;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Sequence projection has no checked config");
  return value as unknown as SequenceConfig;
}
