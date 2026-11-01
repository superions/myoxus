// SPDX-License-Identifier: AGPL-3.0-or-later

import { detectMermaidDiagramType } from "../../diagram-types.js";
import DOMPurify from "dompurify";
import { readSankeyConfig } from "./config.js";
import { sankeyCyclicLinks, type SankeyDiagnostic } from "./diagnostics.js";
import type { SankeyModel, SankeyNode, SankeyLink } from "./model.js";
import { scanSankeySource } from "./source-document.js";
import {
  reconcileSankeyRecords,
  type SankeyRecordMapping,
} from "./source-identity.js";

/** Retains bounded invalid records so their endpoint/value can be repaired. */
export function parseSankeySource(
  source: string,
  previous?: SankeyModel,
  mapping?: SankeyRecordMapping,
): SankeyModel | null {
  if (detectMermaidDiagramType(source) !== "sankey") return null;
  const reconciled = reconcileSankeyRecords(
    scanSankeySource(source),
    previous?.sourceDocument,
    mapping,
  );
  const sourceDocument = reconciled.document;
  const configuration = readSankeyConfig(sourceDocument);
  const effectiveConfig = {
    ...configuration.effective,
    nodeColors: { ...configuration.effective.nodeColors },
  };
  if (previous) {
    for (const diagnostic of configuration.diagnostics) {
      if (!diagnostic.configField) continue;
      Object.assign(effectiveConfig, {
        [diagnostic.configField]: previous.config[diagnostic.configField],
      });
    }
  }
  const diagnostics: SankeyDiagnostic[] = reconciled.conflicts.map(
    (recordId) => ({ code: "conflict", recordId, line: 1, impact: "record" }),
  );
  diagnostics.push(...configuration.diagnostics);
  const nodes = new Map<string, SankeyNode>();
  const links: SankeyLink[] = [];
  let ambiguous = false;
  for (const record of sourceDocument.records) {
    if (!record.complete) {
      ambiguous = true;
      diagnostics.push({
        code: "ambiguous-record",
        recordId: record.id,
        line: record.range.line,
        impact: "document",
      });
    }
    if (record.kind !== "csv") continue;
    const fields = ["source", "target", "value"] as const;
    const local: SankeyDiagnostic[] = [];
    if (record.fields.length !== 3)
      local.push({
        code: "field-count",
        recordId: record.id,
        line: record.range.line,
        impact: "record",
      });
    for (const [index, field] of record.fields.entries()) {
      if (!field.valid)
        local.push({
          code: "field-syntax",
          recordId: record.id,
          line: field.range.line,
          field: fields[index],
          impact: "record",
        });
    }
    const endpoints = fields.slice(0, 2).map((field, index) => {
      const value = DOMPurify.sanitize(record.fields[index]?.value ?? "", {
        FORBID_TAGS: ["style"],
      });
      if (!value) {
        local.push({
          code: "empty-endpoint",
          recordId: record.id,
          line: record.range.line,
          field,
          impact: "record",
        });
        return undefined;
      }
      if (!record.fields[index].valid) return undefined;
      const existing = nodes.get(value);
      const survivingNode = previous?.nodes.find(
        (node) =>
          node.label === value &&
          node.occurrences.some((occurrence) => {
            const nextRecord = sourceDocument.records.find(
              (candidate) => candidate.id === occurrence.recordId,
            );
            return (
              DOMPurify.sanitize(
                nextRecord?.fields[occurrence.field === "source" ? 0 : 1]
                  ?.value ?? "",
                { FORBID_TAGS: ["style"] },
              ) === value
            );
          }),
      );
      const oldNode =
        survivingNode ??
        previous?.nodes.find(
          (node) =>
            node.occurrences.some(
              (occurrence) =>
                occurrence.recordId === record.id && occurrence.field === field,
            ) &&
            (node.label === value ||
              node.occurrences.every((occurrence) => {
                const nextRecord = sourceDocument.records.find(
                  (candidate) => candidate.id === occurrence.recordId,
                );
                return (
                  nextRecord?.fields[occurrence.field === "source" ? 0 : 1]
                    ?.value === value
                );
              })),
        );
      const node: SankeyNode = {
        id: existing?.id ?? oldNode?.id ?? crypto.randomUUID(),
        label: value,
        occurrences: [
          ...(existing?.occurrences ?? []),
          { recordId: record.id, field: field as "source" | "target" },
        ],
      };
      nodes.set(value, node);
      return node.id;
    });
    const value = Number.parseFloat(record.fields[2]?.value ?? "");
    if (!Number.isFinite(value) || value < 0)
      local.push({
        code: Number.isFinite(value) ? "negative-value" : "invalid-value",
        recordId: record.id,
        line: record.fields[2]?.range.line ?? record.range.line,
        field: "value",
        effectiveValue: value,
        impact: "layout",
      });
    if (endpoints[0] && endpoints[0] === endpoints[1])
      local.push({
        code: "self-link",
        recordId: record.id,
        line: record.range.line,
        impact: "layout",
      });
    diagnostics.push(...local);
    links.push({
      id: record.id,
      source: endpoints[0],
      target: endpoints[1],
      value,
      renderable: local.length === 0 && record.complete,
    });
  }
  const cyclic = sankeyCyclicLinks(links);
  for (const id of cyclic)
    diagnostics.push({
      code: "cycle",
      recordId: id,
      line: sourceDocument.records.find((record) => record.id === id)!.range
        .line,
      impact: "layout",
    });
  return {
    diagramType: "sankey",
    version: 2,
    sourceDocument,
    nodes: [...nodes.values()],
    links: links.map((link) =>
      cyclic.has(link.id) ? { ...link, renderable: false } : link,
    ),
    diagnostics,
    ambiguous,
    config: effectiveConfig,
    configOverrides: [
      ...new Set(configuration.occurrences.map(({ field }) => field)),
    ],
    title: configuration.title,
    comments: sourceDocument.records.flatMap((record, index, records) => {
      if (record.kind !== "comment") return [];
      let first = index;
      let last = index;
      while (first > 0 && records[first - 1].kind === "comment") first--;
      while (last + 1 < records.length && records[last + 1].kind === "comment")
        last++;
      const preceding = records[first - 1];
      const following = records[last + 1];
      const linkId =
        (preceding?.kind === "header" || preceding?.kind === "blank") &&
        following?.kind === "csv"
          ? following.id
          : undefined;
      return [
        { id: record.id, text: record.raw.trim().slice(2).trim(), linkId },
      ];
    }),
  };
}
