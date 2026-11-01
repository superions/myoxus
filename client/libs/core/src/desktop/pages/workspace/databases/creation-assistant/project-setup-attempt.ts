// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readGlobalStateConfirmed,
  writeGlobalStateConfirmed,
  type GlobalState,
} from "@myoxus/core/modules/storage";
import type { ProjectAssistantConfirmationInput } from "@myoxus/graphql";
import type { CreationAssistantRequest } from "./model";

export type ProjectSetupAttempt = {
  /** Native result tombstone; exposed only after this flag's confirmed flush. */
  gone?: true;
  request: CreationAssistantRequest & {
    assistantConfirmation: ProjectAssistantConfirmationInput & {
      requestId: string;
    };
  };
};
export const projectSetupAttemptKey = (
  serverId: string,
  actorId: string,
  workspaceId: string,
) =>
  `project-setup:pending:${JSON.stringify([serverId, actorId, workspaceId])}`;

// Canonical answers and the native compatibility arguments can repeat the same
// valid text. Bound the serialized transport, without lowering native field limits.
function validate(attempt: ProjectSetupAttempt) {
  const confirmation = attempt?.request?.assistantConfirmation;
  if (
    (attempt.gone !== undefined && attempt.gone !== true) ||
    !confirmation?.requestId ||
    !confirmation.planDigest ||
    !confirmation.identity?.id ||
    !confirmation.identity.version ||
    !confirmation.identity.digest ||
    new TextEncoder().encode(JSON.stringify(attempt)).byteLength > 1024 * 1024
  )
    throw new Error("Invalid pending Project setup");
}

/** Only frozen transport arguments are retained. The server receipt alone
 * proves acceptance, partial results, completion and permission to resume. */
export async function readProjectSetupAttempt(state: GlobalState, key: string) {
  const attempt = await readGlobalStateConfirmed<ProjectSetupAttempt>(
    state,
    key,
  );
  if (attempt) validate(attempt);
  return attempt;
}
export async function saveProjectSetupAttempt(
  state: GlobalState,
  key: string,
  attempt: ProjectSetupAttempt,
) {
  validate(attempt);
  await writeGlobalStateConfirmed(state, key, attempt);
}
