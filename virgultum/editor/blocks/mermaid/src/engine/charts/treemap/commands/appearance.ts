// SPDX-License-Identifier: AGPL-3.0-or-later

import { readTreemapConfig, validTreemapConfigField } from "../config.js";
import type { TreemapConfig, TreemapModel } from "../model.js";
import {
  treemapNoChange,
  treemapPatchedResult,
  type TreemapPatch,
} from "../writer.js";

export type TreemapAppearanceCommand =
  | {
      readonly type: "appearance.set";
      readonly field: keyof TreemapConfig;
      readonly value: TreemapConfig[keyof TreemapConfig];
    }
  | { readonly type: "appearance.reset"; readonly field: keyof TreemapConfig };

function encodedValue(value: TreemapConfig[keyof TreemapConfig]) {
  if (typeof value !== "string") return String(value);
  const escaped = Array.from(value, (character) => {
    if (character === "\\") return "\\\\";
    if (character === '"') return '\\"';
    if (character === "\b") return "\\b";
    if (character === "\f") return "\\f";
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    const code = character.charCodeAt(0);
    return code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("");
  return `"${escaped}"`;
}

/** Removes one YAML key without serializing unrelated frontmatter or directives. */
function resetPatch(
  occurrence: ReturnType<typeof readTreemapConfig>["occurrences"][number],
): TreemapPatch | null {
  const keyRange = occurrence.key.range;
  const valueRange = occurrence.value.range;
  if (!keyRange || !valueRange) return null;
  const raw = occurrence.record.raw;
  const relativeOffset = occurrence.offset - occurrence.record.range.start;
  const keyStart = relativeOffset + keyRange[0];
  const valueEnd = relativeOffset + valueRange[1];
  const lineStart =
    Math.max(
      raw.lastIndexOf("\n", keyStart - 1),
      raw.lastIndexOf("\r", keyStart - 1),
    ) + 1;
  const nextLineBreaks = [
    raw.indexOf("\n", valueEnd),
    raw.indexOf("\r", valueEnd),
  ].filter((index) => index >= 0);
  const lineEnd = nextLineBreaks.length
    ? Math.min(...nextLineBreaks)
    : raw.length;
  const before = raw.slice(lineStart, keyStart);
  const after = raw.slice(valueEnd, lineEnd);
  let start = keyStart;
  let end = valueEnd;
  if (!before.trim() && !after.trim()) {
    start = lineStart;
    end =
      lineEnd < raw.length
        ? lineEnd + (raw.startsWith("\r\n", lineEnd) ? 2 : 1)
        : lineEnd;
  } else {
    const nextComma = raw.indexOf(",", valueEnd);
    if (nextComma >= 0 && nextComma < lineEnd) {
      end = nextComma + 1;
      while (raw[end] === " ") end += 1;
    } else {
      const previousComma = raw.lastIndexOf(",", keyStart);
      // A sole flow-map entry has no comma on either side. Removing exactly
      // its key/value range leaves the surrounding Treemap object intact.
      if (previousComma >= lineStart) start = previousComma;
    }
  }
  return {
    range: {
      start: occurrence.record.range.start + start,
      end: occurrence.record.range.start + end,
    },
    value: "",
  };
}

export function applyTreemapAppearanceCommand(
  model: TreemapModel,
  command: TreemapAppearanceCommand,
) {
  const config = readTreemapConfig(model.sourceDocument);
  const occurrences = config.occurrences.filter(
    (occurrence) => occurrence.field === command.field,
  );
  if (command.type === "appearance.reset") {
    if (!occurrences.length) return treemapNoChange(model, "no-change");
    const patches = occurrences.flatMap((occurrence) => {
      const patch = resetPatch(occurrence);
      return patch ? [patch] : [];
    });
    return patches.length
      ? treemapPatchedResult(model, patches, null)
      : treemapNoChange(model, "conflict");
  }
  if (!validTreemapConfigField(command.field, command.value))
    return treemapNoChange(model, "invalid-config");
  const latest = occurrences.at(-1);
  if (latest?.value.range) {
    return treemapPatchedResult(
      model,
      [
        {
          range: {
            start: latest.offset + latest.value.range[0],
            end: latest.offset + latest.value.range[1],
          },
          value: encodedValue(command.value),
        },
      ],
      null,
    );
  }
  const header = model.sourceDocument.records.find(
    (record) => record.kind === "header",
  );
  if (!header) return treemapNoChange(model, "header-missing");
  const newline = model.sourceDocument.newline;
  return treemapPatchedResult(
    model,
    [
      {
        range: { start: header.range.start, end: header.range.start },
        value: `%%{init: {"treemap": {"${command.field}": ${encodedValue(command.value)}}}}%%${newline}`,
      },
    ],
    null,
  );
}
