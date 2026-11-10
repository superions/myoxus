// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServiceProvider } from "@virgultum/global/di";
import type { DeltaInsert } from "@virgultum/store";
import { DocumentFieldOutputProvider } from "../../services/document-field-output";
import {
  DocumentFieldSchema,
  validateDocumentFieldRun,
  visitDocumentFieldRuns,
  type DocumentField,
} from "../../types/document-field";
import type { MyoxusTextAttributes } from "../../types";

/** Project native attributed text in an independent reading copy. Captured
 * runs retain their stored text and formatting without consulting current facts;
 * live runs require authorized presentation. Raw archival output bypasses this.
 */
export async function projectDocumentFieldOutput<T>(
  snapshot: T,
  provider: ServiceProvider | undefined,
  docId?: string,
  workspaceId?: string,
): Promise<T> {
  const runs: Array<{
    delta: DeltaInsert<MyoxusTextAttributes>;
    occurrence: number;
  }> = [];
  const fields: DocumentField[] = [];
  const seen = new Set<string>();
  let containsFields = false;
  let containsCaptured = false;
  let containsLive = false;
  visitDocumentFieldRuns(snapshot, () => {
    containsFields = true;
  });
  if (!containsFields) return snapshot;
  const copy = structuredClone(snapshot);
  let previous:
    | {
        deltas: object;
        index: number;
        field: string;
        occurrence: number;
        captured: boolean;
      }
    | undefined;
  visitDocumentFieldRuns(copy, (delta, deltas, index) => {
    validateDocumentFieldRun(delta);
    if (delta.attributes?.documentFieldCaptured) containsCaptured = true;
    else containsLive = true;
    const field = DocumentFieldSchema.parse(delta.attributes?.documentField);
    const encoded = JSON.stringify(field);
    const continuation =
      delta.attributes?.documentFieldCaptured &&
      previous?.captured &&
      previous.deltas === deltas &&
      previous.index === index - 1 &&
      previous.field === encoded;
    if (!continuation && seen.has(field.id))
      throw new Error("Duplicate native field occurrence in output");
    const occurrence = continuation ? previous!.occurrence : fields.length;
    if (!continuation) {
      seen.add(field.id);
      fields.push(field);
    }
    runs.push({ delta, occurrence });
    previous = {
      deltas,
      index,
      field: encoded,
      occurrence,
      captured: delta.attributes?.documentFieldCaptured === true,
    };
  });
  if (containsCaptured && containsLive)
    throw new Error("Mixed live and captured native fields in output");
  if (
    fields.length > 2048 ||
    new TextEncoder().encode(JSON.stringify(fields)).length > 256 * 1024
  )
    throw new Error("Native field output limit exceeded");
  if (containsCaptured) {
    for (const { delta } of runs) {
      delete delta.attributes!.documentField;
      delete delta.attributes!.documentFieldCaptured;
    }
    return copy;
  }
  if (!fields.length) return snapshot;
  const source = provider?.getOptional(DocumentFieldOutputProvider);
  const target = docId ?? source?.docId;
  if (!source || !target)
    throw new Error("Native field output context unavailable");
  const values = await source.resolve(
    workspaceId ?? source.workspaceId,
    target,
    fields,
  );
  if (
    values.length !== fields.length ||
    values.some((value) => typeof value !== "string")
  )
    throw new Error("Incomplete native field output");
  const emitted = new Set<number>();
  for (const { delta, occurrence } of runs) {
    delta.insert = emitted.has(occurrence) ? "" : values[occurrence];
    emitted.add(occurrence);
    delete delta.attributes!.documentField;
    delete delta.attributes!.documentFieldCaptured;
  }
  return copy;
}
