// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AssistantInputTarget,
  AssistantValueType,
  WorkspaceCreationStatus,
  AssistanceMode,
  WorkspaceInitialContent,
  type AssistantPackageFragmentFragment,
  type CreateWorkspaceInput,
  type CreateWorkspaceMutation,
} from "@myoxus/graphql";
import { UserFriendlyError } from "@myoxus/error";
import {
  writeGlobalStateConfirmed,
  readGlobalStateConfirmed,
  type GlobalState,
} from "@myoxus/core/modules/storage";
import {
  assistantValue,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "@myoxus/core/modules/database/presentation/values";

export type WorkspaceCreationAttempt = {
  input: CreateWorkspaceInput;
  unaccepted?: boolean;
  gone?: boolean;
};
export const workspaceCreationAttemptKey = (
  serverId: string,
  actorId: string,
) => `workspace-creation:pending:${JSON.stringify([serverId, actorId])}`;

function validateWorkspaceCreationAttempt(attempt: WorkspaceCreationAttempt) {
  const input = attempt?.input;
  if (
    typeof input?.name !== "string" ||
    !Object.values(WorkspaceInitialContent).includes(input.initialContent) ||
    !Object.values(AssistanceMode).includes(input.assistanceMode) ||
    typeof input?.requestId !== "string" ||
    !input.requestId ||
    !input.assistantConfirmation?.planDigest ||
    typeof input.assistantConfirmation.identity?.id !== "string" ||
    !input.assistantConfirmation.identity.id ||
    typeof input.assistantConfirmation.identity.version !== "string" ||
    !input.assistantConfirmation.identity.version ||
    typeof input.assistantConfirmation.identity.digest !== "string" ||
    !input.assistantConfirmation.identity.digest ||
    input.project != null ||
    input.setup != null ||
    new TextEncoder().encode(JSON.stringify(attempt)).byteLength > 1024 * 1024
  )
    throw new Error("Invalid pending Workspace creation");
}

/** One bounded accepted request per owner survives reload/response loss. Its
 * exact input is never replaced by a new package preparation on retry. Server
 * results and editable drafts are never persisted in this transport slot. */
export async function saveWorkspaceCreationAttempt(
  state: GlobalState,
  key: string,
  attempt: WorkspaceCreationAttempt,
) {
  validateWorkspaceCreationAttempt(attempt);
  await writeGlobalStateConfirmed(state, key, {
    input: attempt.input,
    ...(attempt.unaccepted ? { unaccepted: true } : {}),
    ...(attempt.gone ? { gone: true } : {}),
  });
}
export async function readWorkspaceCreationAttempt(
  state: GlobalState,
  key: string,
) {
  const attempt = await readGlobalStateConfirmed<WorkspaceCreationAttempt>(
    state,
    key,
  );
  // Unpublished combined-purpose drafts are discarded locally, never replayed
  // or converted. This removes only the request slot, not allocated content.
  if (attempt?.input?.project != null || attempt?.input?.setup != null) {
    await writeGlobalStateConfirmed(state, key, undefined);
    return undefined;
  }
  if (attempt) validateWorkspaceCreationAttempt(attempt);
  return attempt
    ? {
        input: attempt.input,
        ...(attempt.unaccepted ? { unaccepted: true } : {}),
        ...(attempt.gone ? { gone: true } : {}),
      }
    : undefined;
}
export function workspaceCreationReady(
  creation: CreateWorkspaceMutation["createWorkspace"]["creation"],
) {
  return Boolean(
    creation &&
    creation.status === WorkspaceCreationStatus.Ready &&
    creation.rootReady &&
    creation.tasksReady &&
    creation.assistanceSaved &&
    !creation.retryRequired,
  );
}

export function workspaceInitialAnswers(
  descriptor: AssistantPackageFragmentFragment,
  name: string,
  mode: AssistanceMode,
): AssistantAnswers {
  const supplied: Record<string, ReturnType<typeof assistantValue>> = {};
  for (const input of descriptor.inputs) {
    if (input.target === AssistantInputTarget.WorkspaceName && name)
      supplied[input.id] = assistantValue(AssistantValueType.Text, {
        text: name,
      });
    if (
      input.target === AssistantInputTarget.AssistanceMode ||
      input.target === AssistantInputTarget.InitialContent
    ) {
      const expected =
        input.target === AssistantInputTarget.AssistanceMode
          ? mode
          : WorkspaceInitialContent.Empty;
      const choice = input.choices.find(
        (choice) =>
          (choice.value.choice ?? choice.value.text)?.toLowerCase() ===
          expected.toLowerCase(),
      );
      if (choice)
        supplied[input.id] = assistantValue(AssistantValueType.Choice, {
          choice: choice.id,
        });
    }
  }
  return visibleAssistantAnswers(descriptor, supplied, true);
}

/** Only this native structured failure proves the allocation was rejected.
 * Transport/storage/Gone/fingerprint failures retain the frozen exact request. */
export function isUnacceptedWorkspaceName(error: unknown) {
  const name: string = UserFriendlyError.fromAny(error).name;
  return name === "XWS_WORKSPACE_NAME_CONFLICT";
}

export function isWorkspaceCreationGone(error: unknown) {
  return (
    UserFriendlyError.fromAny(error).extensions?.code ===
    "XWS_WORKSPACE_STARTER_GONE"
  );
}
