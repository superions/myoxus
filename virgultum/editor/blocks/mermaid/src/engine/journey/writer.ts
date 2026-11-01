// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SourceValuePatch } from "../source-yaml.js";
import type { MermaidJourneyModel } from "./model.js";
import { parseMermaidJourneySource } from "./parser.js";
export type JourneyPatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type JourneySelection =
  { kind: "section" | "step"; id: string } | undefined;
export type JourneyCommandResult = {
  changed: boolean;
  source: string;
  model: MermaidJourneyModel;
  reason: "applied" | "no-change" | "conflict" | "invalid" | "readonly";
  selection?: JourneySelection;
};
export function journeyNoChange(
  model: MermaidJourneyModel,
  reason: JourneyCommandResult["reason"] = "no-change",
): JourneyCommandResult {
  return { changed: false, source: model.sourceDocument.source, model, reason };
}
/** Preflight the complete in-memory patch and reparsed membership before the global history owner. */
export function writeJourneyPatches(
  model: MermaidJourneyModel,
  patches: readonly JourneyPatch[],
  options: {
    removed?: ReadonlySet<string>;
    memberships?: ReadonlyMap<string, string>;
    edited?: ReadonlyMap<string, ReadonlySet<string>>;
    selection?: JourneySelection;
  } = {},
): JourneyCommandResult {
  const source = model.sourceDocument.source;
  const sorted = [...patches].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>();
  const reserved = new Set<string>();
  let cursor = 0,
    next = "";
  for (const p of sorted) {
    if (
      p.range.start < cursor ||
      p.range.end < p.range.start ||
      p.range.end > source.length
    )
      return journeyNoChange(model, "invalid");
    next += source.slice(cursor, p.range.start);
    for (const [offset, id] of p.identities ?? []) {
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += p.value;
    cursor = p.range.end;
  }
  next += source.slice(cursor);
  if (source && !/[\r\n]$/.test(source) && /[\r\n]$/.test(next))
    next = next.replace(/(?:\r\n|\r|\n)$/, "");
  if (next === source) return journeyNoChange(model);
  for (const r of model.sourceDocument.records) {
    if (options.removed?.has(r.sourceKey) || reserved.has(r.sourceKey))
      continue;
    let offset = r.range.start,
      deleted = false;
    for (const p of sorted) {
      if (r.range.start < p.range.start) break;
      if (
        p.range.end > p.range.start &&
        r.range.start >= p.range.start &&
        r.range.start < p.range.end
      ) {
        if (
          p.range.start === r.range.start &&
          p.value &&
          p.range.end <= r.range.end
        )
          break;
        deleted = true;
        break;
      }
      offset += p.value.length - (p.range.end - p.range.start);
    }
    if (!deleted) mapping.set(offset, r.sourceKey);
  }
  const parsed = parseMermaidJourneySource(next, model, mapping);
  if (
    !parsed ||
    parsed.ambiguous ||
    parsed.diagnostics.some(
      (e) =>
        e.code !== "score-range" &&
        e.code !== "actor-slot" &&
        !model.diagnostics.some(
          (old) => old.code === e.code && old.anchorId === e.anchorId,
        ),
    )
  )
    return journeyNoChange(model, "invalid");
  for (const section of model.sections) {
    if (options.removed?.has(section.id)) continue;
    const retained = parsed.sections.find((s) => s.id === section.id);
    if (
      !retained ||
      (!options.edited?.get(section.id)?.has("label") &&
        retained.title !== section.title)
    )
      return journeyNoChange(model, "invalid");
  }
  for (const step of model.steps) {
    if (options.removed?.has(step.id)) continue;
    const r = parsed.steps.find((s) => s.id === step.id),
      edited = options.edited?.get(step.id);
    if (
      !r ||
      r.sectionId !== (options.memberships?.get(step.id) ?? step.sectionId) ||
      (!edited?.has("label") && r.label !== step.label) ||
      (!edited?.has("score") && !Object.is(r.score, step.score)) ||
      (!edited?.has("actors") &&
        JSON.stringify(r.actors) !== JSON.stringify(step.actors)) ||
      (!edited?.has("tail") && r.tail !== step.tail)
    )
      return journeyNoChange(model, "invalid");
  }
  for (const comment of model.comments) {
    if (
      options.removed?.has(comment.id) ||
      options.edited?.get(comment.id)?.has("comment")
    )
      continue;
    const r = parsed.comments.find((c) => c.id === comment.id);
    if (
      !r ||
      r.anchorId !== comment.anchorId ||
      r.affinity !== comment.affinity
    )
      return journeyNoChange(model, "invalid");
  }
  return {
    changed: true,
    source: next,
    model: parsed,
    reason: "applied",
    selection: options.selection,
  };
}
/** Templates have no source authority to regenerate; existing documents export their exact bytes. */
export function generateMermaidJourneySource(model: MermaidJourneyModel) {
  return model.sourceDocument.source;
}
