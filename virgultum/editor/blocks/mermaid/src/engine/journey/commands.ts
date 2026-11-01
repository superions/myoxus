// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidJourneyModel } from "./model.js";
import {
  nextJourneySourceKey,
  type JourneySourceRecord,
} from "./source-document.js";
import { parseMermaidJourneySource } from "./parser.js";
import { readJourneyConfig, journeyConfigPatch } from "./config.js";
import {
  journeyNoChange,
  writeJourneyPatches,
  type JourneyPatch,
  type JourneyCommandResult,
  type JourneySelection,
} from "./writer.js";
export type JourneyCommand =
  | {
      type: "add";
      kind: "section" | "step";
      label: string;
      sectionId?: string;
      afterId?: string;
      score?: number;
      actors?: string[];
    }
  | { type: "rename"; id: string; label: string }
  | { type: "score"; id: string; value: number }
  | { type: "actors"; id: string; value: string[]; removeTail?: true }
  | {
      type: "move-step";
      id: string;
      sectionId: string;
      targetId?: string;
      edge?: "before" | "after";
    }
  | {
      type: "move-section";
      id: string;
      targetId: string;
      edge: "before" | "after";
    }
  | { type: "delete"; id: string; moveToSectionId?: string }
  | {
      type: "comment";
      id?: string;
      anchorId?: string | null;
      positionId?: string;
      text?: string;
    }
  | { type: "accessibility"; field: "title" | "description"; value: string }
  | { type: "config"; field: string; value: unknown };
export function journeyRecord(m: MermaidJourneyModel, id: string) {
  return m.sourceDocument.records.find((r) => r.sourceKey === id);
}
function nodes(m: MermaidJourneyModel) {
  return [...m.sections, ...m.steps];
}
function after(r: JourneySourceRecord) {
  return r.range.end + r.eol.length;
}
function owned(m: MermaidJourneyModel, ids: ReadonlySet<string>) {
  const keys = new Set(ids);
  for (const c of m.comments)
    if (c.anchorId && ids.has(c.anchorId) && !c.inline) keys.add(c.id);
  return m.sourceDocument.records.filter((r) => keys.has(r.sourceKey));
}
function remove(r: JourneySourceRecord): JourneyPatch {
  return { range: { start: r.range.start, end: after(r) }, value: "" };
}
function insertion(
  m: MermaidJourneyModel,
  point: number,
  payload: string,
  identities: readonly (readonly [number, string])[] = [],
): JourneyPatch {
  const prefix =
    point > 0 && !/[\r\n]/.test(m.sourceDocument.source[point - 1]!)
      ? m.sourceDocument.newline
      : "";
  return {
    range: { start: point, end: point },
    value: prefix + payload,
    identities: identities.map(([offset, id]) => [offset + prefix.length, id]),
  };
}
function sectionEnd(m: MermaidJourneyModel, id: string) {
  const s = m.sections.find((s) => s.id === id);
  if (!s) return undefined;
  const records = owned(
    m,
    new Set([
      id,
      ...m.steps.filter((t) => t.sectionId === id).map((t) => t.id),
    ]),
  );
  return records.length
    ? after(records.at(-1)!)
    : after(journeyRecord(m, m.headerId)!);
}
function objectStart(m: MermaidJourneyModel, id: string) {
  return owned(m, new Set([id]))[0]?.range.start;
}
function edited(id: string, field: string) {
  return new Map([[id, new Set([field])]]);
}
export function journeyTextValid(value: string, actor = false) {
  return (
    Boolean(value.trim()) &&
    !/[:#;\r\n]/.test(value) &&
    (!actor || !value.includes(","))
  );
}
function dependencyIds(c: JourneyCommand) {
  const ids = new Set<string>();
  if ("id" in c && c.id) ids.add(c.id);
  if ("sectionId" in c && c.sectionId) ids.add(c.sectionId);
  if ("targetId" in c) ids.add(c.targetId!);
  if ("afterId" in c && c.afterId) ids.add(c.afterId);
  if ("moveToSectionId" in c && c.moveToSectionId) ids.add(c.moveToSectionId);
  if ("anchorId" in c && c.anchorId) ids.add(c.anchorId);
  return ids;
}
function basisValid(m: MermaidJourneyModel, c: JourneyCommand, basis: string) {
  if (basis === m.sourceDocument.source) return true;
  // Reverse reconciliation retains unchanged duplicate anchors through prefix/suffix offsets,
  // while an externally replaced ambiguous duplicate deliberately loses its identity.
  const old = parseMermaidJourneySource(basis, m);
  if (!old || old.ambiguous) return false;
  if (c.type === "config") {
    const scope = (model: MermaidJourneyModel) => {
      const scopes = readJourneyConfig(model.sourceDocument).scopes;
      return (
        scopes.findLast((item) => {
          const config = item.yaml.values[item.prefix] as
            { journey?: Record<string, unknown> } | undefined;
          return config?.journey && c.field in config.journey;
        }) ?? scopes.at(-1)
      )?.record;
    };
    const now = scope(m),
      before = scope(old);
    return now && before
      ? now.sourceKey === before.sourceKey && now.raw === before.raw
      : !now &&
          !before &&
          journeyRecord(m, m.headerId)?.raw ===
            journeyRecord(old, old.headerId)?.raw;
  }
  if (c.type === "accessibility") {
    const kind =
      c.field === "title" ? "accessibility-title" : "accessibility-description";
    const signature = (model: MermaidJourneyModel) =>
      model.sourceDocument.records
        .filter((r) => r.kind === kind)
        .map((r) => [r.sourceKey, r.raw]);
    return (
      JSON.stringify(signature(m)) === JSON.stringify(signature(old)) &&
      m.headerId === old.headerId
    );
  }
  const dependencies = dependencyIds(c);
  const sections = new Set<string>();
  for (const id of dependencies) {
    const owner = (model: MermaidJourneyModel) =>
      model.comments.find((comment) => comment.id === id && comment.inline)
        ?.anchorId ?? id;
    const now = journeyRecord(m, owner(m)),
      before = journeyRecord(old, owner(old));
    const initial = m.sections.find((s) => s.id === id && s.implicit);
    if (initial) {
      if (!old.sections.some((s) => s.id === id && s.implicit)) return false;
      sections.add(id);
      continue;
    }
    if (!now || !before || now.kind !== before.kind || now.raw !== before.raw)
      return false;
    const step = m.steps.find((s) => s.id === id),
      oldStep = old.steps.find((s) => s.id === id);
    if (step) {
      if (oldStep?.sectionId !== step.sectionId) return false;
      sections.add(step.sectionId);
    }
    if (m.sections.some((s) => s.id === id)) sections.add(id);
  }
  if (["move-step", "move-section", "delete", "add"].includes(c.type))
    for (const id of sections) {
      const signature = (model: MermaidJourneyModel) =>
        model.steps
          .filter((s) => s.sectionId === id)
          .map((s) => [
            s.id,
            journeyRecord(model, s.id)?.raw,
            model.comments
              .filter((cm) => cm.anchorId === s.id)
              .map((cm) => cm.line),
          ]);
      const comments = (model: MermaidJourneyModel) =>
        model.comments.filter((cm) => cm.anchorId === id).map((cm) => cm.line);
      if (JSON.stringify(comments(old)) !== JSON.stringify(comments(m)))
        return false;
      if (JSON.stringify(signature(old)) !== JSON.stringify(signature(m)))
        return false;
    }
  if (c.type === "add" && c.kind === "section" && !c.afterId) {
    const a = m.sourceDocument.records.at(-1),
      b = old.sourceDocument.records.at(-1);
    if (a?.sourceKey !== b?.sourceKey || a?.raw !== b?.raw) return false;
  }
  return true;
}
export function applyJourneyCommand(
  m: MermaidJourneyModel,
  c: JourneyCommand,
  options: {
    intent?: "preview" | "apply" | "cancel";
    readonly?: boolean;
    baseSource?: string;
  } = {},
): JourneyCommandResult {
  if (options.intent === "cancel") return journeyNoChange(m);
  if (options.readonly) return journeyNoChange(m, "readonly");
  if (m.ambiguous) return journeyNoChange(m, "invalid");
  if (options.baseSource !== undefined && !basisValid(m, c, options.baseSource))
    return journeyNoChange(m, "conflict");
  const record = "id" in c && c.id ? journeyRecord(m, c.id) : undefined;
  const node = "id" in c ? nodes(m).find((n) => n.id === c.id) : undefined;
  const nl = m.sourceDocument.newline;
  if (c.type === "rename") {
    if (!node?.writable || !journeyTextValid(c.label))
      return journeyNoChange(m, "invalid");
    const label = c.label.trim();
    if ("title" in node && node.implicit) {
      const first = m.steps.find((s) => s.sectionId === node.id);
      const point = first ? objectStart(m, first.id) : sectionEnd(m, node.id);
      if (point === undefined) return journeyNoChange(m, "conflict");
      return writeJourneyPatches(
        m,
        [insertion(m, point, `  section ${label}${nl}`, [[0, node.id]])],
        {
          edited: edited(node.id, "label"),
          selection: { kind: "section", id: node.id },
        },
      );
    }
    const r = node.labelRange;
    if (!r) return journeyNoChange(m, "invalid");
    return writeJourneyPatches(m, [{ range: r, value: label }], {
      edited: edited(node.id, "label"),
      selection: { kind: "title" in node ? "section" : "step", id: node.id },
    });
  }
  if (c.type === "score" || c.type === "actors") {
    const step = m.steps.find((s) => s.id === c.id);
    if (!step?.writable) return journeyNoChange(m, "invalid");
    if (c.type === "score") {
      if (!Number.isFinite(c.value)) return journeyNoChange(m, "invalid");
      if (Object.is(c.value, step.score)) return journeyNoChange(m);
      return writeJourneyPatches(
        m,
        [{ range: step.scoreRange, value: String(c.value) }],
        {
          edited: edited(step.id, "score"),
          selection: { kind: "step", id: step.id },
        },
      );
    }
    if (c.value.some((a) => !journeyTextValid(a, true)))
      return journeyNoChange(m, "invalid");
    const actors = c.value.map((a) => a.trim());
    if (JSON.stringify(actors) === JSON.stringify(step.actors))
      return journeyNoChange(m);
    // Removing the final actor also removes a native ignored tail only after
    // the user has explicitly confirmed that additional source loss.
    if (!actors.length && step.tail && !c.removeTail)
      return journeyNoChange(m, "invalid");
    const r = step.actorsRange;
    const actorSource = r ? m.sourceDocument.source.slice(r.start, r.end) : "";
    // Keep the field's existing edge whitespace when replacing its actor values.
    const actorValue = `${actorSource.match(/^\s*/)?.[0] ?? ""}${actors.join(", ")}${actorSource.match(/\s*$/)?.[0] ?? ""}`;
    const patch: JourneyPatch = actors.length
      ? r
        ? { range: r, value: actorValue }
        : {
            range: { start: step.actorsInsertion, end: step.actorsInsertion },
            value: `: ${actors.join(", ")}`,
          }
      : {
          range: {
            start: step.actorsInsertion,
            end:
              (r?.end ?? step.actorsInsertion) +
              (c.removeTail ? step.tail.length : 0),
          },
          value: "",
        };
    return writeJourneyPatches(m, [patch], {
      edited: new Map([
        [
          step.id,
          new Set(
            c.removeTail && !actors.length ? ["actors", "tail"] : ["actors"],
          ),
        ],
      ]),
      selection: { kind: "step", id: step.id },
    });
  }
  if (c.type === "config") {
    const p = journeyConfigPatch(m.sourceDocument, c.field, c.value);
    return p ? writeJourneyPatches(m, p) : journeyNoChange(m, "invalid");
  }
  if (c.type === "accessibility") {
    if (
      (c.field === "title" && /[\r\n]/.test(c.value)) ||
      (c.field === "description" && c.value.includes("}"))
    )
      return journeyNoChange(m, "invalid");
    const kind =
      c.field === "title" ? "accessibility-title" : "accessibility-description";
    const records = m.sourceDocument.records.filter((r) => r.kind === kind);
    const r = records.at(-1);
    const value = c.value.trim();
    if (
      (c.field === "title"
        ? m.accessibilityTitle
        : m.accessibilityDescription) === value
    )
      return journeyNoChange(m);
    if (!value) {
      return r
        ? writeJourneyPatches(m, records.map(remove), {
            removed: new Set(records.map((record) => record.sourceKey)),
          })
        : journeyNoChange(m);
    }
    if (r) {
      const start =
        c.field === "description" && r.raw.includes("{")
          ? r.raw.indexOf("{") + 1
          : r.raw.indexOf(":") + 1;
      const end =
        c.field === "description" && r.raw.includes("{")
          ? r.raw.indexOf("}")
          : r.raw.length;
      if (!value.includes("\n") || r.raw.includes("{"))
        return writeJourneyPatches(m, [
          {
            range: { start: r.range.start + start, end: r.range.start + end },
            value: r.raw.includes("{")
              ? nl +
                value
                  .split("\n")
                  .map((l) => `${r.indent}  ${l}`)
                  .join(nl) +
                nl +
                r.indent
              : ` ${value}`,
          },
        ]);
    }
    const payload =
      c.field === "title"
        ? `  accTitle: ${value}${nl}`
        : value.includes("\n")
          ? `  accDescr {${nl}${value
              .split("\n")
              .map((l) => `    ${l}`)
              .join(nl)}${nl}  }${nl}`
          : `  accDescr: ${value}${nl}`;
    return writeJourneyPatches(
      m,
      r
        ? [
            {
              range: { start: r.range.start, end: after(r) },
              value: payload,
              identities: [[0, r.sourceKey]],
            },
          ]
        : [insertion(m, after(journeyRecord(m, m.headerId)!), payload)],
    );
  }
  if (c.type === "add") {
    if (
      !journeyTextValid(c.label) ||
      c.actors?.some((a) => !journeyTextValid(a, true)) ||
      (c.score !== undefined && !Number.isFinite(c.score))
    )
      return journeyNoChange(m, "invalid");
    const id = nextJourneySourceKey();
    let point: number | undefined;
    let payload: string;
    if (c.kind === "section") {
      if (c.afterId) {
        const target = m.sections.find((s) => s.id === c.afterId);
        if (!target) return journeyNoChange(m, "conflict");
        point = sectionEnd(m, target.id);
      } else point = m.sourceDocument.source.length;
      payload = `  section ${c.label.trim()}${nl}`;
    } else {
      const section = m.sections.find((s) => s.id === c.sectionId);
      if (!section?.writable) return journeyNoChange(m, "conflict");
      if (c.afterId) {
        const target = m.steps.find(
          (s) => s.id === c.afterId && s.sectionId === section.id,
        );
        if (!target) return journeyNoChange(m, "conflict");
        point = after(journeyRecord(m, target.id)!);
      } else point = sectionEnd(m, section.id);
      payload = `    ${c.label.trim()}: ${c.score ?? 3}${c.actors?.length ? `: ${c.actors.map((a) => a.trim()).join(", ")}` : ""}${nl}`;
    }
    if (point === undefined) return journeyNoChange(m, "conflict");
    return writeJourneyPatches(m, [insertion(m, point, payload, [[0, id]])], {
      selection: { kind: c.kind, id },
    });
  }
  if (c.type === "move-step" || c.type === "move-section") {
    if (!node?.writable || !record) return journeyNoChange(m, "invalid");
    let point: number | undefined;
    let ids: Set<string>;
    let memberships: Map<string, string> | undefined;
    if (c.type === "move-step") {
      const s = m.sections.find((s) => s.id === c.sectionId);
      if (!s?.writable) return journeyNoChange(m, "conflict");
      const step = m.steps.find((s) => s.id === c.id);
      if (!step) return journeyNoChange(m, "invalid");
      if (c.targetId === c.id) return journeyNoChange(m);
      const target = c.targetId
        ? m.steps.find((t) => t.id === c.targetId && t.sectionId === s.id)
        : undefined;
      if (c.targetId && !target) return journeyNoChange(m, "conflict");
      point = target
        ? c.edge === "before"
          ? objectStart(m, target.id)
          : after(journeyRecord(m, target.id)!)
        : sectionEnd(m, s.id);
      ids = new Set([c.id]);
      memberships = new Map([[c.id, s.id]]);
    } else {
      const section = m.sections.find((s) => s.id === c.id);
      const target = m.sections.find((s) => s.id === c.targetId);
      if (
        !section ||
        section.implicit ||
        !target?.writable ||
        (target.implicit && c.edge === "before")
      )
        return journeyNoChange(m, "invalid");
      if (section.id === target.id) return journeyNoChange(m);
      ids = new Set([
        section.id,
        ...m.steps.filter((t) => t.sectionId === section.id).map((t) => t.id),
      ]);
      point =
        c.edge === "before"
          ? objectStart(m, target.id)
          : sectionEnd(m, target.id);
    }
    const records = owned(m, ids);
    const sourceStep =
      c.type === "move-step"
        ? m.steps.find((step) => step.id === c.id)
        : undefined;
    const initial = sourceStep
      ? m.sections.find(
          (section) => section.id === sourceStep.sectionId && section.implicit,
        )
      : undefined;
    const removed =
      initial &&
      sourceStep?.sectionId !== memberships?.get(c.id) &&
      m.steps.filter((step) => step.sectionId === initial.id).length === 1
        ? new Set([initial.id])
        : undefined;
    if (point === undefined) return journeyNoChange(m, "conflict");
    if (records.some((r) => point! >= r.range.start && point! <= after(r)))
      return journeyNoChange(m);
    let payload = "";
    const identities: (readonly [number, string])[] = [];
    for (const r of records) {
      identities.push([payload.length, r.sourceKey]);
      payload += r.raw + (r.eol || nl);
    }
    return writeJourneyPatches(
      m,
      [...records.map(remove), insertion(m, point, payload, identities)],
      {
        memberships,
        removed,
        selection: {
          kind: c.type === "move-step" ? "step" : "section",
          id: c.id,
        },
      },
    );
  }
  if (c.type === "delete") {
    if (!node?.writable) return journeyNoChange(m, "invalid");
    const section = m.sections.find((s) => s.id === c.id);
    const steps = section
      ? m.steps.filter((t) => t.sectionId === section.id)
      : [];
    if (c.moveToSectionId) {
      const target = m.sections.find(
        (s) => s.id === c.moveToSectionId && s.id !== c.id,
      );
      if (!section || !target?.writable) return journeyNoChange(m, "conflict");
      const records = owned(m, new Set(steps.map((t) => t.id)));
      const point = sectionEnd(m, target.id);
      if (point === undefined) return journeyNoChange(m, "conflict");
      let payload = "";
      const identities: (readonly [number, string])[] = [];
      for (const r of records) {
        identities.push([payload.length, r.sourceKey]);
        payload += r.raw + (r.eol || nl);
      }
      const deleted = owned(m, new Set([section.id]));
      const removed = new Set(deleted.map((r) => r.sourceKey));
      for (const c of m.comments)
        if (c.anchorId === section.id) removed.add(c.id);
      return writeJourneyPatches(
        m,
        [
          ...deleted.map(remove),
          ...records.map(remove),
          insertion(m, point, payload, identities),
        ],
        {
          removed,
          memberships: new Map(steps.map((t) => [t.id, target.id])),
          selection: { kind: "section", id: target.id },
        },
      );
    }
    const ids = new Set([c.id, ...steps.map((t) => t.id)]);
    const records = owned(m, ids);
    const removed = new Set(records.map((r) => r.sourceKey));
    for (const cm of m.comments)
      if (cm.anchorId && ids.has(cm.anchorId)) removed.add(cm.id);
    if (section?.implicit) removed.add(section.id);
    const parent = !section
      ? m.sections.find(
          (s) => s.id === (node as { sectionId: string }).sectionId,
        )
      : undefined;
    if (
      parent?.implicit &&
      m.steps.filter((s) => s.sectionId === parent.id).length === 1
    )
      removed.add(parent.id);
    const next = section
      ? m.sections.find((s) => s.id !== c.id)
      : m.steps.find(
          (t) =>
            t.sectionId === (node as { sectionId: string }).sectionId &&
            t.id !== c.id,
        );
    const selection: JourneySelection = next
      ? { kind: section ? "section" : "step", id: next.id }
      : section
        ? undefined
        : { kind: "section", id: (node as { sectionId: string }).sectionId };
    return writeJourneyPatches(m, records.map(remove), { removed, selection });
  }
  if (c.type === "comment") {
    const old = c.id ? m.comments.find((cm) => cm.id === c.id) : undefined;
    if (c.id && !old) return journeyNoChange(m, "conflict");
    if (c.text !== undefined && /[\r\n]/.test(c.text))
      return journeyNoChange(m, "invalid");
    if (old) {
      if (c.text === old.text) return journeyNoChange(m);
      if (c.text === undefined)
        return writeJourneyPatches(
          m,
          [
            old.inline
              ? { range: old.range, value: "" }
              : remove(journeyRecord(m, old.id)!),
          ],
          { removed: new Set([old.id]) },
        );
      return writeJourneyPatches(
        m,
        [
          {
            range: old.range,
            value: `${old.inline ? "#" : old.indent + "%%"} ${c.text}`,
          },
        ],
        { edited: edited(old.id, "comment") },
      );
    }
    if (c.text === undefined) return journeyNoChange(m);
    const anchor = c.anchorId ? journeyRecord(m, c.anchorId) : undefined;
    if (c.anchorId && !anchor) return journeyNoChange(m, "conflict");
    const position = c.positionId ? journeyRecord(m, c.positionId) : undefined;
    if (c.positionId && !position) return journeyNoChange(m, "conflict");
    const point = anchor
      ? objectStart(m, anchor.sourceKey)
      : position
        ? position.range.start
        : after(journeyRecord(m, m.headerId)!);
    if (point === undefined) return journeyNoChange(m, "conflict");
    const payload = c.anchorId
      ? `${anchor!.indent}%% ${c.text}${nl}`
      : `${nl}%% ${c.text}${nl}${nl}`;
    return writeJourneyPatches(m, [insertion(m, point, payload)]);
  }
  return journeyNoChange(m, "invalid");
}
/** Every basis-sensitive intent is preflighted against the same current source before any intermediate patch. */
export function applyJourneyCommands(
  m: MermaidJourneyModel,
  commands: readonly JourneyCommand[],
  options: Parameters<typeof applyJourneyCommand>[2] = {},
): JourneyCommandResult {
  if (options.intent === "cancel" || options.readonly)
    return journeyNoChange(m, options.readonly ? "readonly" : "no-change");
  if (
    options.baseSource !== undefined &&
    commands.some((c) => !basisValid(m, c, options.baseSource!))
  )
    return journeyNoChange(m, "conflict");
  let result = journeyNoChange(m);
  for (const c of commands) {
    const next = applyJourneyCommand(result.model, c, {
      ...options,
      baseSource: undefined,
    });
    if (["invalid", "conflict", "readonly"].includes(next.reason))
      return journeyNoChange(m, next.reason);
    if (next.changed) result = next;
  }
  return result.changed
    ? { ...result, changed: result.source !== m.sourceDocument.source }
    : result;
}

export const addMermaidJourneySection = (
  m: MermaidJourneyModel,
  title: string,
) =>
  applyJourneyCommand(m, { type: "add", kind: "section", label: title }).model;
export const addMermaidJourneyStep = (
  m: MermaidJourneyModel,
  sectionId: string,
  label: string,
) =>
  applyJourneyCommand(m, { type: "add", kind: "step", sectionId, label }).model;
export const deleteMermaidJourneySection = (
  m: MermaidJourneyModel,
  id: string,
) => applyJourneyCommand(m, { type: "delete", id }).model;
export const deleteMermaidJourneyStep = deleteMermaidJourneySection;
export const renameMermaidJourneySection = (
  m: MermaidJourneyModel,
  id: string,
  label: string,
) => applyJourneyCommand(m, { type: "rename", id, label }).model;
export const renameMermaidJourneyStep = renameMermaidJourneySection;
export const setMermaidJourneyStepScore = (
  m: MermaidJourneyModel,
  id: string,
  value: number,
) => applyJourneyCommand(m, { type: "score", id, value }).model;
export const setMermaidJourneyStepActors = (
  m: MermaidJourneyModel,
  id: string,
  value: string[],
) => applyJourneyCommand(m, { type: "actors", id, value }).model;
export const moveMermaidJourneyStepToSection = (
  m: MermaidJourneyModel,
  id: string,
  sectionId: string,
) => applyJourneyCommand(m, { type: "move-step", id, sectionId }).model;
export function moveMermaidJourneySection(
  m: MermaidJourneyModel,
  id: string,
  direction: -1 | 1,
) {
  const index = m.sections.findIndex((s) => s.id === id);
  const target = m.sections[index + direction];
  return target
    ? applyJourneyCommand(m, {
        type: "move-section",
        id,
        targetId: target.id,
        edge: direction < 0 ? "before" : "after",
      }).model
    : m;
}
export function moveMermaidJourneyStep(
  m: MermaidJourneyModel,
  id: string,
  direction: -1 | 1,
) {
  const step = m.steps.find((s) => s.id === id);
  if (!step) return m;
  const steps = m.steps.filter((s) => s.sectionId === step.sectionId);
  const target = steps[steps.indexOf(step) + direction];
  return target
    ? applyJourneyCommand(m, {
        type: "move-step",
        id,
        sectionId: step.sectionId,
        targetId: target.id,
        edge: direction < 0 ? "before" : "after",
      }).model
    : m;
}
