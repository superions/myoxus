// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  C4FieldValue,
  C4ResolvedGroup,
  MermaidC4Model,
} from "../model.js";

export type C4MoveImpact = Readonly<{
  kind: "field" | "order";
  selectionId: string;
  field: string;
  before?: C4FieldValue;
  after?: C4FieldValue;
  previousProvider?: string;
  nextProvider?: string;
  providers?: Readonly<{
    before?: { call: string; line: number };
    after?: { call: string; line: number };
  }>;
}>;
function groups(model: MermaidC4Model): C4ResolvedGroup[] {
  const objects = [
    ...model.elements,
    ...model.boundaries,
    ...model.relationships,
  ].flatMap((value) => (value.resolution ? [value.resolution] : []));
  const layout: C4ResolvedGroup = {
    selectionId: "c4-layout",
    declarationKey: "",
    sourceKeys: [],
    fields: {
      c4ShapeInRow: model.layoutShapeInRow,
      c4BoundaryInRow: model.layoutBoundaryInRow,
    },
    providers: Object.create(null),
  };
  for (const field of Object.keys(layout.fields)) {
    const provider = model.occurrences.findLast(
      (r) =>
        r.selectionId === layout.selectionId &&
        r.effectiveFields.includes(field),
    );
    if (provider)
      layout.providers[field] = {
        sourceKey: provider.sourceKey,
        form: "value",
      };
  }
  return [...objects, layout];
}
export function c4ModelImpact(
  before: MermaidC4Model,
  after: MermaidC4Model,
): C4MoveImpact[] {
  const old = new Map(groups(before).map((g) => [g.selectionId, g]));
  const next = new Map(groups(after).map((g) => [g.selectionId, g]));
  const impact: C4MoveImpact[] = [
    ...new Set([...old.keys(), ...next.keys()]),
  ].flatMap((selectionId) => {
    const previous = old.get(selectionId),
      g = next.get(selectionId);
    return [
      ...new Set([
        ...Object.keys(previous?.fields ?? {}),
        ...Object.keys(g?.fields ?? {}),
      ]),
    ].flatMap((field) => {
      const a = previous?.fields[field],
        b = g?.fields[field];
      const previousProvider = previous?.providers[field]?.sourceKey,
        nextProvider = g?.providers[field]?.sourceKey;
      const previousRecord = before.sourceDocument.records.find(
        (r) => r.sourceKey === previousProvider,
      );
      const nextRecord = after.sourceDocument.records.find(
        (r) => r.sourceKey === nextProvider,
      );
      return (Object.is(a, b) ||
        (a &&
          b &&
          typeof a === "object" &&
          typeof b === "object" &&
          a.text === b.text)) &&
        previousProvider === nextProvider
        ? []
        : [
            {
              kind: "field" as const,
              selectionId,
              field,
              before: a,
              after: b,
              previousProvider,
              nextProvider,
              providers: {
                before: previousRecord?.callKind
                  ? {
                      call: previousRecord.callKind,
                      line: previousRecord.range.line,
                    }
                  : undefined,
                after: nextRecord?.callKind
                  ? { call: nextRecord.callKind, line: nextRecord.range.line }
                  : undefined,
              },
            },
          ];
    });
  });
  for (const [a, b] of [
    [before.elements, after.elements],
    [before.boundaries, after.boundaries],
    [before.relationships, after.relationships],
  ] as const) {
    for (const value of b) {
      const previous = a.find(
        (p) => p.resolution?.selectionId === value.resolution?.selectionId,
      );
      if (previous && previous.order !== value.order)
        impact.push({
          kind: "order",
          selectionId: value.resolution!.selectionId,
          field: "order",
          before: previous.order,
          after: value.order,
        });
    }
  }
  return impact;
}
