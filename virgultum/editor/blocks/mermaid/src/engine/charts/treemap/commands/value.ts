// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapModel } from "../model.js";
import {
  encodeTreemapValue,
  treemapNoChange,
  treemapPatchedResult,
} from "../writer.js";

export type TreemapValueCommand = {
  readonly type: "value.set";
  readonly id: string;
  readonly value: number;
};

export function applyTreemapValueCommand(
  model: TreemapModel,
  command: TreemapValueCommand,
) {
  const node = model.nodes.find((candidate) => candidate.id === command.id);
  const value = encodeTreemapValue(command.value);
  if (!node) return treemapNoChange(model, "node-missing");
  if (node.value === null || !node.valueRange)
    return treemapNoChange(model, "section-value-readonly");
  if (value === null) return treemapNoChange(model, "invalid-number");
  return treemapPatchedResult(model, [{ range: node.valueRange, value }], {
    kind: "node",
    id: node.id,
  });
}
