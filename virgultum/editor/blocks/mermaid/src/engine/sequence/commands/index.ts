// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "./participant-commands.js";
export * from "./message-commands.js";
export * from "./activation-commands.js";
export * from "./note-commands.js";
export * from "./fragment-commands.js";
export * from "./background-commands.js";
export * from "./metadata-commands.js";

import type { MermaidSequenceModel } from "../model.js";
import {
  composeSequenceCommandResults,
  sequenceNoChange,
  type SequenceCommandResult,
  type SequenceWriteOptions,
} from "../writer.js";
import { deleteSequenceParticipant } from "./participant-commands.js";
import { deleteSequenceMessage } from "./message-commands.js";
import { deleteSequenceActivation } from "./activation-commands.js";
import { deleteSequenceNote } from "./note-commands.js";
import {
  deleteSequenceFragment,
  deleteSequenceBranch,
} from "./fragment-commands.js";
import { deleteSequenceBackground } from "./background-commands.js";
/** Cascade overlapping selections in one checked candidate; the host still
 * commits once and receives the union of the concrete deletion impact. */
export function deleteSequenceSelection(
  model: MermaidSequenceModel,
  keys: readonly string[],
  options: SequenceWriteOptions = {},
) {
  let current = model;
  const impact = new Map<string, { id: string; kind: string; label: string }>();
  for (const key of new Set(keys)) {
    let result: SequenceCommandResult | undefined;
    if (current.participants.some((p) => p.sourceKey === key))
      result = deleteSequenceParticipant(current, key);
    else if (current.messages.some((m) => m.id === key))
      result = deleteSequenceMessage(current, key);
    else if (current.activationIntervals.some((a) => a.id === key))
      result = deleteSequenceActivation(current, key);
    else if (current.notes.some((n) => n.id === key))
      result = deleteSequenceNote(current, key);
    else if (current.controls.some((c) => c.id === key))
      result = deleteSequenceFragment(current, key, false);
    else if (current.controls.some((c) => c.branches.some((b) => b.id === key)))
      result = deleteSequenceBranch(current, key);
    else if (current.backgrounds.some((b) => b.id === key))
      result = deleteSequenceBackground(current, key);
    if (result?.status === "rejected")
      return sequenceNoChange(model, "invalid", result.diagnostic);
    if (result) {
      current = result.model;
      for (const record of result.impact?.records ?? [])
        impact.set(record.id, record);
    }
  }
  return composeSequenceCommandResults(
    model,
    { ...sequenceNoChange(current), impact: { records: [...impact.values()] } },
    options,
  );
}
