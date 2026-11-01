// SPDX-License-Identifier: AGPL-3.0-or-later

import { mindmapDiagnostic, type MindmapDiagnostic } from "./diagnostics.js";
import { hashMermaidSource } from "../../utils.js";
import {
  detectMermaidDiagramType,
  getMermaidSourceHeaderIndex,
  partitionMermaidSourcePreamble,
} from "../diagram-types.js";
import type { MermaidMindmapModel, MermaidMindmapNode } from "./model.js";

import {
  effectiveMindmapDecorations,
  findMindmapParent,
} from "./runtime-contract.js";

import {
  scanMindmapSource,
  type MindmapSourceBindings,
} from "./source-document.js";

function layoutMindmap(nodes: MermaidMindmapNode[]) {
  const depthOrder = new Map<number, number>();
  return nodes
    .sort((a, b) => a.order - b.order)
    .map((node, index) => {
      const localOrder = depthOrder.get(node.depth) ?? 0;
      depthOrder.set(node.depth, localOrder + 1);
      const width = Math.max(116, Math.min(240, 76 + node.label.length * 8));
      return {
        ...node,
        order: index,
        width,
        x: 48 + node.depth * 190,
        y: 52 + localOrder * 82,
      };
    });
}

export function resolveMermaidMindmapSource(
  source: string,
  bindings: MindmapSourceBindings = {},
): {
  model: MermaidMindmapModel | null;
  diagnostics: MindmapDiagnostic[];
  sourceDocument: ReturnType<typeof scanMindmapSource>;
} {
  const sourceHash = hashMermaidSource(source);
  const sourceDocument = scanMindmapSource(source, bindings);
  const diagnostics: MindmapDiagnostic[] = [];
  if (detectMermaidDiagramType(source) !== "mindmap")
    return {
      model: null,
      sourceDocument,
      diagnostics: [
        mindmapDiagnostic("mindmap.syntax.header", sourceDocument.records[0]),
      ],
    };

  const lines = source
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const headerIndex = getMermaidSourceHeaderIndex(source);
  if (headerIndex < 0)
    return {
      model: null,
      sourceDocument,
      diagnostics: [
        mindmapDiagnostic("mindmap.syntax.header", sourceDocument.records[0]),
      ],
    };

  const preamble = partitionMermaidSourcePreamble(lines.slice(0, headerIndex));
  const directives = preamble.directives.filter(
    (line) => !line.trim().startsWith("#"),
  );
  const headerLine =
    sourceDocument.records.find((r) => r.kind === "header")?.raw.trim() ??
    "mindmap";
  const sourceAnnotations = [
    ...preamble.comments,
    ...preamble.directives
      .map((line) => line.trim())
      .filter((line) => line.startsWith("#"))
      .map((line) => line.slice(1).trim()),
  ].map((comment) => (comment ? `%% ${comment}` : "%%"));
  const nodes: MermaidMindmapNode[] = [];
  const entries: Array<{ indent: number; node: MermaidMindmapNode }> = [];
  const providers = new Map<
    string,
    import("./source-document.js").MindmapRecord
  >();
  for (const record of sourceDocument.records) {
    if (record.kind === "invalid" || record.diagnosticCode) {
      diagnostics.push(
        mindmapDiagnostic(
          record.diagnosticCode ?? "mindmap.syntax.node",
          record,
        ),
      );
      continue;
    }
    if (record.kind === "comment") {
      sourceAnnotations.push(record.raw.trim());
      continue;
    }
    if (record.kind === "icon" || record.kind === "class") {
      const node = nodes.at(-1),
        value = record.value ?? "";
      if (!node && value)
        diagnostics.push(mindmapDiagnostic("mindmap.decorator.node", record));
      record.effective = false;
      if (node) {
        (node.decorations ??= []).push({
          kind: record.kind,
          value,
          sourceKey: record.sourceKey,
        });
        if (value) {
          const providerKey = `${node.sourceKey}:${record.kind}`;
          const previous = providers.get(providerKey);
          if (previous) previous.effective = false;
          record.effective = true;
          providers.set(providerKey, record);
        }
        Object.assign(node, effectiveMindmapDecorations(node.decorations));
      }
      continue;
    }
    if (!record.node) continue;
    const parsed = record.node,
      indent = (record.nativeIndent ?? record.indent).length;
    const parent = findMindmapParent(entries, indent);
    if (nodes.length && !parent) {
      diagnostics.push(mindmapDiagnostic("mindmap.tree.root", record));
      continue;
    }
    const node: MermaidMindmapNode = {
      sourceKey: record.sourceKey,
      syntaxId: parsed.syntaxId || parsed.label,
      runtimeId: nodes.length,
      depth: parent ? parent.node.depth + 1 : 0,
      id: `node-${nodes.length + 1}`,
      label: parsed.label.replace(/\r\n?/g, "\n"),
      order: nodes.length,
      parentId: parent?.node.id ?? null,
      root: nodes.length === 0,
      shape: parsed.shape,
      syntax: {
        syntaxId: parsed.syntaxId,
        labelForm: parsed.labelForm,
        open: parsed.open,
        close: parsed.close,
      },
      decorations: [],
      width: 116,
      x: 0,
      y: 0,
    };
    nodes.push(node);
    entries.push({ indent, node });
  }

  if (diagnostics.length) return { model: null, sourceDocument, diagnostics };

  const model: MermaidMindmapModel = {
    diagramType: "mindmap",
    sourceDocument,
    directives,
    headerLine,
    nodes: layoutMindmap(nodes),
    sourceAnnotations,
    sourceHash,
    version: 1,
  };
  return { model, diagnostics, sourceDocument };
}

export function parseMermaidMindmapSource(
  source: string,
  bindings: MindmapSourceBindings = {},
): MermaidMindmapModel | null {
  return resolveMermaidMindmapSource(source, bindings).model;
}
