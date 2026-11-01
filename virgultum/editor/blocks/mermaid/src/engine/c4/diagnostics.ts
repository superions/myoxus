// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "./model.js";
import {
  C4_CALLS,
  c4RelationshipLabelOffset,
  c4RequiredArgumentIssues,
} from "./runtime-contract.js";
import type {
  C4Range,
  C4SourceDocument,
  C4SourceRecord,
} from "./source-document.js";

export type C4DiagnosticCategory =
  "syntax" | "handler" | "identity" | "reference" | "native-render";
export type C4SourceDiagnostic = {
  code: string;
  message: string;
  category: C4DiagnosticCategory;
  severity: "error" | "warning" | "info";
  range: C4Range;
  sourceKey?: string;
  argumentIndex?: number;
  correction?:
    | "positional-required-value"
    | "header"
    | "boundary-open"
    | "boundary-close"
    | "title-value"
    | "alias"
    | "endpoints"
    | "native-adapter"
    | "argument-value";
  blocksNativeRendering?: boolean;
};
export function c4Diagnostic(
  record: C4SourceRecord,
  code: string,
  message: string,
  details: Partial<
    Omit<C4SourceDiagnostic, "code" | "message" | "sourceKey">
  > = {},
): C4SourceDiagnostic {
  return {
    category: "syntax",
    severity: "error",
    range: record.range,
    sourceKey: record.sourceKey,
    code,
    message,
    ...details,
  };
}
export function diagnoseC4Calls(document: C4SourceDocument) {
  for (const record of document.records) {
    if (!record.callKind || !record.arguments || !record.complete) continue;
    for (const issue of c4RequiredArgumentIssues(
      record.callKind,
      record.arguments,
    ))
      document.diagnostics.push(
        c4Diagnostic(
          record,
          `c4.required-argument.${issue.kind}`,
          `${record.callKind} argument ${issue.index + 1} (${issue.field}) requires a positional DB string.`,
          {
            category: "handler",
            range:
              record.argumentBindings?.[issue.index]?.range ?? record.range,
            argumentIndex: issue.index,
            correction: "positional-required-value",
          },
        ),
      );
  }
}
/** Grammar-valid records remain typed when a native render cannot consume their references. */
export function diagnoseC4Model(
  document: C4SourceDocument,
  model: MermaidC4Model,
) {
  const declaration = (key: string) =>
    document.records.find((r) => r.sourceKey === key)!;
  const elements = new Set(model.elements.map((e) => e.alias));
  for (const boundary of model.boundaries)
    if (boundary.alias === "global" || elements.has(boundary.alias))
      document.diagnostics.push(
        c4Diagnostic(
          declaration(boundary.resolution!.declarationKey),
          "c4.boundary.alias-collision",
          "This boundary alias is reserved or also used by an element; assign a unique alias.",
          { category: "identity", correction: "alias" },
        ),
      );
  for (const element of model.elements)
    if (element.alias === "global")
      document.diagnostics.push(
        c4Diagnostic(
          declaration(element.resolution!.declarationKey),
          "c4.element.alias-collision",
          "The global alias is reserved for the native root boundary.",
          { category: "identity", correction: "alias" },
        ),
      );
  const parents = new Map(model.boundaries.map((b) => [b.alias, b.parentId]));
  for (const value of [...model.elements, ...model.boundaries]) {
    const parent = "boundaryId" in value ? value.boundaryId : value.parentId;
    if (
      typeof value.resolution!.fields.parentBoundary !== "string" ||
      (parent && !parents.has(parent))
    ) {
      const provider = value.resolution!.providers.parentBoundary;
      const record = declaration(provider.sourceKey);
      document.diagnostics.push(
        c4Diagnostic(
          record,
          "c4.parent.missing",
          "The native parent alias has no live boundary; correct its alias or the update that changed the parent.",
          {
            category: "reference",
            correction: "boundary-open",
            argumentIndex: provider.argumentIndex,
            range:
              provider.argumentIndex !== undefined
                ? (record.argumentBindings?.[provider.argumentIndex]?.range ??
                  record.range)
                : record.range,
          },
        ),
      );
    }
  }
  for (const boundary of model.boundaries) {
    const visited = new Set([boundary.alias]);
    let parent = boundary.parentId;
    while (parent) {
      if (visited.has(parent)) {
        document.diagnostics.push(
          c4Diagnostic(
            declaration(
              boundary.resolution!.providers.parentBoundary.sourceKey,
            ),
            "c4.boundary.parent-cycle",
            "The effective boundary parents form a cycle; choose a parent outside this subtree.",
            { category: "identity", correction: "alias" },
          ),
        );
        break;
      }
      visited.add(parent);
      parent = parents.get(parent) ?? "";
    }
  }
  for (const relation of model.relationships)
    if (!elements.has(relation.from) || !elements.has(relation.to)) {
      const record = declaration(relation.resolution!.declarationKey);
      document.diagnostics.push(
        c4Diagnostic(
          record,
          "c4.relationship.endpoint-missing",
          "Declare or correct both element aliases before rendering this relation.",
          {
            category: "reference",
            correction: "endpoints",
            blocksNativeRendering: true,
          },
        ),
      );
    }
  for (const relation of model.relationships) {
    for (const field of ["offsetX", "offsetY"] as const) {
      if (
        Number.isFinite(
          c4RelationshipLabelOffset(relation.resolution!.fields[field]),
        )
      )
        continue;
      const provider = relation.resolution!.providers[field],
        record = declaration(provider.sourceKey);
      document.diagnostics.push(
        c4Diagnostic(
          record,
          "c4.native.label-offset",
          `The native ${field} value cannot produce a finite integer label offset; edit its actual argument.`,
          {
            category: "native-render",
            severity: "error",
            blocksNativeRendering: true,
            correction: "argument-value",
            argumentIndex: provider.argumentIndex,
            range:
              record.argumentBindings?.[provider.argumentIndex ?? -1]?.value ??
              record.range,
          },
        ),
      );
    }
  }
  for (const object of [
    ...model.elements,
    ...model.boundaries,
    ...model.relationships,
  ]) {
    const resolution = object.resolution!,
      technology = resolution.fields.techn;
    const fields =
      "boundaryId" in object
        ? ["label", "typeC4Shape"]
        : "parentId" in object
          ? ["label", "type"]
          : ["label"];
    if (resolution.fields.descr !== undefined) fields.push("descr");
    for (const field of fields) {
      const value = resolution.fields[field];
      if (value && typeof value === "object" && typeof value.text === "string")
        continue;
      const provider = resolution.providers[field] ?? {
        sourceKey: resolution.declarationKey,
        argumentIndex:
          field === "type"
            ? C4_CALLS[object.kind].slots.indexOf("type")
            : field === "label"
              ? 1
              : undefined,
      };
      document.diagnostics.push(
        c4Diagnostic(
          declaration(provider.sourceKey),
          "c4.native.text-field",
          `The native C4 renderer requires ${field}.text; this assignment supplies a different value form.`,
          {
            category: "native-render",
            severity: "warning",
            argumentIndex: provider.argumentIndex,
            blocksNativeRendering: true,
          },
        ),
      );
    }
    if (typeof technology === "string") {
      const provider = resolution.providers.techn;
      document.diagnostics.push(
        c4Diagnostic(
          declaration(provider.sourceKey),
          "c4.native.technology-string",
          "The native C4 renderer cannot display this string Technology value without its text-object adapter.",
          {
            category: "native-render",
            severity: "warning",
            argumentIndex: provider.argumentIndex,
            correction: "native-adapter",
            blocksNativeRendering: true,
          },
        ),
      );
    }
  }
}
