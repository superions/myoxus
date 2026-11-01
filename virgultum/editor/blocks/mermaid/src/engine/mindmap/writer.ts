// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidMindmapModel } from "./model.js";
import { resolveMermaidMindmapSource } from "./parser.js";
import type { MindmapDiagnostic } from "./diagnostics.js";

export type MindmapPatch = {
  start: number;
  end: number;
  text: string;
  /** Offsets within inserted text, including moved comments/decorators. */
  identities?: readonly (readonly [number, string])[];
};
export type MindmapCommandOptions = {
  intent?: "commit" | "cancel";
  readonly?: boolean;
  baseSource?: string;
};
export type MindmapCommandResult = {
  status: "changed" | "unchanged" | "rejected";
  changed: boolean;
  source: string;
  model: MermaidMindmapModel;
  diagnostics: MindmapDiagnostic[];
  diagnosticSource?: string;
  selection?: string;
  reason?:
    "cancelled" | "readonly" | "conflict" | "selection" | "syntax" | "tree";
};

export function unchangedMindmap(
  model: MermaidMindmapModel,
  reason?: MindmapCommandResult["reason"],
): MindmapCommandResult {
  return {
    status: reason && reason !== "cancelled" ? "rejected" : "unchanged",
    changed: false,
    source: model.sourceDocument.source,
    model,
    diagnostics: [],
    reason,
  };
}

/** Existing Source is authoritative. Normal edits must already be checked patches. */
export function generateMermaidMindmapSource(model: MermaidMindmapModel) {
  return model.sourceDocument.source;
}

/** Original-basis patches and advanced identities are validated and reparsed once.
 * Consumers apply this result directly, without a second writer against old Source. */
export function writeMindmapPatches(
  model: MermaidMindmapModel,
  patches: readonly MindmapPatch[],
  options: MindmapCommandOptions = {},
  selection?: string,
): MindmapCommandResult {
  const document = model.sourceDocument;
  if (options.intent === "cancel") return unchangedMindmap(model, "cancelled");
  if (options.readonly) return unchangedMindmap(model, "readonly");
  if (
    options.baseSource !== undefined &&
    options.baseSource !== document.source
  )
    return unchangedMindmap(model, "conflict");
  const expanded = patches.map((patch) => ({ ...patch }));
  for (const record of document.records) {
    if (!record.indentProviderKey) continue;
    const provider = document.records.find(
      (candidate) => candidate.sourceKey === record.indentProviderKey,
    )!;
    const patch = expanded.find(
      (patch) => patch.start === record.range.start && patch.end > patch.start,
    );
    const together = expanded.some(
      (candidate) =>
        candidate.start <= provider.range.start &&
        provider.range.start < candidate.end &&
        record.range.start < candidate.end,
    );
    if (together) continue;
    const providerChanged = expanded.some(
      (patch) =>
        (patch.start <= provider.range.start &&
          provider.range.start < patch.end) ||
        (patch.start === provider.valueRange?.start && patch.text.length > 0),
    );
    if (providerChanged) {
      const removed = patch?.text === "";
      const identity = patch?.identities?.find(
        ([, key]) => key === record.sourceKey,
      );
      const reindented =
        identity && /^[^\S\r\n]+/.test(patch!.text.slice(identity[0]));
      if (!removed && !reindented)
        expanded.push({
          start: record.range.start,
          end: record.range.start,
          text: record.nativeIndent!,
          identities: [[0, record.sourceKey]],
        });
      continue;
    }
    if (!patch) continue;
    const occurrence = patch.identities?.find(
      ([, key]) => key === record.sourceKey,
    );
    const introducesIndent =
      occurrence && /^[^\S\r\n]+/.test(patch.text.slice(occurrence[0]));
    if (
      (patch.text !== "" && !introducesIndent) ||
      patch.text.startsWith(document.newline)
    )
      continue;
    // Removing/reindenting the node breaks its pending lexer indentation. Stop
    // that standalone SPACELIST before the following record, without rewriting
    // the retained empty class or binding an unrelated next node to its indent.
    patch.text = document.newline + patch.text;
    patch.identities = patch.identities?.map(
      ([offset, key]) => [offset + document.newline.length, key] as const,
    );
  }
  const ordered = expanded.sort((a, b) => a.start - b.start || a.end - b.end);
  let lastEnd = 0;
  for (const patch of ordered) {
    if (
      !Number.isInteger(patch.start) ||
      !Number.isInteger(patch.end) ||
      patch.start < lastEnd ||
      patch.end < patch.start ||
      patch.end > document.source.length
    )
      return unchangedMindmap(model, "syntax");
    lastEnd = patch.end;
  }
  let source = document.source;
  for (const patch of [...ordered].reverse())
    source =
      source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  if (source === document.source) return unchangedMindmap(model);
  const mapping = new Map<number, string>();
  for (const record of document.records) {
    // A partial edit inside a record retains its start binding. Whole-record
    // replacements/moves explicitly identify their inserted occurrences below.
    const covered = ordered.some(
      (p) => p.start <= record.range.start && record.range.start < p.end,
    );
    if (covered) continue;
    const delta = ordered
      .filter((p) => p.end <= record.range.start)
      .reduce((sum, p) => sum + p.text.length - (p.end - p.start), 0);
    mapping.set(record.range.start + delta, record.sourceKey);
  }
  let delta = 0;
  for (const patch of ordered) {
    for (const [offset, key] of patch.identities ?? [])
      mapping.set(patch.start + delta + offset, key);
    delta += patch.text.length - (patch.end - patch.start);
  }
  const resolved = resolveMermaidMindmapSource(source, {
    previous: document,
    mapping,
  });
  if (!resolved.model)
    return {
      ...unchangedMindmap(model, "syntax"),
      diagnostics: resolved.diagnostics,
      diagnosticSource: source,
    };
  return {
    status: "changed",
    changed: true,
    source,
    model: resolved.model,
    diagnostics: [],
    selection,
  };
}
