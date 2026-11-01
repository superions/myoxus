// SPDX-License-Identifier: AGPL-3.0-or-later

import { detectMermaidDiagramType } from "../../diagram-types.js";
import { readTreemapConfig } from "./config.js";
import type { TreemapDiagnostic } from "./diagnostics.js";
import type {
  TreemapClassDeclaration,
  TreemapClassDef,
  TreemapComment,
  TreemapModel,
  TreemapNode,
  TreemapQuote,
} from "./model.js";
import { scanTreemapSource, type TreemapRange } from "./source-document.js";
import {
  reconcileTreemapSource,
  type TreemapRecordMapping,
} from "./source-identity.js";

const NODE_RE =
  /^([ \t]*)(?:"([^"]*)"|'([^']*)')([ \t]*)(?:(:|,)([ \t]*)([0-9_.,]+))?([ \t]*)(?::::([A-Za-z_][A-Za-z0-9_]*))?([ \t]*)$/;
const CLASS_RE =
  /^([ \t]*)classDef\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+([^;\r\n]*))?(;?)([ \t]*)$/;

function fieldRange(
  recordRange: TreemapRange,
  start: number,
  end: number,
): TreemapRange {
  return {
    start: recordRange.start + start,
    end: recordRange.start + end,
    line: recordRange.line,
    endLine: recordRange.line,
  };
}

function classDeclarations(raw: string): TreemapClassDeclaration[] {
  const result: TreemapClassDeclaration[] = [];
  let current = "";
  let escaped = false;
  for (const character of raw) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === ",") {
      const colon = current.indexOf(":");
      result.push({
        raw: current,
        property: colon < 0 ? current.trim() : current.slice(0, colon).trim(),
        value: colon < 0 ? "" : current.slice(colon + 1).trim(),
      });
      current = "";
    } else current += character;
  }
  if (current || raw.endsWith(",")) {
    const colon = current.indexOf(":");
    result.push({
      raw: current,
      property: colon < 0 ? current.trim() : current.slice(0, colon).trim(),
      value: colon < 0 ? "" : current.slice(colon + 1).trim(),
    });
  }
  return result;
}

function metadataValue(raw: string, kind: string) {
  if (kind === "title")
    return raw
      .trim()
      .replace(/^title\s*/i, "")
      .trim();
  if (kind === "accessibility-title")
    return raw
      .trim()
      .replace(/^accTitle\s*:\s*/i, "")
      .trim();
  return raw
    .trim()
    .replace(/^accDescr\s*:\s*/i, "")
    .replace(/^accDescr\s*\{\s*/i, "")
    .replace(/\s*\}$/, "")
    .trim();
}

/** Parses all bounded statements and excludes only unsafe hierarchy branches. */
export function parseTreemapSource(
  source: string,
  previous?: TreemapModel,
  mapping?: TreemapRecordMapping,
): TreemapModel | null {
  if (detectMermaidDiagramType(source) !== "treemap") return null;
  const reconciled = reconcileTreemapSource(
    scanTreemapSource(source),
    previous?.sourceDocument,
    mapping,
  );
  const sourceDocument = reconciled.document;
  const diagnostics: TreemapDiagnostic[] = reconciled.conflicts.map(
    (recordId) => ({
      code: "conflict",
      recordId,
      range: { start: 0, end: 0, line: 1, endLine: 1 },
      impact: "record",
    }),
  );
  const configuration = readTreemapConfig(sourceDocument);
  diagnostics.push(...configuration.diagnostics);
  const classDefs: TreemapClassDef[] = [];
  const nodes: TreemapNode[] = [];
  let ambiguous = false;
  let title = configuration.frontmatterTitle;
  let accessibilityTitle = "";
  let accessibilityDescription = "";
  let sourceOrder = 0;
  for (const record of sourceDocument.records) {
    if (!record.complete) {
      ambiguous = true;
      diagnostics.push({
        code: "ambiguous-source",
        recordId: record.id,
        range: record.range,
        impact: "document",
      });
      continue;
    }
    if (record.kind === "title") title = metadataValue(record.raw, record.kind);
    if (record.kind === "accessibility-title")
      accessibilityTitle = metadataValue(record.raw, record.kind);
    if (record.kind === "accessibility-description")
      accessibilityDescription = metadataValue(record.raw, record.kind);
    if (record.kind === "class-def") {
      const match = CLASS_RE.exec(record.raw);
      if (!match) {
        diagnostics.push({
          code: "class-def",
          recordId: record.id,
          range: record.range,
          impact: "style",
        });
        continue;
      }
      const nameStart = match[1].length + record.raw.indexOf("classDef") + 8;
      const nameOffset = record.raw.indexOf(match[2], nameStart);
      const style = match[3] ?? "";
      const styleOffset = style
        ? record.raw.indexOf(style, nameOffset + match[2].length)
        : -1;
      classDefs.push({
        id:
          previous?.classDefs.find(
            (candidate) => candidate.recordId === record.id,
          )?.id ?? crypto.randomUUID(),
        recordId: record.id,
        name: match[2],
        nameRange: fieldRange(
          record.range,
          nameOffset,
          nameOffset + match[2].length,
        ),
        styleRange:
          styleOffset >= 0
            ? fieldRange(record.range, styleOffset, styleOffset + style.length)
            : undefined,
        declarations: classDeclarations(style),
        semicolon: match[4] === ";",
      });
      continue;
    }
    if (record.kind !== "node" && record.kind !== "unknown") continue;
    const match = NODE_RE.exec(record.raw);
    if (!match) {
      if (record.kind === "unknown") {
        diagnostics.push({
          code: "unknown-statement",
          recordId: record.id,
          range: record.range,
          impact: "record",
        });
      } else {
        diagnostics.push({
          code: "malformed-node",
          recordId: record.id,
          field: "label",
          range: record.range,
          impact: "record",
        });
      }
      continue;
    }
    const indent = match[1];
    const label = match[2] ?? match[3] ?? "";
    const labelQuote: TreemapQuote =
      match[2] === undefined ? "single" : "double";
    const quote = labelQuote === "double" ? '"' : "'";
    const labelStart = record.raw.indexOf(quote) + 1;
    const separator = (match[5] as ":" | "," | undefined) ?? null;
    const valueLexeme = match[7] ?? null;
    const value =
      valueLexeme === null
        ? null
        : Number.parseFloat(valueLexeme.replaceAll(",", ""));
    const className = match[9] ?? null;
    const valueOffset = valueLexeme
      ? record.raw.indexOf(valueLexeme, labelStart + label.length + 1)
      : -1;
    const classOffset = className ? record.raw.lastIndexOf(className) : -1;
    const previousNode = previous?.nodes.find(
      (candidate) => candidate.recordId === record.id,
    );
    nodes.push({
      id: previousNode?.id ?? crypto.randomUUID(),
      recordId: record.id,
      label,
      labelQuote,
      labelRange: fieldRange(
        record.range,
        labelStart,
        labelStart + label.length,
      ),
      indent,
      indentRange: fieldRange(record.range, 0, indent.length),
      separator,
      separatorRange: separator
        ? fieldRange(
            record.range,
            record.raw.indexOf(separator, labelStart + label.length + 1),
            record.raw.indexOf(separator, labelStart + label.length + 1) + 1,
          )
        : undefined,
      value,
      valueLexeme,
      valueRange:
        valueOffset >= 0
          ? fieldRange(
              record.range,
              valueOffset,
              valueOffset + valueLexeme!.length,
            )
          : undefined,
      className,
      classRange:
        classOffset >= 0
          ? fieldRange(
              record.range,
              classOffset,
              classOffset + className!.length,
            )
          : undefined,
      parentId: null,
      depth: 0,
      sourceOrder: sourceOrder++,
      renderable: Number.isFinite(value ?? 0),
    });
    if (valueLexeme && !Number.isFinite(value))
      diagnostics.push({
        code: "invalid-number",
        recordId: record.id,
        field: "value",
        range: fieldRange(
          record.range,
          valueOffset,
          valueOffset + valueLexeme.length,
        ),
        impact: "record",
      });
  }

  const stack: TreemapNode[] = [];
  let unsafeIndent: number | null = null;
  let previousNode: TreemapNode | undefined;
  const malformedHierarchy = sourceDocument.records
    .filter(
      (record) =>
        record.kind === "node" &&
        diagnostics.some(
          (diagnostic) =>
            diagnostic.recordId === record.id &&
            diagnostic.code === "malformed-node",
        ),
    )
    .map((record) => ({
      indent: record.raw.match(/^[ \t]*/)?.[0].length ?? 0,
      start: record.range.start,
    }));
  let previousRangeEnd = 0;
  const hierarchical = nodes.map((node) => {
    const indent = node.indent.length;
    const malformed = malformedHierarchy.find(
      (candidate) =>
        candidate.start >= previousRangeEnd &&
        candidate.start < node.labelRange.start,
    );
    if (malformed && indent > malformed.indent) unsafeIndent = malformed.indent;
    while (stack.length && stack[stack.length - 1].indent.length >= indent)
      stack.pop();
    if (unsafeIndent !== null && indent <= unsafeIndent) unsafeIndent = null;
    const parent = stack.at(-1);
    let renderable = node.renderable;
    if (unsafeIndent !== null && indent > unsafeIndent) {
      renderable = false;
      diagnostics.push({
        code: "orphan",
        recordId: node.recordId,
        field: "parent",
        range: node.indentRange,
        impact: "hierarchy",
      });
    } else if (
      previousNode &&
      indent > previousNode.indent.length &&
      previousNode.value !== null
    ) {
      renderable = false;
      unsafeIndent = previousNode.indent.length;
      diagnostics.push({
        code: "leaf-parent",
        recordId: node.recordId,
        field: "parent",
        range: node.indentRange,
        parentRange: previousNode.labelRange,
        impact: "hierarchy",
      });
    }
    const next = {
      ...node,
      parentId: renderable ? (parent?.id ?? null) : null,
      depth: renderable ? (parent?.depth ?? -1) + 1 : 0,
      renderable,
    };
    if (node.value === null && renderable) stack.push(next);
    previousNode = node;
    previousRangeEnd = node.labelRange.end;
    return next;
  });
  const roots = hierarchical
    .filter((node) => node.renderable && node.parentId === null)
    .map((node) => node.id);
  if (roots.length > 1) {
    for (const id of roots) {
      const node = hierarchical.find((candidate) => candidate.id === id)!;
      diagnostics.push({
        code: "multiple-roots",
        recordId: node.recordId,
        field: "parent",
        range: node.labelRange,
        impact: "hierarchy",
      });
    }
  }
  const classNames = new Set(classDefs.map((classDef) => classDef.name));
  for (const node of hierarchical) {
    if (node.className && !classNames.has(node.className))
      diagnostics.push({
        code: "unresolved-class",
        recordId: node.recordId,
        field: "class",
        range: node.classRange ?? node.labelRange,
        impact: "style",
      });
  }

  const comments: TreemapComment[] = [];
  for (const [index, record] of sourceDocument.records.entries()) {
    if (record.kind !== "comment") continue;
    let first = index;
    let last = index;
    while (sourceDocument.records[first - 1]?.kind === "comment") first -= 1;
    while (sourceDocument.records[last + 1]?.kind === "comment") last += 1;
    const before = sourceDocument.records[first - 1];
    const after = sourceDocument.records[last + 1];
    const indent = record.raw.match(/^[ \t]*/)?.[0].length ?? 0;
    const separatedBefore =
      !before || before.kind === "header" || before.kind === "blank";
    const afterIndent = after?.raw.match(/^[ \t]*/)?.[0].length ?? -1;
    let anchor: TreemapComment["anchor"] = { kind: "diagram" };
    if (separatedBefore && after && indent === afterIndent) {
      const node = hierarchical.find(
        (candidate) => candidate.recordId === after.id,
      );
      const classDef = classDefs.find(
        (candidate) => candidate.recordId === after.id,
      );
      if (node) anchor = { kind: "node", id: node.id };
      else if (classDef) anchor = { kind: "class-def", id: classDef.id };
      else if (
        after.kind === "title" ||
        after.kind === "accessibility-title" ||
        after.kind === "accessibility-description"
      )
        anchor = { kind: "metadata", id: after.id };
    }
    comments.push({
      id:
        previous?.comments.find((candidate) => candidate.recordId === record.id)
          ?.id ?? crypto.randomUUID(),
      recordId: record.id,
      text: record.raw.trim().slice(2).trim(),
      anchor,
    });
  }

  return {
    diagramType: "treemap",
    version: 2,
    sourceDocument,
    nodes: hierarchical,
    roots,
    classDefs,
    comments,
    diagnostics,
    ambiguous,
    config: configuration.effective,
    configOverrides: [
      ...new Set(
        configuration.occurrences.map((occurrence) => occurrence.field),
      ),
    ],
    title,
    accessibilityTitle,
    accessibilityDescription,
  };
}
