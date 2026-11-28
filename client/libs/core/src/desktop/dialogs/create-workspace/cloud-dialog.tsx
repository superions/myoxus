// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type AssistantAnswers,
  assistantAnswerPayload,
  visibleAssistantAnswers,
} from "@myoxus/core/modules/database/presentation/values";
import {
  AuthService,
  type Server,
  UserPreferencesService,
} from "@myoxus/core/modules/server";
import {
  GlobalState,
  writeGlobalStateConfirmed,
} from "@myoxus/core/modules/storage";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { createOperationUuid } from "@myoxus/core/utils/uuid";
import {
  AssistantContext,
  AssistantNativeActionKind,
  prepareWorkspaceAssistantQuery,
  workspaceAssistantPackagesQuery,
  workspaceCreationQuery,
  type WorkspaceCreationResultFragmentFragment,
  WorkspaceInitialContent,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { Button, ConfirmModal, Input, Notice, Stack } from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";

import { WorkspaceCloudForm } from "./cloud-form";
import type { WorkspaceDialogBodyProps } from "./local-dialog";
import {
  isUnacceptedWorkspaceName,
  isWorkspaceCreationGone,
  readWorkspaceCreationAttempt,
  saveWorkspaceCreationAttempt,
  type WorkspaceCreationAttempt,
  workspaceCreationAttemptKey,
  workspaceCreationReady,
} from "./model";

export function CloudWorkspaceDialog({
  modal,
  server,
  actorId,
  name,
  onNameChange,
  target,
  onCreated,
}: WorkspaceDialogBodyProps & { server: Server; actorId: string }) {
  const t = useI18n();
  const state = useService(GlobalState);
  const workspaces = useService(WorkspacesService);
  const preferences = server.scope.get(UserPreferencesService);
  const storageKey = workspaceCreationAttemptKey(server.id, actorId);

  const [retained, setRetained] = useState<{
    attempt?: WorkspaceCreationAttempt;
    invalid: boolean;
    loading: boolean;
  }>({ invalid: false, loading: true });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [outcome, setOutcome] =
    useState<WorkspaceCreationResultFragmentFragment | null>(null);

  const attemptRef = useRef<WorkspaceCreationAttempt | undefined>(undefined);
  const ownerValidRef = useRef(true);
  const activeRef = useRef(true);
  const submittingRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    const subscription = server.scope
      .get(AuthService)
      .session.account$.subscribe((account) => {
        if (account?.id !== actorId) ownerValidRef.current = false;
      });
    return () => subscription.unsubscribe();
  }, [actorId, server]);

  const isCurrentOwner = useCallback(
    () =>
      activeRef.current &&
      ownerValidRef.current &&
      server.scope.get(AuthService).session.account$.value?.id === actorId,
    [actorId, server],
  );

  const persistAttempt = useCallback(
    async (attempt: WorkspaceCreationAttempt) => {
      await saveWorkspaceCreationAttempt(state, storageKey, attempt);
      attemptRef.current = attempt;
      if (isCurrentOwner()) {
        setRetained({ attempt, invalid: false, loading: false });
      }
    },
    [isCurrentOwner, state, storageKey],
  );

  const readReceipt = useCallback(
    async (attempt: WorkspaceCreationAttempt) => {
      const generation = ++generationRef.current;
      try {
        const response = await server.gql({
          query: workspaceCreationQuery,
          variables: { requestId: attempt.input.requestId },
        });
        if (
          !isCurrentOwner() ||
          generation !== generationRef.current ||
          response.currentUser?.id !== actorId
        ) {
          throw new Error("Workspace creation owner changed");
        }
        const result = response.currentUser.workspaceCreation;
        if (
          result &&
          (result.requestId !== attempt.input.requestId ||
            result.setup != null ||
            result.projectSetup != null)
        ) {
          throw new Error("Workspace receipt identity changed");
        }
        setOutcome(result);
        return result;
      } catch (error) {
        if (
          isWorkspaceCreationGone(error) &&
          isCurrentOwner() &&
          generation === generationRef.current
        ) {
          const gone = { ...attempt, gone: true };
          await saveWorkspaceCreationAttempt(state, storageKey, gone);
          if (isCurrentOwner() && generation === generationRef.current) {
            attemptRef.current = gone;
            setRetained({ attempt: gone, invalid: false, loading: false });
            setOutcome(null);
          }
        }
        throw error;
      }
    },
    [actorId, isCurrentOwner, server, state, storageKey],
  );

  useEffect(() => {
    let cancelled = false;
    void readWorkspaceCreationAttempt(state, storageKey)
      .then(async (attempt) => {
        if (cancelled || !isCurrentOwner()) return;
        attemptRef.current = attempt;
        setRetained({ attempt, invalid: false, loading: false });
        if (attempt) onNameChange(attempt.input.name);
        if (attempt && !attempt.unaccepted && !attempt.gone) {
          await readReceipt(attempt);
        }
      })
      .catch(() => {
        if (cancelled || !isCurrentOwner()) return;
        if (attemptRef.current) setFailed(true);
        else setRetained({ invalid: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [isCurrentOwner, onNameChange, readReceipt, state, storageKey]);

  const packageQuery = useSWR(
    (!retained.attempt || retained.attempt.unaccepted) &&
      !retained.invalid &&
      !retained.loading
      ? ["workspace-creation-package", server.id, actorId]
      : null,
    async () => {
      const [catalog, assistance] = await Promise.all([
        server.gql({ query: workspaceAssistantPackagesQuery }),
        preferences.getAssistance(),
      ]);
      if (!isCurrentOwner() || catalog.currentUser?.id !== actorId) {
        throw new Error("Workspace creation owner changed");
      }
      return {
        descriptor: catalog.currentUser.assistantPackages.find(
          (item) =>
            item.defaultFor.includes(AssistantContext.WorkspaceCreation) &&
            item.components[0]?.action.kind ===
              AssistantNativeActionKind.CreateWorkspace,
        ),
        assistance,
      };
    },
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );

  const descriptor = packageQuery.data?.descriptor;

  const openReceipt = async (
    result: WorkspaceCreationResultFragmentFragment,
  ) => {
    await workspaces.list.waitForRevalidation();
    if (!isCurrentOwner()) return;
    const metadata = workspaces.list.workspaces$.value.find(
      (item) => item.id === result.workspaceId && item.flavour === server.id,
    );
    if (!metadata) throw new Error("Workspace result unavailable");
    onCreated({ ...metadata, creation: result });
    if (workspaceCreationReady(result)) {
      await writeGlobalStateConfirmed(state, storageKey, undefined);
    }
  };

  const applyCreation = async (answers?: AssistantAnswers) => {
    if (
      submittingRef.current ||
      retained.invalid ||
      retained.loading ||
      !isCurrentOwner()
    ) {
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setFailed(false);

    try {
      let attempt =
        attemptRef.current ??
        (await readWorkspaceCreationAttempt(state, storageKey));
      if (!isCurrentOwner() || attempt?.gone) return;

      if (attempt && !attempt.unaccepted) {
        const latest = await readReceipt(attempt);
        if (!isCurrentOwner()) return;
        if (latest && workspaceCreationReady(latest)) {
          await openReceipt(latest);
          return;
        }
      } else {
        if (!descriptor || packageQuery.error || !answers) {
          throw new Error("Workspace package unavailable");
        }
        const response = await server.gql({
          query: prepareWorkspaceAssistantQuery,
          variables: {
            input: {
              identity: descriptor.identity,
              answers: assistantAnswerPayload(
                visibleAssistantAnswers(descriptor, answers),
              ),
            },
          },
        });
        if (!isCurrentOwner()) return;
        if (response.currentUser?.id !== actorId) {
          throw new Error("Workspace preparation owner changed");
        }
        const plan = response.currentUser.prepareWorkspaceAssistant;
        if (
          plan.package.id !== descriptor.identity.id ||
          plan.package.version !== descriptor.identity.version ||
          plan.package.digest !== descriptor.identity.digest ||
          plan.project != null ||
          plan.setup != null ||
          plan.initialContent !== WorkspaceInitialContent.Empty ||
          plan.assistanceMode !== packageQuery.data?.assistance.interactiveMode
        ) {
          throw new Error("Workspace preparation identity changed");
        }
        const existing = await readWorkspaceCreationAttempt(state, storageKey);
        if (!isCurrentOwner()) return;
        attempt = (existing && !existing.unaccepted ? existing : undefined) ?? {
          input: {
            name: plan.name,
            initialContent: plan.initialContent,
            assistanceMode: plan.assistanceMode,
            requestId: attempt?.input.requestId ?? createOperationUuid(),
            assistantConfirmation: {
              identity: plan.package,
              answers: assistantAnswerPayload(
                Object.fromEntries(
                  plan.answers.map(({ input, value }) => [input, value]),
                ),
              ),
              planDigest: plan.planDigest,
            },
          },
        };
      }

      await persistAttempt(attempt);
      if (!isCurrentOwner()) return;
      const metadata = await workspaces.create(server.id, undefined, {
        kind: "cloud-empty",
        input: attempt.input,
      });
      if (!isCurrentOwner()) return;
      if (
        metadata.creation?.requestId !== attempt.input.requestId ||
        metadata.creation.workspaceId !== metadata.id ||
        metadata.creation.setup != null ||
        metadata.creation.projectSetup != null
      ) {
        throw new Error("Workspace receipt identity changed");
      }
      ++generationRef.current;
      setOutcome(metadata.creation);
      if (workspaceCreationReady(metadata.creation)) {
        await openReceipt(metadata.creation);
      } else {
        setFailed(true);
      }
    } catch (error) {
      if (isCurrentOwner()) {
        if (
          attemptRef.current &&
          (isUnacceptedWorkspaceName(error) || isWorkspaceCreationGone(error))
        ) {
          try {
            await persistAttempt({
              ...attemptRef.current,
              ...(isWorkspaceCreationGone(error)
                ? { gone: true }
                : { unaccepted: true }),
            });
          } catch {
            // Preserve the frozen original request when acknowledgement fails.
          }
        }
        if (isCurrentOwner()) setFailed(true);
      }
    } finally {
      submittingRef.current = false;
      if (isCurrentOwner()) setBusy(false);
    }
  };

  const discardGoneAttempt = async () => {
    if (!retained.attempt?.gone || busy || !isCurrentOwner()) return;
    setBusy(true);
    try {
      await writeGlobalStateConfirmed(state, storageKey, undefined);
      if (!isCurrentOwner()) return;
      attemptRef.current = undefined;
      setRetained({ invalid: false, loading: false });
      setOutcome(null);
      setFailed(false);
    } catch {
      if (isCurrentOwner()) setFailed(true);
    } finally {
      if (isCurrentOwner()) setBusy(false);
    }
  };

  const frozen = Boolean(retained.attempt && !retained.attempt.unaccepted);
  const locked = busy || retained.loading || retained.invalid;
  const sourceUnavailable = Boolean(
    packageQuery.error || (packageQuery.data && !descriptor),
  );
  const hasError = failed || retained.invalid || sourceUnavailable;

  const notices = (
    <>
      {frozen ? (
        <Notice tone="warning">
          {retained.attempt?.gone
            ? t["com.myoxus.create-workspace.gone"]()
            : t["com.myoxus.create-workspace.recovery"]()}
        </Notice>
      ) : null}
      {hasError ? (
        <Notice tone="error">
          {sourceUnavailable
            ? t["com.myoxus.create-workspace.source-unavailable"]()
            : t["com.myoxus.create-workspace.error.message"]()}
          {sourceUnavailable ? (
            <Button disabled={busy} onClick={() => void packageQuery.mutate()}>
              {t.Retry()}
            </Button>
          ) : null}
        </Notice>
      ) : null}
    </>
  );

  const confirmButton = (
    <Button
      type="submit"
      form="create-workspace-form"
      variant="primary"
      data-testid={
        frozen && workspaceCreationReady(outcome)
          ? "create-workspace-open-button"
          : "create-workspace-create-button"
      }
      disabled={
        locked || (!frozen && (!descriptor || Boolean(packageQuery.error)))
      }
      loading={busy || retained.loading || (!frozen && packageQuery.isLoading)}
    >
      {retained.attempt?.gone
        ? t["com.myoxus.create-workspace.discard-gone"]()
        : frozen && workspaceCreationReady(outcome)
          ? t["com.myoxus.workspace-import.open"]()
          : frozen || failed
            ? t.Retry()
            : t.Create()}
    </Button>
  );

  if (descriptor && packageQuery.data && !frozen) {
    return (
      <WorkspaceCloudForm
        descriptor={descriptor}
        mode={packageQuery.data.assistance.interactiveMode}
        name={name}
        onNameChange={onNameChange}
        disabled={locked}
        target={target(locked)}
        nameError={
          retained.attempt?.unaccepted
            ? t[
                "com.myoxus.workspace-content-operation.blocker.workspace-name"
              ]()
            : undefined
        }
        onSubmit={(answers) => void applyCreation(answers)}
      >
        {(_answers, _validate, form) => (
          <ConfirmModal
            {...modal}
            persistent={busy}
            cancelButtonOptions={{ disabled: busy }}
            customConfirmButton={() => confirmButton}
          >
            {form}
            {notices}
          </ConfirmModal>
        )}
      </WorkspaceCloudForm>
    );
  }

  return (
    <ConfirmModal
      {...modal}
      persistent={busy}
      cancelButtonOptions={{ disabled: busy }}
      customConfirmButton={() => confirmButton}
    >
      <form
        id="create-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (retained.attempt?.gone) void discardGoneAttempt();
          else void applyCreation();
        }}
      >
        <Stack>
          <Input
            autoFocus
            data-autofocus
            required
            maxLength={64}
            value={retained.attempt?.input.name ?? name}
            onChange={onNameChange}
            disabled={locked || frozen}
            label={t["com.myoxus.nameWorkspace.subtitle.workspace-name"]()}
            data-testid="create-workspace-input"
          />
          {target(locked || frozen)}
        </Stack>
      </form>
      {notices}
    </ConfirmModal>
  );
}
