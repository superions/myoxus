// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../model.js";
import {
  prepareC4Delete,
  c4DeleteImpact,
  type C4DeleteTarget,
  type C4DeleteDraft,
} from "./delete-commands.js";
import { c4CommandResult, c4NoChange, type C4CommandResult } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export type C4BatchDeleteDraft = Readonly<{
  basis: string;
  targets: readonly C4DeleteTarget[];
}> &
  Pick<C4DeleteDraft, "removed" | "moved" | "impact" | "pairs" | "styles">;

/** Replay existing checked deletions in memory, then commit their complete Source
 * result once. A selected reference removed by an earlier cascade is already consumed. */
export function prepareC4BatchDelete(
  model: MermaidC4Model,
  targets: readonly C4DeleteTarget[],
): {
  draft?: C4BatchDeleteDraft;
  result?: C4CommandResult;
  diagnostic?: string;
} {
  const fail = () => ({ diagnostic: m.classPatchRejected() });
  const objects = [
    ...model.elements,
    ...model.boundaries,
    ...model.relationships,
  ];
  if (
    !targets.length ||
    new Set(targets.map((t) => t.selectionId)).size !== targets.length ||
    targets.some(
      (t) =>
        t.recordKey ||
        !objects.some((o) => o.resolution!.selectionId === t.selectionId),
    )
  )
    return fail();
  let next = model,
    selection: string | undefined;
  for (const target of targets) {
    if (
      ![...next.elements, ...next.boundaries, ...next.relationships].some(
        (o) => o.resolution!.selectionId === target.selectionId,
      )
    )
      continue;
    const prepared = prepareC4Delete(next, target);
    if (!prepared.result || !prepared.draft)
      return { diagnostic: prepared.diagnostic ?? m.classPatchRejected() };
    next = prepared.result.model;
    selection = prepared.result.selection;
  }
  return {
    result: c4CommandResult(
      model,
      { model: next, source: next.sourceDocument.source },
      selection,
    ),
    draft: {
      basis: model.sourceDocument.source,
      targets: structuredClone(targets),
      ...c4DeleteImpact(model, next),
    },
  };
}

export function deleteC4Selection(
  model: MermaidC4Model,
  draft: C4BatchDeleteDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4BatchDelete(model, draft.targets);
  return checked.result ?? c4NoChange(model, checked.diagnostic);
}
