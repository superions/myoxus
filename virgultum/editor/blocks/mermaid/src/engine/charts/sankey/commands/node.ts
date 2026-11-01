// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyModel } from "../model.js";
import {
  encodeSankeyField,
  sankeyNoChange,
  sankeyPatchedResult,
  type SankeyPatch,
} from "../writer.js";
import { sankeyOwnedLinkRange } from "./link.js";
import { sankeyNodeColorPatches } from "./config.js";

export type SankeyNodeCommand =
  | {
      readonly type: "node.rename";
      readonly id: string;
      readonly label: string;
      readonly confirmed?: boolean;
    }
  | {
      readonly type: "node.delete";
      readonly id: string;
      readonly confirmed: boolean;
    };

export function sankeyNodeImpact(model: SankeyModel, id: string) {
  const links = model.links.filter(
    (link) => link.source === id || link.target === id,
  );
  return {
    links,
    sum: links.reduce(
      (sum, link) =>
        Number.isFinite(link.value) && link.value >= 0 ? sum + link.value : sum,
      0,
    ),
    invalidValues: links.filter(
      (link) => !Number.isFinite(link.value) || link.value < 0,
    ).length,
    comments: model.comments.filter((comment) =>
      links.some((link) => link.id === comment.linkId),
    ),
  };
}

export function applySankeyNodeCommand(
  model: SankeyModel,
  command: SankeyNodeCommand,
) {
  const node = model.nodes.find((node) => node.id === command.id);
  if (!node) return sankeyNoChange(model, "conflict");
  if (command.type === "node.delete") {
    if (!command.confirmed)
      return sankeyNoChange(model, "confirmation-required");
    const impact = sankeyNodeImpact(model, node.id);
    const patches: SankeyPatch[] = impact.links.flatMap((link) => {
      const range = sankeyOwnedLinkRange(model, link.id);
      return range ? [{ range, value: "" }] : [];
    });
    patches.push(...sankeyNodeColorPatches(model, node.label));
    const next = model.links.find((link) => !impact.links.includes(link));
    return sankeyPatchedResult(
      model,
      patches,
      next ? { kind: "link", id: next.id } : null,
    );
  }
  if (node.label === command.label.trim())
    return sankeyNoChange(model, "no-change");
  const target = model.nodes.find(
    (candidate) =>
      candidate.id !== node.id && candidate.label === command.label.trim(),
  );
  if (target && !command.confirmed)
    return sankeyNoChange(model, "confirmation-required");
  const patches: SankeyPatch[] = [];
  for (const occurrence of node.occurrences) {
    const record = model.sourceDocument.records.find(
      (record) => record.id === occurrence.recordId,
    );
    const field = record?.fields[occurrence.field === "source" ? 0 : 1];
    if (!field) return sankeyNoChange(model, "conflict");
    const value = encodeSankeyField(command.label, field);
    if (value === null) return sankeyNoChange(model, "field-syntax");
    patches.push({ range: field.range, value });
  }
  patches.push(
    ...sankeyNodeColorPatches(model, node.label, command.label.trim()),
  );
  return sankeyPatchedResult(model, patches, {
    kind: "node",
    id: target?.id ?? node.id,
  });
}
