// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  c4Diagnostic,
  diagnoseC4Calls,
  diagnoseC4Model,
} from "./diagnostics.js";
import { resolveC4Document, c4ResolvedText } from "./resolve.js";

import { hashMermaidSource } from "../../utils.js";
import {
  detectMermaidDiagramType,
  hasInvalidMermaidHashPreambleLine,
} from "../diagram-types.js";
import type {
  MermaidC4Boundary,
  MermaidC4Element,
  MermaidC4Relationship,
  MermaidC4UpdateStatement,
  MermaidC4Model,
} from "./model.js";
import {
  scanC4Source,
  type C4SourceBindings,
  type C4SourceDocument,
  type C4SourceRecord,
} from "./source-document.js";

/** Separate Source/handler validity, GFX projection and the unadapted native renderer. */
export function parseMermaidC4SourceWithDiagnostics(
  source: string,
  bindings: C4SourceBindings = {},
) {
  const document = scanC4Source(source, bindings);
  const model = parseC4Document(document);
  const syntaxValid = !document.diagnostics.some(
    (d) => d.category === "syntax" && d.severity === "error",
  );
  const projectionRenderable = Boolean(
    model && !document.diagnostics.some((d) => d.severity === "error"),
  );
  const nativeRenderable =
    projectionRenderable &&
    !document.diagnostics.some((d) => d.blocksNativeRendering);
  return {
    source,
    document,
    diagnostics: document.diagnostics,
    model,
    syntaxValid,
    projectionRenderable,
    nativeRenderable,
  };
}

export function parseMermaidC4Source(
  source: string,
  bindings: C4SourceBindings = {},
): MermaidC4Model | null {
  const result = parseMermaidC4SourceWithDiagnostics(source, bindings);
  return result.projectionRenderable ? result.model : null;
}

function parseC4Document(document: C4SourceDocument): MermaidC4Model | null {
  const diagnose = (record: C4SourceRecord, code: string, message: string) =>
    document.diagnostics.push(c4Diagnostic(record, code, message));
  const header = document.records.find((r) => r.kind === "header");
  if (!header || detectMermaidDiagramType(document.source) !== "c4") {
    const first = document.records[0];
    if (first)
      document.diagnostics.push(
        c4Diagnostic(
          first,
          "c4.header.missing",
          "Choose a C4Context, C4Container, C4Component, C4Dynamic or C4Deployment header.",
          { correction: "header" },
        ),
      );
    return null;
  }
  if (
    hasInvalidMermaidHashPreambleLine(
      document.source.slice(0, header.range.start).split(/\r\n|\r|\n/),
    )
  )
    diagnose(
      header,
      "c4.preamble.invalid",
      "Correct the invalid C4 preamble before rendering.",
    );
  let accessibilityTitle = "",
    accessibilityDescription = "",
    title = "";
  for (const record of document.records) {
    if (record.kind === "title") title = record.value ?? "";
    if (record.kind === "accessibility-title")
      accessibilityTitle = record.value ?? "";
    if (
      record.kind === "accessibility-description" &&
      !(/^accDescr\s*\{/.test(record.raw.trimStart()) && !record.value)
    )
      accessibilityDescription = record.value ?? "";
  }
  diagnoseC4Calls(document);
  const resolved = resolveC4Document(document);
  const declaration = (key: string) =>
    document.records.find((r) => r.sourceKey === key)!;
  const elements: MermaidC4Element[] = [...resolved.elements].map(
    ([alias, resolution], order) => ({
      resolution,
      alias,
      id: alias,
      order,
      callArguments: declaration(resolution.declarationKey).arguments!,
      kind: declaration(resolution.declarationKey).callKind!,
      label: c4ResolvedText(resolution, "label"),
      boundaryId:
        c4ResolvedText(resolution, "parentBoundary") === "global"
          ? ""
          : c4ResolvedText(resolution, "parentBoundary"),
      description: c4ResolvedText(resolution, "descr"),
      technology: c4ResolvedText(resolution, "techn"),
      sprite: c4ResolvedText(resolution, "sprite"),
      tags: c4ResolvedText(resolution, "tags"),
      link: c4ResolvedText(resolution, "link"),
      width: 150,
      x: 0,
      y: 0,
    }),
  );
  const boundaries: MermaidC4Boundary[] = [...resolved.boundaries].map(
    ([id, resolution], order) => ({
      resolution,
      alias: id,
      nodeType: resolution.fields.nodeType,
      id,
      order,
      callArguments: declaration(resolution.declarationKey).arguments!,
      kind: declaration(resolution.declarationKey).callKind!,
      label: c4ResolvedText(resolution, "label"),
      boundaryType: c4ResolvedText(resolution, "type"),
      parentId:
        c4ResolvedText(resolution, "parentBoundary") === "global"
          ? ""
          : c4ResolvedText(resolution, "parentBoundary"),
      description: c4ResolvedText(resolution, "descr"),
      sprite: c4ResolvedText(resolution, "sprite"),
      tags: c4ResolvedText(resolution, "tags"),
      link: c4ResolvedText(resolution, "link"),
      width: 320,
      height: 180,
      x: 0,
      y: 0,
    }),
  );
  const relationships: MermaidC4Relationship[] = [
    ...resolved.relationships.values(),
  ].map((resolution, order) => {
    const record = declaration(resolution.declarationKey),
      kind = record.callKind!;
    const from = c4ResolvedText(resolution, "from"),
      to = c4ResolvedText(resolution, "to");
    return {
      resolution,
      id: `relationship-${from}-${to}-${order + 1}`,
      order,
      from,
      to,
      kind,
      callArguments: record.arguments!,
      index: kind === "RelIndex" ? record.arguments![0].value : null,
      ...(header.value === "C4Dynamic" ? { dynamicStep: order + 1 } : {}),
      label: c4ResolvedText(resolution, "label"),
      description: c4ResolvedText(resolution, "descr"),
      technology: c4ResolvedText(resolution, "techn"),
      sprite: c4ResolvedText(resolution, "sprite"),
      tags: c4ResolvedText(resolution, "tags"),
      link: c4ResolvedText(resolution, "link"),
    };
  });
  const updateStatements: MermaidC4UpdateStatement[] = resolved.occurrences
    .filter((r) => r.category === "update")
    .map((r, order) => ({
      sourceKey: r.sourceKey,
      kind: r.kind as MermaidC4UpdateStatement["kind"],
      callArguments: r.callArguments,
      order,
    }));
  if (document.diagnostics.some((d) => d.severity === "error")) return null;
  const model: MermaidC4Model = {
    accessibilityTitle,
    accessibilityDescription,
    boundaries,
    diagramType: "c4",
    direction: "TB",
    elements,
    directives: document.records
      .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
      .flatMap((r) => r.raw.split(/\r\n|\r|\n/)),
    headerLine: header.value!,
    layoutBoundaryInRow: resolved.layoutBoundaryInRow,
    layoutShapeInRow: resolved.layoutShapeInRow,
    relationships,
    sourceDocument: document,
    occurrences: resolved.occurrences,
    sourceHash: hashMermaidSource(document.source),
    title,
    updateStatements,
    version: 1,
  };
  diagnoseC4Model(document, model);
  return document.diagnostics.some(
    (d) => d.category === "identity" && d.severity === "error",
  )
    ? null
    : model;
}
