// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../utils.js";
import {
  detectMermaidDiagramType,
  hasInvalidMermaidHashPreambleLine,
} from "../diagram-types.js";
import { createMermaidCommonDiagramMetadata } from "../common-metadata.js";
import {
  architectureCommentLine,
  splitArchitectureComment,
} from "./grammar.js";
import type {
  MermaidArchitectureComment,
  MermaidArchitectureModel,
  MermaidArchitectureSourceDiagnostic,
} from "./model.js";
import { parseArchitectureStatements } from "./parsing/statements.js";
import { validateArchitectureStatements } from "./parsing/semantic-validation.js";
import {
  architectureDirectiveProjection,
  architectureFrontmatterMetadata,
  architectureHeaderIndex,
  architectureSourceLines,
  architectureSourceRecordRange,
  type MermaidArchitectureSourceRecord,
} from "./source-document.js";

export type MermaidArchitectureParseResult =
  | {
      diagnostic: MermaidArchitectureSourceDiagnostic;
      model: null;
    }
  | {
      diagnostic: null;
      model: MermaidArchitectureModel;
    };

export function parseMermaidArchitectureSource(
  source: string,
): MermaidArchitectureModel | null {
  return parseMermaidArchitectureSourceResult(source).model;
}

export function parseMermaidArchitectureSourceResult(
  source: string,
): MermaidArchitectureParseResult {
  const sourceDocument = architectureSourceLines(source);
  const lines = sourceDocument.lines;
  const directiveProjection = architectureDirectiveProjection(lines);
  const semanticLines = directiveProjection.lines;
  const headerIndex = architectureHeaderIndex(semanticLines, lines);
  if (detectMermaidDiagramType(source) !== "architecture" || headerIndex < 0) {
    return rejected(
      "architecture-beta header",
      1,
      "Architecture source requires an architecture-beta header.",
    );
  }

  const preambleLines = semanticLines.slice(0, headerIndex);
  const sourcePreambleLines = lines.slice(0, headerIndex);
  if (hasInvalidMermaidHashPreambleLine(sourcePreambleLines)) {
    const invalidLine = invalidHashPreambleLine(sourcePreambleLines);
    const construct = sourcePreambleLines[invalidLine]?.trim() ?? "#";
    return rejected(
      construct,
      invalidLine + 1,
      `Invalid Mermaid preamble construct on line ${invalidLine + 1}: ${construct}`,
    );
  }

  const header = splitArchitectureComment(semanticLines[headerIndex] ?? "");
  if (header.syntax.trim() !== "architecture-beta") {
    return rejected(
      header.syntax.trim() || "diagram header",
      headerIndex + 1,
      `Invalid Architecture header on line ${headerIndex + 1}.`,
    );
  }

  const metadata = createMermaidCommonDiagramMetadata();
  const comments: MermaidArchitectureComment[] = [];
  const records: MermaidArchitectureSourceRecord[] = [];
  for (const frontmatter of architectureFrontmatterMetadata(
    sourcePreambleLines,
  ) ?? []) {
    for (const record of records) {
      if (record.kind === "metadata" && record.field === frontmatter.field) {
        record.effective = false;
      }
    }
    metadata[frontmatter.field] = frontmatter.value;
    records.push({
      commentSuffix: frontmatter.commentSuffix,
      effective: true,
      endLine: frontmatter.endLine,
      field: frontmatter.field,
      fingerprint: JSON.stringify(frontmatter.value),
      format: "frontmatter",
      kind: "metadata",
      startLine: frontmatter.line,
    });
  }

  const addComment = (
    annotation: string,
    position: MermaidArchitectureComment["position"],
  ) => {
    const comment: MermaidArchitectureComment = {
      anchorKind: "diagram",
      id: `comment-${comments.length + 1}`,
      line: architectureCommentLine(annotation),
      position,
    };
    comments.push(comment);
    return comment;
  };
  for (const [lineIndex, line] of preambleLines.entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("%%") || trimmed.startsWith("%%{")) continue;
    const comment = addComment(trimmed.slice(2).trim(), "before");
    records.push({
      fingerprint: comment.line,
      id: comment.id,
      kind: "comment",
      ...architectureSourceRecordRange(
        directiveProjection.directives,
        lineIndex,
        lineIndex + 1,
      ),
    });
  }
  const headerCommentId = header.hasComment
    ? addComment(header.annotation, "after").id
    : undefined;
  records.push({
    commentId: headerCommentId,
    commentFingerprint: header.hasComment
      ? architectureCommentLine(header.annotation)
      : "",
    kind: "header",
    ...architectureSourceRecordRange(
      directiveProjection.directives,
      headerIndex,
      headerIndex + 1,
    ),
  });

  const statementResult = parseArchitectureStatements({
    comments,
    directiveProjection,
    headerIndex,
    metadata,
    records,
    semanticLines,
  });
  if (statementResult.diagnostic) {
    return { diagnostic: statementResult.diagnostic, model: null };
  }
  const semanticDiagnostic = validateArchitectureStatements(
    statementResult.value,
  );
  if (semanticDiagnostic) {
    return { diagnostic: semanticDiagnostic, model: null };
  }

  const parsed = statementResult.value;
  return {
    diagnostic: null,
    model: {
      accessibilityDescription: metadata.accessibilityDescription,
      accessibilityTitle: metadata.accessibilityTitle,
      alignments: parsed.alignments,
      comments: parsed.comments,
      diagramTitle: metadata.diagramTitle,
      diagramType: "architecture",
      directives: directiveProjection.directives.map(
        (directive) => directive.source,
      ),
      edges: parsed.edges,
      groups: parsed.groups,
      headerLine: "architecture-beta",
      junctions: parsed.junctions,
      services: parsed.services,
      sourceAnnotations: parsed.comments.map((comment) => comment.line),
      sourceDocument: {
        ...sourceDocument,
        records: parsed.records,
      },
      sourceHash: hashMermaidSource(source),
      version: 1,
    },
  };
}

function invalidHashPreambleLine(lines: readonly string[]) {
  const hasFrontmatter = lines[0]?.trim() === "---";
  const frontmatterEnd = hasFrontmatter
    ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    : -1;
  return Math.max(
    0,
    lines.findIndex(
      (line, index) =>
        line.trim().startsWith("#") &&
        !(hasFrontmatter && index > 0 && index < frontmatterEnd),
    ),
  );
}

function rejected(
  construct: string,
  line: number,
  message: string,
): MermaidArchitectureParseResult {
  return {
    diagnostic: { construct, line, message },
    model: null,
  };
}
