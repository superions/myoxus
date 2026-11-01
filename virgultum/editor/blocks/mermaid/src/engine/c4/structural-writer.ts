// SPDX-License-Identifier: AGPL-3.0-or-later

import { c4RecordUnit } from "./source-unit.js";
import type { MermaidC4Model, C4ResolvedGroup } from "./model.js";
import { c4CallSource } from "./runtime-contract.js";
import {
  elementArguments,
  boundaryArguments,
  relationshipArguments,
} from "./call-arguments.js";
import { insertC4Record } from "./record-writer.js";
import {
  prepareC4RecordMove,
  confirmC4RecordMove,
} from "./commands/boundary-commands.js";
import type { writeC4Patches } from "./patches.js";

type C4Object = { id: string; resolution?: C4ResolvedGroup };
export function matchC4Object<T extends C4Object>(
  objects: readonly T[],
  value: C4Object,
): T | undefined {
  return value.resolution
    ? objects.find(
        (o) => o.resolution?.selectionId === value.resolution!.selectionId,
      )
    : objects.find((o) => o.id === value.id);
}

/** The retained writer uses the same lexical inserts/moves as semantic commands.
 * It never rebuilds a populated document or infers Source membership from bounds. */
export function finishC4StructuralWrites(
  before: MermaidC4Model,
  desired: MermaidC4Model,
  initial: ReturnType<typeof writeC4Patches>,
) {
  let result = initial;
  const created = new Map<string, string>();
  const parentKey = (alias: string) => {
    if (!alias) return null;
    const boundary = result.model.boundaries.find((b) => b.alias === alias);
    if (!boundary) throw new Error("C4 Source parent does not exist");
    return boundary.resolution!.declarationKey;
  };
  const depth = (alias: string, path = new Set<string>()): number => {
    if (!alias) return 0;
    if (path.has(alias))
      throw new Error("Cyclic Mermaid C4 boundary hierarchy");
    const boundary = desired.boundaries.find((b) => b.alias === alias);
    if (!boundary)
      throw new Error("Disconnected Mermaid C4 boundary hierarchy");
    return 1 + depth(boundary.parentId, new Set([...path, alias]));
  };
  const indent = (parent: string | null) =>
    parent
      ? result.model.sourceDocument.records.find((r) => r.sourceKey === parent)!
          .indent + "  "
      : "  ";
  for (const value of [...desired.boundaries].sort(
    (a, b) => depth(a.alias) - depth(b.alias) || a.order - b.order,
  )) {
    if (matchC4Object(before.boundaries, value)) continue;
    const parent = parentKey(value.parentId),
      padding = indent(parent),
      newline = result.model.sourceDocument.newline;
    result = insertC4Record(
      result.model,
      { parentKey: parent },
      `${padding}${c4CallSource(value.kind, boundaryArguments(value))} {${newline}${padding}}`,
    );
    created.set(
      value.id,
      result.model.boundaries.find((b) => b.alias === value.alias)!.resolution!
        .selectionId,
    );
  }
  for (const value of [...desired.elements].sort((a, b) => a.order - b.order)) {
    if (matchC4Object(before.elements, value)) continue;
    const parent = parentKey(value.boundaryId);
    result = insertC4Record(
      result.model,
      { parentKey: parent },
      indent(parent) + c4CallSource(value.kind, elementArguments(value)),
    );
    created.set(
      value.id,
      result.model.elements.find((e) => e.alias === value.alias)!.resolution!
        .selectionId,
    );
  }
  for (const value of [...desired.relationships].sort(
    (a, b) => a.order - b.order,
  )) {
    if (matchC4Object(before.relationships, value)) continue;
    result = insertC4Record(
      result.model,
      { parentKey: null },
      "  " + c4CallSource(value.kind, relationshipArguments(value)),
    );
    created.set(
      value.id,
      result.model.relationships.find(
        (r) => r.from === value.from && r.to === value.to,
      )!.resolution!.selectionId,
    );
  }
  for (const statement of desired.updateStatements)
    if (!statement.sourceKey)
      result = insertC4Record(
        result.model,
        { parentKey: null },
        "  " + c4CallSource(statement.kind, statement.callArguments),
      );

  const move = (key: string, parent: string | null, beforeKey?: string) => {
    const draft = prepareC4RecordMove(result.model, key, {
      parentKey: parent,
      beforeKey,
    });
    if (!draft) throw new Error("C4 Source move cannot be applied");
    const moved = confirmC4RecordMove(result.model, draft, true);
    if (moved.status === "invalid" || moved.status === "stale")
      throw new Error("C4 Source move cannot be applied");
    result = {
      source: moved.source,
      model: moved.model,
      bindings: { previous: moved.model.sourceDocument },
    };
  };
  for (const value of [...desired.boundaries].sort(
    (a, b) => depth(a.alias) - depth(b.alias),
  )) {
    const old = matchC4Object(before.boundaries, value);
    if (old && old.parentId !== value.parentId)
      move(
        matchC4Object(result.model.boundaries, value)!.resolution!
          .declarationKey,
        parentKey(value.parentId),
      );
  }
  for (const value of desired.elements) {
    const old = matchC4Object(before.elements, value);
    if (old && old.boundaryId !== value.boundaryId)
      move(
        matchC4Object(result.model.elements, value)!.resolution!.declarationKey,
        parentKey(value.boundaryId),
      );
  }
  // Only an explicit order delta moves records. A field edit never globally repacks Source.
  const reorder = <T extends C4Object & { order: number }>(
    old: readonly T[],
    wanted: readonly T[],
    current: () => readonly T[],
    parent: (value: T) => string,
  ) => {
    if (
      !wanted.some((v) => {
        const previous = matchC4Object(old, v);
        return previous && previous.order !== v.order;
      })
    )
      return;
    const scopes = new Map<string, T[]>();
    for (const value of wanted) {
      const scope = parent(value);
      scopes.set(scope, [...(scopes.get(scope) ?? []), value]);
    }
    for (const values of scopes.values()) {
      let next: string | undefined;
      for (const value of [...values].sort((a, b) => b.order - a.order)) {
        const object =
          current().find(
            (v) => v.resolution?.selectionId === created.get(value.id),
          ) ?? matchC4Object(current(), value);
        if (!object?.resolution)
          throw new Error("C4 order binding was lost before writing");
        // Native insertion order belongs to the first declaration, not the last provider.
        const key = object.resolution!.sourceKeys[0];
        if (next) {
          const records = result.model.sourceDocument.records;
          const record = records.find((r) => r.sourceKey === key)!;
          const physicalParent = record.scopeKeys.at(-1) ?? null;
          let anchor = records.find((r) => r.sourceKey === next)!;
          while ((anchor.scopeKeys.at(-1) ?? null) !== physicalParent) {
            const parent = anchor.scopeKeys.at(-1);
            if (!parent)
              throw new Error("C4 order requires an explicit cross-scope move");
            anchor = records.find((r) => r.sourceKey === parent)!;
          }
          const position =
            c4RecordUnit(result.model, anchor)?.[0]?.range.start ??
            anchor.range.start;
          if (record.range.start > position)
            move(key, physicalParent, anchor.sourceKey);
        }
        next = key;
      }
    }
  };
  reorder(
    before.boundaries,
    desired.boundaries,
    () => result.model.boundaries,
    (v) => v.parentId,
  );
  reorder(
    before.elements,
    desired.elements,
    () => result.model.elements,
    (v) => v.boundaryId,
  );
  reorder(
    before.relationships,
    desired.relationships,
    () => result.model.relationships,
    () => "",
  );
  return result;
}
