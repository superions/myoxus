// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  consumeMermaidCommonMetadata,
  type MermaidCommonDiagramMetadata,
} from "../../common-metadata.js";
import {
  ALIGN_RE,
  ARCHITECTURE_ICON,
  ARCHITECTURE_STRING,
  ARCHITECTURE_TITLE,
  EDGE_RE,
  GROUP_RE,
  JUNCTION_RE,
  SERVICE_RE,
  architectureCommentLine,
  architectureSemanticFingerprint,
  architectureStableStatementId,
  decodeArchitectureString,
  decodeArchitectureTitle,
  splitArchitectureComment,
} from "../grammar.js";
import type {
  MermaidArchitectureAlignment,
  MermaidArchitectureComment,
  MermaidArchitectureEdge,
  MermaidArchitectureGroup,
  MermaidArchitectureJunction,
  MermaidArchitectureService,
  MermaidArchitectureSourceDiagnostic,
} from "../model.js";
import type {
  MermaidArchitectureSourceRecord,
  MermaidArchitectureStatementKind,
} from "../source-document.js";
import {
  architectureDirectiveProjection,
  architectureSourceRecordRange,
} from "../source-document.js";

const LOOSE_ID = "[^\\s():\\[\\]{}]+";
const LOOSE_PARENT = `(?:(?:\\s+|(?<=[\\)\\]"']))in\\s+(${LOOSE_ID}))?`;
const LOOSE_GROUP_RE = new RegExp(
  `^\\s*group\\s+(${LOOSE_ID})(?:\\s*(${ARCHITECTURE_ICON}))?(?:\\s*(${ARCHITECTURE_TITLE}))?${LOOSE_PARENT}\\s*$`,
);
const LOOSE_SERVICE_RE = new RegExp(
  `^\\s*service\\s+(${LOOSE_ID})(?:\\s*(${ARCHITECTURE_ICON}|${ARCHITECTURE_STRING}))?(?:\\s*(${ARCHITECTURE_TITLE}))?${LOOSE_PARENT}\\s*$`,
);
const LOOSE_JUNCTION_RE = new RegExp(
  `^\\s*junction\\s+(${LOOSE_ID})(?:\\s+in\\s+(${LOOSE_ID}))?\\s*$`,
);
const LOOSE_ALIGN_RE = new RegExp(
  `^\\s*align\\s+(row|column)\\s+(${LOOSE_ID}(?:\\s+${LOOSE_ID})*)\\s*$`,
);
const LOOSE_EDGE_RE = new RegExp(
  `^\\s*(${LOOSE_ID})\\s*(\\{group\\})?\\s*:\\s*([^\\s<>-]+)\\s*([<>])?\\s*(?:--|-\\s*(${ARCHITECTURE_TITLE})\\s*-)\\s*([<>])?\\s*([^\\s<>-]+)\\s*:\\s*(${LOOSE_ID})\\s*(\\{group\\})?\\s*$`,
);

export type LocatedArchitectureStatement =
  | {
      construct: string;
      kind: "alignment";
      line: number;
      value: MermaidArchitectureAlignment;
    }
  | {
      construct: string;
      kind: "edge";
      line: number;
      value: MermaidArchitectureEdge;
    }
  | {
      construct: string;
      kind: "group";
      line: number;
      value: MermaidArchitectureGroup;
    }
  | {
      construct: string;
      kind: "junction";
      line: number;
      value: MermaidArchitectureJunction;
    }
  | {
      construct: string;
      kind: "service";
      line: number;
      value: MermaidArchitectureService;
    };

export type ParsedArchitectureStatements = {
  alignments: MermaidArchitectureAlignment[];
  comments: MermaidArchitectureComment[];
  edges: MermaidArchitectureEdge[];
  groups: MermaidArchitectureGroup[];
  junctions: MermaidArchitectureJunction[];
  located: LocatedArchitectureStatement[];
  records: MermaidArchitectureSourceRecord[];
  services: MermaidArchitectureService[];
};

export function parseArchitectureStatements({
  comments: initialComments,
  directiveProjection,
  headerIndex,
  metadata,
  records: initialRecords,
  semanticLines,
}: {
  comments: MermaidArchitectureComment[];
  directiveProjection: ReturnType<typeof architectureDirectiveProjection>;
  headerIndex: number;
  metadata: MermaidCommonDiagramMetadata;
  records: MermaidArchitectureSourceRecord[];
  semanticLines: readonly string[];
}):
  | { diagnostic: MermaidArchitectureSourceDiagnostic; value?: never }
  | { diagnostic?: never; value: ParsedArchitectureStatements } {
  const comments = initialComments;
  const records = initialRecords;
  const alignments: MermaidArchitectureAlignment[] = [];
  const groups: MermaidArchitectureGroup[] = [];
  const junctions: MermaidArchitectureJunction[] = [];
  const services: MermaidArchitectureService[] = [];
  const edges: MermaidArchitectureEdge[] = [];
  const located: LocatedArchitectureStatement[] = [];
  const pendingComments: MermaidArchitectureComment[] = [];
  const alignmentOccurrences = new Map<string, number>();
  const edgeOccurrences = new Map<string, number>();
  const recordRange = (startLine: number, endLine: number) =>
    architectureSourceRecordRange(
      directiveProjection.directives,
      startLine,
      endLine,
    );
  const addComment = (
    annotation: string,
    anchorKind: MermaidArchitectureComment["anchorKind"],
    position: MermaidArchitectureComment["position"],
    anchorId?: string,
  ) => {
    const comment: MermaidArchitectureComment = {
      anchorId,
      anchorKind,
      id: `comment-${comments.length + pendingComments.length + 1}`,
      line: architectureCommentLine(annotation),
      position,
    };
    comments.push(comment);
    return comment;
  };
  const anchorPendingComments = (
    anchorKind: MermaidArchitectureComment["anchorKind"],
    anchorId?: string,
  ) => {
    for (const comment of pendingComments.splice(0)) {
      comments.push({ ...comment, anchorId, anchorKind, position: "before" });
    }
  };

  const bodyLines = semanticLines.slice(headerIndex + 1);
  for (let index = 0; index < bodyLines.length;) {
    const sourceLineIndex = headerIndex + 1 + index;
    const lineNumber = sourceLineIndex + 1;
    const originalLine = bodyLines[index];
    const common = consumeMermaidCommonMetadata(bodyLines, index, metadata);
    if (common.kind === "invalid") {
      return {
        diagnostic: {
          construct: originalLine.trim(),
          line: lineNumber,
          message: `Invalid Architecture metadata on line ${lineNumber}: ${originalLine.trim()}`,
        },
      };
    }
    if (common.kind === "consumed") {
      const field = /^\s*title(?:\s|$)/.test(originalLine)
        ? ("diagramTitle" as const)
        : /^\s*accTitle\s*:/.test(originalLine)
          ? ("accessibilityTitle" as const)
          : ("accessibilityDescription" as const);
      anchorPendingComments("metadata", field);
      const commentLine = bodyLines[common.nextIndex - 1];
      const commentSource = common.multiline
        ? commentLine.slice(commentLine.indexOf("}") + 1)
        : commentLine;
      const comment = splitArchitectureComment(commentSource);
      const commentId = comment.hasComment
        ? addComment(comment.annotation, "metadata", "after", field).id
        : undefined;
      for (const record of records) {
        if (record.kind === "metadata" && record.field === field) {
          record.effective = false;
        }
      }
      records.push({
        commentId,
        commentSuffix: comment.hasComment
          ? architectureCommentLine(comment.annotation)
          : "",
        effective: true,
        field,
        fingerprint: JSON.stringify(metadata[field]),
        format: "body",
        kind: "metadata",
        ...recordRange(sourceLineIndex, headerIndex + 1 + common.nextIndex),
      });
      index = common.nextIndex;
      continue;
    }

    const current = splitArchitectureComment(originalLine);
    const syntax = current.syntax;
    const construct = syntax.trim();
    if (!construct) {
      if (current.hasComment) {
        const comment: MermaidArchitectureComment = {
          anchorKind: "diagram",
          id: `comment-${comments.length + pendingComments.length + 1}`,
          line: architectureCommentLine(current.annotation),
          position: "before",
        };
        pendingComments.push(comment);
        records.push({
          fingerprint: comment.line,
          id: comment.id,
          kind: "comment",
          ...recordRange(sourceLineIndex, sourceLineIndex + 1),
        });
      }
      index += 1;
      continue;
    }

    const groupMatch = GROUP_RE.exec(syntax) ?? LOOSE_GROUP_RE.exec(syntax);
    if (groupMatch) {
      const [, id, iconToken = "", titleToken = "", parentId = ""] = groupMatch;
      const label = titleToken ? decodeArchitectureTitle(titleToken) : "";
      if (label === null) {
        return invalidConstruct(construct, lineNumber);
      }
      const value: MermaidArchitectureGroup = {
        hasIcon: Boolean(iconToken),
        hasLabel: Boolean(titleToken),
        icon: iconToken ? iconToken.slice(1, -1) : "",
        id,
        label,
        order: groups.length,
        parentId,
      };
      groups.push(value);
      located.push({ construct, kind: "group", line: lineNumber, value });
      addStatementRecord("group", value, current, sourceLineIndex);
      index += 1;
      continue;
    }

    const serviceMatch =
      SERVICE_RE.exec(syntax) ?? LOOSE_SERVICE_RE.exec(syntax);
    if (serviceMatch) {
      const [, id, iconToken = "", titleToken = "", groupId = ""] =
        serviceMatch;
      const iconKind = !iconToken
        ? "none"
        : iconToken.startsWith("(")
          ? "icon"
          : "text";
      const icon = !iconToken
        ? ""
        : iconKind === "icon"
          ? iconToken.slice(1, -1)
          : decodeArchitectureString(iconToken);
      const label = titleToken ? decodeArchitectureTitle(titleToken) : "";
      if (icon === null || label === null) {
        return invalidConstruct(construct, lineNumber);
      }
      const value: MermaidArchitectureService = {
        groupId,
        hasIcon: Boolean(iconToken),
        hasLabel: Boolean(titleToken),
        icon,
        iconKind,
        id,
        label,
        order: services.length,
      };
      services.push(value);
      located.push({ construct, kind: "service", line: lineNumber, value });
      addStatementRecord("service", value, current, sourceLineIndex);
      index += 1;
      continue;
    }

    const junctionMatch =
      JUNCTION_RE.exec(syntax) ?? LOOSE_JUNCTION_RE.exec(syntax);
    if (junctionMatch) {
      const [, id, groupId = ""] = junctionMatch;
      const value: MermaidArchitectureJunction = {
        groupId,
        id,
        order: junctions.length,
      };
      junctions.push(value);
      located.push({ construct, kind: "junction", line: lineNumber, value });
      addStatementRecord("junction", value, current, sourceLineIndex);
      index += 1;
      continue;
    }

    const alignmentMatch = ALIGN_RE.exec(syntax) ?? LOOSE_ALIGN_RE.exec(syntax);
    if (alignmentMatch) {
      const [, direction, memberList] = alignmentMatch;
      const members = memberList.trim().split(/\s+/);
      const semanticKey = `${direction}\n${members.join("\n")}`;
      const occurrence = (alignmentOccurrences.get(semanticKey) ?? 0) + 1;
      alignmentOccurrences.set(semanticKey, occurrence);
      const value: MermaidArchitectureAlignment = {
        direction: direction as MermaidArchitectureAlignment["direction"],
        id: architectureStableStatementId("alignment", semanticKey, occurrence),
        members,
        order: alignments.length,
      };
      alignments.push(value);
      located.push({ construct, kind: "alignment", line: lineNumber, value });
      addStatementRecord("alignment", value, current, sourceLineIndex);
      index += 1;
      continue;
    }

    const edgeMatch = EDGE_RE.exec(syntax) ?? LOOSE_EDGE_RE.exec(syntax);
    if (edgeMatch) {
      const [
        ,
        from,
        fromGroupToken,
        fromPort,
        fromArrowToken,
        labelToken,
        toArrowToken,
        toPort,
        to,
        toGroupToken,
      ] = edgeMatch;
      const label = labelToken ? decodeArchitectureTitle(labelToken) : "";
      if (label === null) return invalidConstruct(construct, lineNumber);
      const semanticKey = `${from}\n${to}`;
      const occurrence = (edgeOccurrences.get(semanticKey) ?? 0) + 1;
      edgeOccurrences.set(semanticKey, occurrence);
      const value: MermaidArchitectureEdge = {
        from,
        fromArrow: Boolean(fromArrowToken),
        fromGroup: Boolean(fromGroupToken),
        fromPort,
        id: architectureStableStatementId("edge", semanticKey, occurrence),
        label,
        order: edges.length,
        to,
        toArrow: Boolean(toArrowToken),
        toGroup: Boolean(toGroupToken),
        toPort,
      };
      edges.push(value);
      located.push({ construct, kind: "edge", line: lineNumber, value });
      addStatementRecord("edge", value, current, sourceLineIndex);
      index += 1;
      continue;
    }

    return invalidConstruct(originalLine.trim(), lineNumber);
  }
  anchorPendingComments("diagram", "end");
  return {
    value: {
      alignments,
      comments,
      edges,
      groups,
      junctions,
      located,
      records,
      services,
    },
  };

  function addStatementRecord(
    statementKind: MermaidArchitectureStatementKind,
    value:
      | MermaidArchitectureAlignment
      | MermaidArchitectureEdge
      | MermaidArchitectureGroup
      | MermaidArchitectureJunction
      | MermaidArchitectureService,
    current: ReturnType<typeof splitArchitectureComment>,
    sourceLineIndex: number,
  ) {
    anchorPendingComments(statementKind, value.id);
    const commentId = current.hasComment
      ? addComment(current.annotation, statementKind, "after", value.id).id
      : undefined;
    records.push({
      commentId,
      commentSuffix: current.hasComment
        ? architectureCommentLine(current.annotation)
        : "",
      fingerprint: architectureSemanticFingerprint(value),
      id: value.id,
      kind: "statement",
      ...recordRange(sourceLineIndex, sourceLineIndex + 1),
      statementKind,
    });
  }
}

function invalidConstruct(
  construct: string,
  line: number,
): { diagnostic: MermaidArchitectureSourceDiagnostic; value?: never } {
  return {
    diagnostic: {
      construct,
      line,
      message: `Invalid Architecture construct on line ${line}: ${construct}`,
    },
  };
}
