// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidSequenceSource,
  editSequenceParticipant,
  editSequenceMessage,
  addSequenceMessage,
  editSequenceNote,
  editSequenceBranch,
  editSequenceBackground,
  type MermaidSequenceModel,
  type SequenceComment,
  type SequenceCommandResult,
  type MermaidSequenceMessageArrow,
} from "../../engine/sequence/index.js";
import { hashMermaidSource } from "../../utils.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import type {
  MermaidGfxJsonValue,
  MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";
import {
  sequenceRecordBindings,
  sequenceFamilyPayload,
  sequenceNodeBinding,
} from "./gfx-data.js";
import { sequenceModelToVisual } from "./visual-model.js";
import { mermaidMessages as m } from "../../i18n.js";

/** Reserve exact unchanged bindings before unique shifted records. A hash match
 * alone cannot distinguish two identical messages or comments. */
export function readSequenceProjectionModel(
  source: string,
  visual?: MermaidVisualModel,
): MermaidSequenceModel | null {
  const first = resolveMermaidSequenceSource(source),
    records = first.document.records,
    bindings = sequenceRecordBindings(visual),
    mapping = new Map<number, string>(),
    used = new Set<string>(),
    hashes = records.map((r) => hashMermaidSource(r.raw)),
    counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  const byRange = new Map<string, typeof bindings>(),
    byHash = new Map<string, typeof bindings>();
  for (const b of bindings) {
    const key = `${b.kind}:${b.start}:${b.end}:${b.hash}`;
    byRange.set(key, [...(byRange.get(key) ?? []), b]);
    byHash.set(b.hash, [...(byHash.get(b.hash) ?? []), b]);
  }
  for (const [index, r] of records.entries()) {
    const hash = hashes[index]!,
      exact =
        byRange.get(`${r.kind}:${r.range.start}:${r.range.end}:${hash}`) ?? [],
      unique =
        counts.get(hash) === 1 && byHash.get(hash)?.length === 1
          ? byHash.get(hash)!
          : [],
      matches = (exact.length ? exact : unique).filter(
        (b) => !used.has(b.key) && b.kind === r.kind,
      );
    if (matches.length === 1) {
      mapping.set(r.range.start, matches[0]!.key);
      used.add(matches[0]!.key);
    }
  }
  const payload = visual && sequenceFamilyPayload(visual),
    participantKeys = new Map<string, string>(),
    primaryKeys = new Map<string, string>(),
    comments = new Map<
      string,
      Pick<SequenceComment, "anchorKind" | "anchorId" | "position">
    >();
  if (Array.isArray(payload?.participants))
    for (const p of payload.participants)
      if (
        p &&
        typeof p === "object" &&
        !Array.isArray(p) &&
        typeof p.sourceId === "string" &&
        typeof p.sourceKey === "string"
      )
        participantKeys.set(p.sourceId, p.sourceKey);
  for (const b of bindings)
    if (b.primaryBranchKey) primaryKeys.set(b.key, b.primaryBranchKey);
  if (Array.isArray(payload?.comments))
    for (const c of payload.comments)
      if (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        typeof c.key === "string" &&
        typeof c.anchorKind === "string" &&
        ["before", "after", "inside"].includes(String(c.position))
      )
        comments.set(c.key, c as unknown as SequenceComment);
  return resolveMermaidSequenceSource(
    source,
    undefined,
    mapping,
    participantKeys,
    primaryKeys,
    comments,
  ).model;
}
/** Temporal geometry is Source-derived. Owner placement and the host camera are
 * independent; retaining arbitrary node X/Y would reintroduce diagonal messages. */
export function canonicalizeSequenceVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
): MermaidVisualModel {
  const wanted = new Map(
      sequenceRecordBindings(requested).map((b) => [
        `${b.kind}:${b.start}:${b.end}:${b.hash}`,
        b,
      ]),
    ),
    keys = new Map<string, string>();
  for (const b of sequenceRecordBindings(parsed)) {
    const old = wanted.get(`${b.kind}:${b.start}:${b.end}:${b.hash}`);
    if (old) {
      keys.set(b.key, old.key);
      if (b.primaryBranchKey && old.primaryBranchKey)
        keys.set(b.primaryBranchKey, old.primaryBranchKey);
    }
  }
  for (const n of parsed.nodes) {
    const b = sequenceNodeBinding(n);
    if (b?.role !== "participant" || b.mirror) continue;
    const old = requested.nodes.find((o) => {
      const p = sequenceNodeBinding(o);
      return (
        p?.role === "participant" &&
        !p.mirror &&
        p.participantId === b.participantId
      );
    });
    if (old) keys.set(b.sourceKey, sequenceNodeBinding(old)!.sourceKey);
  }
  const remap = (key: string): string => {
    if (keys.has(key)) return keys.get(key)!;
    for (const [from, to] of keys)
      if (key.startsWith(`${from}:`)) return to + key.slice(from.length);
    return key;
  };
  const identityFields = new Set([
    "key",
    "sourceKey",
    "participantKey",
    "primaryBranchKey",
    "parentId",
    "branchId",
    "rowKey",
    "anchorId",
  ]);
  const payload = (value: MermaidGfxJsonValue): MermaidGfxJsonValue => {
    if (Array.isArray(value)) return value.map(payload);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        typeof item === "string" && identityFields.has(field)
          ? remap(item)
          : payload(item),
      ]),
    ) as MermaidGfxJsonObject;
  };
  const data = (d: MermaidVisualModel["familyData"]) =>
    d ? { ...d, payload: payload(d.payload) as MermaidGfxJsonObject } : d;
  return {
    ...parsed,
    familyData: data(parsed.familyData),
    nodes: parsed.nodes.map((n) => ({
      ...n,
      id: remap(n.id),
      familyData: data(n.familyData),
      details: n.details?.map((d) => ({
        ...d,
        id: remap(d.id),
        sourceKey: d.sourceKey ? remap(d.sourceKey) : undefined,
      })),
    })),
    edges: parsed.edges.map((e) => ({
      ...e,
      id: remap(e.id),
      source: remap(e.source),
      target: remap(e.target),
      sourceAttachment: e.sourceAttachment
        ? remap(e.sourceAttachment)
        : undefined,
      targetAttachment: e.targetAttachment
        ? remap(e.targetAttachment)
        : undefined,
      familyData: data(e.familyData),
    })),
    subgraphs: parsed.subgraphs?.map((g) => ({
      ...g,
      id: remap(g.id),
      parentId: g.parentId ? remap(g.parentId) : undefined,
      nodeIds: g.nodeIds.map(remap),
      familyData: data(g.familyData),
    })),
  };
}
export function applySequenceGfxVisualToSource(
  source: string,
  visual: MermaidVisualModel,
) {
  let model = readSequenceProjectionModel(source, visual);
  if (!model) throw new Error(m.sequenceInvalidRecord());
  const apply = (result: SequenceCommandResult) => {
    if (result.status === "rejected")
      throw new Error(result.diagnostic ?? m.sequencePatchRejected());
    model = result.model;
  };
  for (const node of visual.nodes) {
    const binding = sequenceNodeBinding(node);
    if (!binding || binding.mirror) continue;
    if (binding.role === "participant") {
      const p = model.participants.find(
        (p) => p.sourceKey === binding.sourceKey,
      );
      if (
        p &&
        (p.label !== node.label ||
          (binding.participantType && p.type !== binding.participantType))
      )
        apply(
          editSequenceParticipant(model, p.sourceKey, {
            label: node.label,
            type: binding.participantType,
          }),
        );
    } else if (binding.role === "note") {
      const note = model.notes.find((n) => n.id === binding.sourceKey);
      if (note && note.label !== node.label)
        apply(editSequenceNote(model, note.id, { label: node.label }));
    } else if (binding.role === "branch") {
      const branch = model.controls
        .flatMap((c) => c.branches)
        .find((b) => b.id === binding.sourceKey);
      if (branch && branch.label !== node.label)
        apply(editSequenceBranch(model, branch.id, { label: node.label }));
    }
  }
  for (const group of visual.subgraphs ?? []) {
    const background = model.backgrounds.find((b) => b.id === group.id);
    if (background?.kind === "box" && background.label !== group.title)
      apply(
        editSequenceBackground(model, background.id, { label: group.title }),
      );
  }
  for (const edge of visual.edges) {
    const a = sequenceNodeBinding(
        visual.nodes.find((n) => n.id === edge.source) ?? {},
      ),
      b = sequenceNodeBinding(
        visual.nodes.find((n) => n.id === edge.target) ?? {},
      ),
      data = sequenceFamilyPayload(edge);
    if (!a?.participantId || !b?.participantId || !data)
      throw new Error(m.sequenceMissingObject());
    const original = model.messages.find((message) => message.id === edge.id),
      value = {
        sourceKey: edge.id,
        from: a.participantId,
        to: b.participantId,
        label: edge.label,
        arrow: data.arrow as MermaidSequenceMessageArrow,
        centralFrom: data.centralFrom === true,
        centralTo: data.centralTo === true,
        activation:
          data.activation === "+" || data.activation === "-"
            ? data.activation
            : undefined,
        wrap: typeof data.wrap === "boolean" ? data.wrap : undefined,
      } as const;
    apply(
      original
        ? editSequenceMessage(model, original.id, value)
        : addSequenceMessage(model, value),
    );
  }
  return {
    source: model.sourceDocument.source,
    visualModel: sequenceModelToVisual(model),
    diagnostics: [],
  };
}
