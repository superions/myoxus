// SPDX-License-Identifier: AGPL-3.0-or-later

import { c4Diagnostic } from "./diagnostics.js";
import type { C4ResolvedGroup, C4SelectionBinding } from "./model.js";
import { nextC4SourceKey, type C4SourceDocument } from "./source-document.js";

export type C4IdentityGroup = {
  category: C4SelectionBinding["category"];
  identity: string;
  group: C4ResolvedGroup;
};

/** Reconcile final native groups, after all alias/endpoint mutations have replayed.
 * Reserve continuing identities before assigning IDs to renamed or split groups. */
export function bindC4Resolutions(
  document: C4SourceDocument,
  groups: readonly C4IdentityGroup[],
) {
  const assigned = new Map<C4ResolvedGroup, string>(),
    reserved = new Set<string>();
  for (const binding of document.selectionBindings ?? []) {
    const next = groups.find(
      (g) =>
        !assigned.has(g.group) &&
        g.category === binding.category &&
        g.identity === binding.identity &&
        g.group.sourceKeys.some((k) => binding.sourceKeys.includes(k)),
    );
    if (next && !reserved.has(binding.selectionId)) {
      assigned.set(next.group, binding.selectionId);
      reserved.add(binding.selectionId);
    }
  }
  for (const binding of document.selectionBindings ?? []) {
    if (reserved.has(binding.selectionId)) continue;
    const candidates = groups.filter(
      (g) =>
        !assigned.has(g.group) &&
        g.category === binding.category &&
        g.group.sourceKeys.some((k) => binding.sourceKeys.includes(k)),
    );
    if (candidates.length === 1) {
      assigned.set(candidates[0].group, binding.selectionId);
      reserved.add(binding.selectionId);
    }
  }
  for (const { category, group } of groups) {
    const fresh = `c4-${category}-${group.sourceKeys[0].replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
    group.selectionId =
      assigned.get(group) ??
      (reserved.has(fresh) ? `c4-${category}-${nextC4SourceKey()}` : fresh);
    reserved.add(group.selectionId);
  }
  document.selectionBindings = groups.map(({ category, identity, group }) => ({
    category,
    identity,
    selectionId: group.selectionId,
    sourceKeys: group.sourceKeys,
  }));
}

/** Native handlers look up the object's current identity, which named attributes can change.
 * Invalid value forms or colliding live identities retain Source records for local repair. */
export function c4IdentityGroups(
  document: C4SourceDocument,
  groups: readonly C4ResolvedGroup[],
  category: C4SelectionBinding["category"],
): C4IdentityGroup[] {
  const seen = new Set<string>();
  return groups.map((group) => {
    const fields = category === "relationship" ? ["from", "to"] : ["alias"];
    const values = fields.map((field) => group.fields[field]);
    const identity =
      category === "relationship"
        ? JSON.stringify(values)
        : typeof values[0] === "string"
          ? values[0]
          : "";
    for (const [index, field] of fields.entries()) {
      if (typeof values[index] === "string" && values[index] !== "") continue;
      const provider = group.providers[field],
        record = document.records.find(
          (r) => r.sourceKey === (provider?.sourceKey ?? group.declarationKey),
        )!;
      document.diagnostics.push(
        c4Diagnostic(
          record,
          `c4.${category}.identity-value`,
          "The native identity field must remain a non-empty string; correct the named argument that changed it.",
          {
            category: "identity",
            correction: category === "relationship" ? "endpoints" : "alias",
            argumentIndex: provider?.argumentIndex,
            range:
              record.argumentBindings?.[provider?.argumentIndex ?? 0]?.range ??
              record.range,
          },
        ),
      );
    }
    if (seen.has(identity)) {
      const provider = group.providers[fields[0]],
        record = document.records.find(
          (r) => r.sourceKey === (provider?.sourceKey ?? group.declarationKey),
        )!;
      document.diagnostics.push(
        c4Diagnostic(
          record,
          `c4.${category}.identity-collision`,
          "A named argument made separate native objects share the same identity; choose a distinct alias or endpoint pair.",
          {
            category: "identity",
            correction: category === "relationship" ? "endpoints" : "alias",
            argumentIndex: provider?.argumentIndex,
          },
        ),
      );
    }
    seen.add(identity);
    return { category, identity, group };
  });
}
