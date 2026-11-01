// SPDX-License-Identifier: AGPL-3.0-or-later

import { ARCHITECTURE_ID_VALUE_RE } from "../grammar.js";
import type { MermaidArchitectureSourceDiagnostic } from "../model.js";
import type {
  LocatedArchitectureStatement,
  ParsedArchitectureStatements,
} from "./statements.js";

const ARCHITECTURE_PORT_RE = /^[RLTB]$/;

export function validateArchitectureStatements(
  parsed: ParsedArchitectureStatements,
): MermaidArchitectureSourceDiagnostic | null {
  const locatedObjects = parsed.located.filter(
    (
      statement,
    ): statement is Extract<
      LocatedArchitectureStatement,
      { kind: "group" | "junction" | "service" }
    > =>
      statement.kind === "group" ||
      statement.kind === "junction" ||
      statement.kind === "service",
  );
  const firstById = new Map<string, (typeof locatedObjects)[number]>();
  for (const statement of locatedObjects) {
    const { id } = statement.value;
    if (!ARCHITECTURE_ID_VALUE_RE.test(id)) {
      return diagnostic(
        statement,
        `Architecture identifier ${id} is invalid on line ${statement.line}.`,
      );
    }
    if (firstById.has(id)) {
      return diagnostic(
        statement,
        `Duplicate Architecture identifier ${id} on line ${statement.line}.`,
      );
    }
    firstById.set(id, statement);
  }

  const locatedGroups = parsed.located.filter(
    (
      statement,
    ): statement is Extract<LocatedArchitectureStatement, { kind: "group" }> =>
      statement.kind === "group",
  );
  const groupById = new Map(
    locatedGroups.map((statement) => [statement.value.id, statement]),
  );
  for (const statement of locatedGroups) {
    const { id, parentId } = statement.value;
    if (!parentId) continue;
    if (!ARCHITECTURE_ID_VALUE_RE.test(parentId)) {
      return diagnostic(
        statement,
        `Architecture parent identifier ${parentId} is invalid on line ${statement.line}.`,
      );
    }
    const parent = groupById.get(parentId);
    if (!parent) {
      return diagnostic(
        statement,
        `Architecture group ${id} references missing parent ${parentId} on line ${statement.line}.`,
      );
    }
  }
  for (const statement of locatedGroups) {
    const visited = new Set([statement.value.id]);
    let parentId = statement.value.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        return diagnostic(
          statement,
          `Architecture group ${statement.value.id} has a cyclic parent relationship on line ${statement.line}.`,
        );
      }
      visited.add(parentId);
      parentId = groupById.get(parentId)?.value.parentId ?? "";
    }
  }
  for (const statement of locatedGroups) {
    const { id, parentId } = statement.value;
    if (!parentId) continue;
    const parent = groupById.get(parentId)!;
    if (parent.line >= statement.line) {
      return diagnostic(
        statement,
        `Architecture group ${id} references parent ${parentId} before that parent is declared on line ${statement.line}.`,
      );
    }
  }

  const locatedNodes = parsed.located.filter(
    (
      statement,
    ): statement is Extract<
      LocatedArchitectureStatement,
      { kind: "junction" | "service" }
    > => statement.kind === "junction" || statement.kind === "service",
  );
  const nodeById = new Map(
    locatedNodes.map((statement) => [statement.value.id, statement]),
  );
  for (const statement of locatedNodes) {
    const { groupId, id } = statement.value;
    if (!groupId) continue;
    if (!ARCHITECTURE_ID_VALUE_RE.test(groupId)) {
      return diagnostic(
        statement,
        `Architecture group identifier ${groupId} is invalid on line ${statement.line}.`,
      );
    }
    if (!groupById.has(groupId)) {
      return diagnostic(
        statement,
        `Architecture object ${id} references missing group ${groupId} on line ${statement.line}.`,
      );
    }
    if (groupById.get(groupId)!.line >= statement.line) {
      return diagnostic(
        statement,
        `Architecture object ${id} references group ${groupId} before that group is declared on line ${statement.line}.`,
      );
    }
  }

  const locatedEdges = parsed.located.filter(
    (
      statement,
    ): statement is Extract<LocatedArchitectureStatement, { kind: "edge" }> =>
      statement.kind === "edge",
  );
  for (const statement of locatedEdges) {
    const edge = statement.value;
    if (!ARCHITECTURE_ID_VALUE_RE.test(edge.from)) {
      return diagnostic(
        statement,
        `Architecture relationship source identifier ${edge.from} is invalid on line ${statement.line}.`,
      );
    }
    if (!ARCHITECTURE_ID_VALUE_RE.test(edge.to)) {
      return diagnostic(
        statement,
        `Architecture relationship target identifier ${edge.to} is invalid on line ${statement.line}.`,
      );
    }
    if (!ARCHITECTURE_PORT_RE.test(edge.fromPort)) {
      return diagnostic(
        statement,
        `Architecture relationship uses invalid source port ${edge.fromPort} on line ${statement.line}.`,
      );
    }
    if (!ARCHITECTURE_PORT_RE.test(edge.toPort)) {
      return diagnostic(
        statement,
        `Architecture relationship uses invalid target port ${edge.toPort} on line ${statement.line}.`,
      );
    }
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) {
      const missing = !from ? edge.from : edge.to;
      return diagnostic(
        statement,
        `Architecture relationship references missing endpoint ${missing} on line ${statement.line}.`,
      );
    }
    if (from.line >= statement.line || to.line >= statement.line) {
      const later = from.line >= statement.line ? edge.from : edge.to;
      return diagnostic(
        statement,
        `Architecture relationship references endpoint ${later} before that object is declared on line ${statement.line}.`,
      );
    }
    if (
      (edge.fromGroup || edge.toGroup) &&
      Boolean(from.value.groupId) &&
      from.value.groupId === to.value.groupId
    ) {
      return diagnostic(
        statement,
        `Architecture relationship cannot use {group} within group ${from.value.groupId} on line ${statement.line}.`,
      );
    }
  }

  const alignedByDirection = new Map<string, LocatedArchitectureStatement>();
  const locatedAlignments = parsed.located.filter(
    (
      statement,
    ): statement is Extract<
      LocatedArchitectureStatement,
      { kind: "alignment" }
    > => statement.kind === "alignment",
  );
  for (const statement of locatedAlignments) {
    const alignment = statement.value;
    if (alignment.members.length < 2) {
      return diagnostic(
        statement,
        `Architecture alignment requires at least two objects on line ${statement.line}.`,
      );
    }
    const seen = new Set<string>();
    for (const member of alignment.members) {
      if (!ARCHITECTURE_ID_VALUE_RE.test(member)) {
        return diagnostic(
          statement,
          `Architecture alignment identifier ${member} is invalid on line ${statement.line}.`,
        );
      }
      if (seen.has(member)) {
        return diagnostic(
          statement,
          `Architecture alignment repeats object ${member} on line ${statement.line}.`,
        );
      }
      seen.add(member);
      if (!nodeById.has(member)) {
        return diagnostic(
          statement,
          `Architecture alignment references missing object ${member} on line ${statement.line}.`,
        );
      }
      if (nodeById.get(member)!.line >= statement.line) {
        return diagnostic(
          statement,
          `Architecture alignment references object ${member} before that object is declared on line ${statement.line}.`,
        );
      }
      const key = `${alignment.direction}:${member}`;
      const previous = alignedByDirection.get(key);
      if (previous) {
        return diagnostic(
          statement,
          `Architecture object ${member} has conflicting ${alignment.direction} alignments on lines ${previous.line} and ${statement.line}.`,
        );
      }
      alignedByDirection.set(key, statement);
    }
  }
  return null;
}

function diagnostic(
  statement: LocatedArchitectureStatement,
  message: string,
): MermaidArchitectureSourceDiagnostic {
  return {
    construct: statement.construct,
    line: statement.line,
    message,
  };
}
