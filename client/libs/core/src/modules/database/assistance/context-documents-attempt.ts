// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  TaskCorrectionOutcome,
  type ConfirmTaskCorrectionsInput,
  type ApplyContextDocumentsInput,
} from "@myoxus/graphql";
import {
  readGlobalStateConfirmed,
  writeGlobalStateConfirmed,
  type GlobalState,
} from "../../storage";

/** Frozen transport only: result authority and accepted descriptors remain on
 * the native receipt, including after reload or an uncertain response. */
export type ContextDocumentsAttempt = {
  input: ApplyContextDocumentsInput;
  gone?: true;
  product?: "documentReview" | "taskHandover" | "taskMaintenance";
  correction?: ConfirmTaskCorrectionsInput;
  maintenanceRunId?: string;
  // Editing never releases the reserved key or replaces its confirmed arguments.
  reviewUnacceptedEdit?: true;
};
export const contextDocumentsAttemptKey = (
  serverId: string,
  actorId: string,
  workspaceId: string,
  databaseId: string,
  taskId?: string | null,
  operation?: "taskHandover" | "taskMaintenance",
  runId?: string,
) =>
  // Preserve existing Context/Review keys; the new operation owns a separate slot.
  `context-documents:pending:${JSON.stringify([serverId, actorId, workspaceId, databaseId, taskId ?? null, ...(operation ? [operation] : []), ...(runId ? [runId] : [])])}`;
function validate(value: ContextDocumentsAttempt) {
  const input = value?.input;
  if (
    !input ||
    typeof input.requestId !== "string" ||
    !input.requestId ||
    typeof input.workspaceId !== "string" ||
    !input.workspaceId ||
    typeof input.target?.databaseId !== "string" ||
    !input.target.databaseId ||
    !input.identity?.id ||
    !input.identity.version ||
    !input.identity.digest ||
    typeof input.locale !== "string" ||
    !input.locale ||
    typeof input.planDigest !== "string" ||
    !input.planDigest ||
    !Number.isSafeInteger(input.clientVersion) ||
    (value.gone !== undefined && value.gone !== true) ||
    (value.product !== undefined &&
      value.product !== "documentReview" &&
      value.product !== "taskHandover" &&
      value.product !== "taskMaintenance") ||
    (value.reviewUnacceptedEdit !== undefined &&
      (value.reviewUnacceptedEdit !== true ||
        (value.product !== "documentReview" &&
          value.product !== "taskHandover" &&
          value.product !== "taskMaintenance"))) ||
    (value.maintenanceRunId !== undefined &&
      (value.product !== "taskMaintenance" ||
        typeof value.maintenanceRunId !== "string" ||
        !value.maintenanceRunId)) ||
    (value.correction !== undefined &&
      (value.product !== "taskMaintenance" ||
        typeof value.correction.runId !== "string" ||
        !value.correction.runId ||
        typeof value.correction.requestId !== "string" ||
        !value.correction.requestId ||
        typeof value.correction.waitId !== "string" ||
        !value.correction.waitId ||
        typeof value.correction.proposalDigest !== "string" ||
        !value.correction.proposalDigest ||
        ![TaskCorrectionOutcome.Apply, TaskCorrectionOutcome.Decline].includes(
          value.correction.outcome,
        ))) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024
  )
    throw new Error("Invalid pending context preparation");
}
/** One durable transport boundary is shared by contextual starts and native
 * decisions. Server projections and working results are never persisted here. */
export async function readConfirmedAssistantAttempt<T>(
  state: GlobalState,
  key: string,
  validateAttempt: (attempt: T) => void,
) {
  const attempt = await readGlobalStateConfirmed<T>(state, key);
  if (attempt !== undefined && attempt !== null) {
    if (
      new TextEncoder().encode(JSON.stringify(attempt)).byteLength >
      1024 * 1024
    )
      throw new Error("Invalid pending assistant transport");
    validateAttempt(attempt);
  }
  return attempt;
}
export async function saveConfirmedAssistantAttempt<T>(
  state: GlobalState,
  key: string,
  attempt: T | undefined,
  validateAttempt: (attempt: T) => void,
) {
  if (attempt !== undefined) {
    validateAttempt(attempt);
    if (
      new TextEncoder().encode(JSON.stringify(attempt)).byteLength >
      1024 * 1024
    )
      throw new Error("Invalid pending assistant transport");
  }
  await writeGlobalStateConfirmed(state, key, attempt);
}
export async function readContextDocumentsAttempt(
  state: GlobalState,
  key: string,
) {
  return readConfirmedAssistantAttempt(state, key, validate);
}
export async function saveContextDocumentsAttempt(
  state: GlobalState,
  key: string,
  attempt: ContextDocumentsAttempt | undefined,
) {
  await saveConfirmedAssistantAttempt(state, key, attempt, validate);
}
