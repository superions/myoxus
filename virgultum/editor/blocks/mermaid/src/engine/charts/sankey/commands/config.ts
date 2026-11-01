// SPDX-License-Identifier: AGPL-3.0-or-later

import { isMap, isScalar, type Node, type YAMLMap } from "yaml";
import {
  readSankeyConfig,
  validSankeyConfigField,
  type SankeyConfig,
  type SankeyConfigOccurrence,
} from "../config.js";
import type { SankeyModel } from "../model.js";
import {
  sankeyNoChange,
  sankeyPatchedResult,
  type SankeyPatch,
} from "../writer.js";

export type SankeyConfigCommand = {
  readonly type: "config.set";
  readonly field: keyof SankeyConfig;
  /** Undefined removes every source override for this field. */
  readonly value?: SankeyConfig[keyof SankeyConfig];
};

function removal(
  occurrence: Pick<
    SankeyConfigOccurrence,
    "scope" | "key" | "value" | "offset"
  >,
): SankeyPatch {
  const { scope, key, value, offset } = occurrence;
  const index = scope.items.findIndex((pair) => pair.key === key);
  let start = key.range![0];
  let end = value.range![1];
  if (scope.flow && scope.items.length > 1) {
    if (index + 1 < scope.items.length)
      end = (scope.items[index + 1].key as Node).range![0];
    else start = (scope.items[index - 1].value as Node).range![1];
  }
  return { range: { start: offset + start, end: offset + end }, value: "" };
}

/** Change only the named color entry, including shadowed overrides. Otherwise
 * resetting a later config directive could resurrect a deleted node's color. */
export function sankeyNodeColorPatches(
  model: SankeyModel,
  label: string,
  replacement?: string,
): readonly SankeyPatch[] {
  const { occurrences } = readSankeyConfig(model.sourceDocument);
  const patches: SankeyPatch[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.field !== "nodeColors") continue;
    if (!isMap(occurrence.value)) {
      const colors = occurrence.resolvedValue;
      if (
        !colors ||
        typeof colors !== "object" ||
        !Object.hasOwn(colors, label)
      )
        continue;
      // Expand only this alias use, never mutate an anchor shared with another
      // config consumer. Its unrelated users retain their original source.
      const updated = Object.fromEntries(
        Object.entries(colors).filter(([key]) => key !== label),
      );
      if (
        replacement !== undefined &&
        !Object.hasOwn(model.config.nodeColors, replacement)
      )
        Object.defineProperty(updated, replacement, {
          value: (colors as Record<string, unknown>)[label],
          enumerable: true,
        });
      patches.push({
        range: {
          start: occurrence.offset + occurrence.value.range![0],
          end: occurrence.offset + occurrence.value.range![1],
        },
        value: JSON.stringify(updated),
      });
      continue;
    }
    const scope: YAMLMap = occurrence.value;
    const pair = scope.items.find(
      (item) => isScalar(item.key) && item.key.value === label,
    );
    if (!pair || !isScalar(pair.key) || !pair.key.range || !pair.value)
      continue;
    const value = pair.value as Node;
    if (!value.range) continue;
    if (
      replacement !== undefined &&
      !Object.hasOwn(model.config.nodeColors, replacement)
    ) {
      patches.push({
        range: {
          start: occurrence.offset + pair.key.range[0],
          end: occurrence.offset + pair.key.range[1],
        },
        value: JSON.stringify(replacement),
      });
    } else {
      patches.push(
        scope.items.length === 1
          ? removal(occurrence)
          : removal({ scope, key: pair.key, value, offset: occurrence.offset }),
      );
    }
  }
  return patches;
}

export function applySankeyConfigCommand(
  model: SankeyModel,
  command: SankeyConfigCommand,
) {
  const { occurrences, scopes } = readSankeyConfig(model.sourceDocument);
  const matching = occurrences.filter((item) => item.field === command.field);
  if (command.value === undefined)
    return sankeyPatchedResult(model, matching.map(removal), null);
  if (!validSankeyConfigField(command.field, command.value))
    return sankeyNoChange(model, "config");
  const encoded = JSON.stringify(command.value);
  const existing = matching.at(-1);
  if (existing)
    return sankeyPatchedResult(
      model,
      [
        {
          range: {
            start: existing.offset + existing.value.range![0],
            end: existing.offset + existing.value.range![1],
          },
          value: encoded,
        },
      ],
      null,
    );
  const scope = scopes.at(-1);
  if (scope?.scope.range) {
    if (scope.scope.flow) {
      const end = scope.offset + scope.scope.range[1] - 1;
      return sankeyPatchedResult(
        model,
        [
          {
            range: { start: end, end },
            value: `${scope.scope.items.length ? ", " : ""}${JSON.stringify(command.field)}: ${encoded}`,
          },
        ],
        null,
      );
    }
    const firstKey = scope.scope.items[0]?.key as Node | undefined;
    const position =
      scope.offset + (firstKey?.range?.[0] ?? scope.scope.range[0]);
    const { source, newline } = model.sourceDocument;
    const lineStart =
      Math.max(
        source.lastIndexOf("\n", position - 1),
        source.lastIndexOf("\r", position - 1),
      ) + 1;
    const indentation = source.slice(lineStart, position);
    return sankeyPatchedResult(
      model,
      [
        {
          range: { start: lineStart, end: lineStart },
          value: `${indentation}${command.field}: ${encoded}${newline}`,
        },
      ],
      null,
    );
  }
  const header = model.sourceDocument.records.find(
    (record) => record.kind === "header",
  );
  if (!header) return sankeyNoChange(model, "header");
  const start = header.range.start;
  return sankeyPatchedResult(
    model,
    [
      {
        range: { start, end: start },
        value: `%%{init: ${JSON.stringify({ sankey: { [command.field]: command.value } })}}%%${model.sourceDocument.newline}`,
      },
    ],
    null,
  );
}
