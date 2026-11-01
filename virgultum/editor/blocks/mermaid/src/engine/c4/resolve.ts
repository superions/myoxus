// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  C4CallOccurrence,
  C4FieldValue,
  C4ResolvedGroup,
} from "./model.js";
import { type C4SourceDocument } from "./source-document.js";
import { bindC4Resolutions, c4IdentityGroups } from "./resolution-bindings.js";
import { c4Diagnostic } from "./diagnostics.js";
import {
  C4_CALLS,
  c4LayoutRowValue,
  c4RequiredArgumentIssues,
  resolveC4RenderShape,
} from "./runtime-contract.js";

export function emptyC4Resolution(selectionId: string): C4ResolvedGroup {
  return {
    selectionId,
    sourceKeys: [],
    declarationKey: "",
    fields: Object.create(null),
    providers: Object.create(null),
  };
}
export function c4ResolvedText(group: C4ResolvedGroup, field: string) {
  const value = group.fields[field];
  return typeof value === "object"
    ? value.text
    : typeof value === "string"
      ? value
      : "";
}

/** Replay the pinned DB handlers in source order. Text slots reset on omission;
 * metadata slots and style slots retain previous values until explicitly assigned.
 * A provider belongs to a field, never to an entire repeated declaration. */
export function resolveC4Document(document: C4SourceDocument) {
  const elementGroups: C4ResolvedGroup[] = [];
  const boundaryGroups: C4ResolvedGroup[] = [];
  const relationshipGroups: C4ResolvedGroup[] = [];
  const targets = new Map<string, C4ResolvedGroup>();
  const occurrences: C4CallOccurrence[] = [];
  const root = emptyC4Resolution("c4-root");
  root.fields.alias = "global";
  const records = document.records.filter(
    (r) =>
      r.callKind &&
      r.arguments &&
      r.complete &&
      !c4RequiredArgumentIssues(r.callKind, r.arguments).length,
  );
  const group = (
    groups: C4ResolvedGroup[],
    record: C4SourceDocument["records"][number],
    matches: (value: C4ResolvedGroup) => boolean,
  ) => {
    let result = groups.find(matches);
    const created = !result;
    if (!result) {
      result = emptyC4Resolution("");
      groups.push(result);
    }
    result.sourceKeys.push(record.sourceKey);
    result.declarationKey = record.sourceKey;
    return { resolution: result, created };
  };
  let layoutShapeInRow = 4,
    layoutBoundaryInRow = 2;
  const layout = emptyC4Resolution("c4-layout");
  for (const [order, record] of records.entries()) {
    const args = record.arguments!,
      kind = record.callKind!,
      contract = C4_CALLS[kind];
    const occurrence: C4CallOccurrence = {
      sourceKey: record.sourceKey,
      kind,
      category: contract.category,
      callArguments: args,
      scopeKeys: record.scopeKeys,
      scopeAliases: record.scopeAliases,
      order,
      applied: false,
      providedFields: [],
      effectiveFields: [],
      shadowedFields: [],
    };
    occurrences.push(occurrence);
    let target: C4ResolvedGroup | undefined;
    const put = (
      field: string,
      value: C4FieldValue,
      argumentIndex?: number,
      form: "value" | "empty" | "omitted" | "injected" = "injected",
    ) => {
      if (!target) return;
      target.fields[field] = value;
      target.providers[field] = {
        sourceKey: record.sourceKey,
        argumentIndex,
        form,
      };
      occurrence.providedFields.push(field);
    };
    const slot = (
      index: number,
      field: string,
      text: boolean,
      defaultValue = "",
      numeric = false,
    ) => {
      const arg = args[index];
      if (!arg && !text) return;
      const key = arg && (arg.named || arg.key) ? arg.key : field;
      const value = arg?.value ?? defaultValue;
      put(
        key,
        numeric ? Number.parseInt(value) : text ? { text: value } : value,
        index,
        !arg ? "omitted" : !arg.value ? "empty" : "value",
      );
    };
    if (contract.category === "element" || contract.category === "boundary") {
      const identity = args[0].value;
      if (contract.category === "boundary" && identity === "global")
        document.diagnostics.push(
          c4Diagnostic(
            record,
            "c4.boundary.alias-collision",
            "The global alias belongs to the internal native root; choose a distinct boundary alias.",
            { category: "identity", correction: "alias", argumentIndex: 0 },
          ),
        );
      const selected = group(
        contract.category === "element" ? elementGroups : boundaryGroups,
        record,
        (value) => value.fields.alias === identity,
      );
      target = selected.resolution;
      if (selected.created) put("alias", identity, 0, "value");
      put(
        "label",
        { text: args[1].value },
        1,
        args[1].value ? "value" : "empty",
      );
      if (contract.injectedType) put("type", { text: contract.injectedType });
      for (let index = 2; index < contract.slots.length; index++) {
        if (contract.ignoredSlots?.includes(index)) continue;
        const field = contract.slots[index];
        slot(
          index,
          field,
          ["type", "techn", "descr"].includes(field),
          field === "type" ? (contract.nativeType ? "node" : "system") : "",
        );
      }
      // Native shape/node and parent fields override declaration metadata.
      if (contract.category === "element")
        put("typeC4Shape", { text: contract.nativeType! });
      else if (contract.nativeType) put("nodeType", contract.nativeType);
      put("parentBoundary", record.scopeAliases.at(-1) ?? "global");
      delete target.fields.wrap;
      delete target.providers.wrap;
    } else if (contract.category === "relationship") {
      const offset = kind === "RelIndex" ? 1 : 0;
      target = group(
        relationshipGroups,
        record,
        (value) =>
          value.fields.from === args[offset].value &&
          value.fields.to === args[offset + 1].value,
      ).resolution;
      put("from", args[offset].value, offset, "value");
      put("to", args[offset + 1].value, offset + 1, "value");
      put("label", { text: args[offset + 2].value }, offset + 2, "value");
      put("type", contract.nativeType!);
      for (let index = offset + 3; index < contract.slots.length; index++) {
        const field = contract.slots[index];
        slot(index, field, field === "techn" || field === "descr");
      }
      delete target.fields.wrap;
      delete target.providers.wrap;
    } else if (kind === "UpdateElementStyle") {
      target =
        elementGroups.find((value) => value.fields.alias === args[0].value) ??
        boundaryGroups.find((value) => value.fields.alias === args[0].value) ??
        (root.fields.alias === args[0].value ? root : undefined);
      if (target)
        for (let index = 1; index < contract.slots.length; index++)
          slot(index, contract.slots[index], false);
    } else if (kind === "UpdateRelStyle") {
      target = relationshipGroups.find(
        (value) =>
          value.fields.from === args[0].value &&
          value.fields.to === args[1].value,
      );
      if (target)
        for (let index = 2; index < contract.slots.length; index++)
          slot(index, contract.slots[index], false, "", index >= 4);
    } else {
      target = layout;
      const shape = c4LayoutRowValue(args, 0),
        boundary = c4LayoutRowValue(args, 1);
      if (shape !== undefined) {
        layoutShapeInRow = shape;
        put("c4ShapeInRow", shape, 0, "value");
      }
      if (boundary !== undefined) {
        layoutBoundaryInRow = boundary;
        put("c4BoundaryInRow", boundary, 1, "value");
      }
    }
    if (target) {
      occurrence.applied = true;
      targets.set(record.sourceKey, target);
    }
  }
  if (root.fields.alias !== "global" || root.fields.parentBoundary) {
    const provider =
      root.fields.alias !== "global"
        ? root.providers.alias
        : root.providers.parentBoundary;
    const record = document.records.find(
      (r) => r.sourceKey === provider.sourceKey,
    )!;
    document.diagnostics.push(
      c4Diagnostic(
        record,
        "c4.root.identity-mutation",
        "This update changes the internal native root identity or parent; correct that named attribute before projecting the diagram.",
        {
          category: "identity",
          correction: "alias",
          argumentIndex: provider.argumentIndex,
        },
      ),
    );
  }
  const identities = [
    ...c4IdentityGroups(document, elementGroups, "element"),
    ...c4IdentityGroups(document, boundaryGroups, "boundary"),
    ...c4IdentityGroups(document, relationshipGroups, "relationship"),
  ];
  bindC4Resolutions(document, identities);
  for (const occurrence of occurrences) {
    const resolved = targets.get(occurrence.sourceKey);
    occurrence.selectionId = resolved?.selectionId;
    occurrence.providedFields = [...new Set(occurrence.providedFields)];
    occurrence.effectiveFields = occurrence.providedFields.filter(
      (field) => resolved?.providers[field]?.sourceKey === occurrence.sourceKey,
    );
    occurrence.shadowedFields = occurrence.providedFields.filter(
      (field) => !occurrence.effectiveFields.includes(field),
    );
  }
  const elements = new Map(
    identities
      .filter((i) => i.category === "element")
      .map((i) => [i.identity, i.group]),
  );
  const boundaries = new Map(
    identities
      .filter((i) => i.category === "boundary")
      .map((i) => [i.identity, i.group]),
  );
  const relationships = new Map(
    identities
      .filter((i) => i.category === "relationship")
      .map((i) => [i.identity, i.group]),
  );
  return {
    elements,
    boundaries,
    relationships,
    occurrences,
    layoutShapeInRow,
    layoutBoundaryInRow,
    layout,
  };
}

export function c4ResolvedElementShape(element: {
  kind: string;
  sprite: string;
  tags: string;
  resolution?: C4ResolvedGroup;
}) {
  const shape = element.resolution?.fields.shape;
  return resolveC4RenderShape({
    ...element,
    shape: typeof shape === "string" ? shape : undefined,
  });
}
