// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidMindmapModel } from "../model.js";
import type { MindmapPatch } from "../writer.js";

/** Patch the actual nonempty DB provider. Clearing removes every provider,
 * including shadowed values which would otherwise become active again. */
export function mindmapDecorationPatches(
  model: MermaidMindmapModel,
  key: string,
  changes: { icon?: string; classes?: string },
): MindmapPatch[] | null {
  const node = model.nodes.find((node) => node.sourceKey === key);
  const record = model.sourceDocument.records.find((r) => r.sourceKey === key);
  if (!node || !record) return null;
  const patches: MindmapPatch[] = [];
  let added = "";
  for (const [kind, value, effective] of [
    ["icon", changes.icon, node.icon],
    ["class", changes.classes, node.class],
  ] as const) {
    if (value === undefined || (value !== "" && value === effective)) continue;
    if (/[\r\n]/.test(value) || (kind === "icon" && value.includes(")")))
      return null;
    const providers = model.sourceDocument.records.filter(
      (r) => r.anchorKey === key && r.kind === kind,
    );
    if (!value) {
      for (const provider of providers)
        patches.push({
          start: provider.range.start,
          end: provider.range.end + provider.eol.length,
          text: "",
        });
      continue;
    }
    const provider = providers.find((r) => r.effective) ?? providers.at(-1);
    if (provider?.valueRange)
      patches.push({
        start: provider.valueRange.start,
        end: provider.valueRange.end,
        text: value,
      });
    else
      added +=
        record.indent +
        (kind === "icon" ? `::icon(${value})` : `:::${value}`) +
        model.sourceDocument.newline;
  }
  if (added) {
    const position = record.range.end + record.eol.length;
    patches.push({
      start: position,
      end: position,
      text: (record.eol ? "" : model.sourceDocument.newline) + added,
    });
  }
  return patches;
}
