// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model, C4ResolvedGroup } from "./model.js";
import type { C4SourceRecord } from "./source-document.js";
import { C4_CALLS } from "./runtime-contract.js";

/** Declaration ownership survives native identity mutations. Update targets belong
 * to the object found at that point in replay, not necessarily its final alias. */
export function c4AliasArguments(
  model: MermaidC4Model,
  record: C4SourceRecord,
  owner: { alias: string; resolution: C4ResolvedGroup },
  declarationKeys: ReadonlySet<string>,
  single = false,
) {
  const contract = C4_CALLS[record.callKind ?? ""];
  if (!contract) return [];
  const occurrence = model.occurrences.find(
    (o) => o.sourceKey === record.sourceKey,
  );
  const ownsDeclaration = declarationKeys.has(record.sourceKey);
  const ownsUpdate =
    !single &&
    record.callKind === "UpdateElementStyle" &&
    occurrence?.selectionId === owner.resolution.selectionId;
  return (record.arguments ?? []).flatMap((argument, index) => {
    if (
      contract.ignoredSlots?.includes(index) ||
      index >= contract.slots.length
    )
      return [];
    const field =
      argument.named || argument.key ? argument.key : contract.slots[index];
    const declaration = ownsDeclaration && (index === 0 || field === "alias");
    const update = ownsUpdate && (index === 0 || field === "alias");
    const reference =
      !single &&
      argument.value === owner.alias &&
      ((["from", "to"].includes(field) &&
        (contract.category === "relationship" ||
          record.callKind === "UpdateRelStyle")) ||
        (field === "elementName" &&
          index === 0 &&
          record.callKind === "UpdateElementStyle") ||
        (field === "parentBoundary" &&
          record.callKind === "UpdateElementStyle"));
    return declaration || update || reference ? [{ index, field }] : [];
  });
}

/** Reconnect changes the pair's declarations, applied style targets and endpoint
 * overrides together. Unapplied updates remain explicit Source records. */
export function c4PairArguments(
  model: MermaidC4Model,
  record: C4SourceRecord,
  selectionId: string,
): { index: number; field: "from" | "to" }[] {
  const contract = C4_CALLS[record.callKind ?? ""];
  if (
    !contract ||
    !model.occurrences.some(
      (o) => o.sourceKey === record.sourceKey && o.selectionId === selectionId,
    )
  )
    return [];
  return (record.arguments ?? []).flatMap((argument, index) => {
    if (index >= contract.slots.length) return [];
    const field =
      argument.named || argument.key ? argument.key : contract.slots[index];
    return field === "from" || field === "to" ? [{ index, field }] : [];
  });
}
