// SPDX-License-Identifier: MIT
import {
  type DialogComponentProps,
  type GLOBAL_DIALOG_SCHEMA,
  GlobalDialogService,
} from "@myoxus/core/modules/dialogs";
import {
  AuthService,
  type Server,
  ServersService,
  UserPreferencesService,
} from "@myoxus/core/modules/server";
import {
  GlobalState,
  writeGlobalStateConfirmed,
} from "@myoxus/core/modules/storage";
import {
  WorkspacesService,
  type WorkspaceMetadata,
} from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { createOperationUuid } from "@myoxus/core/utils/uuid";
import {
  assistantAnswerPayload,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "@myoxus/core/modules/database/presentation/values";
import {
  AssistanceMode,
  AssistantContext,
  AssistantNativeActionKind,
  WorkspaceInitialContent,
  workspaceAssistantPackagesQuery,
  prepareWorkspaceAssistantQuery,
  workspaceCreationQuery,
  type WorkspaceCreationResultFragmentFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { Button, ConfirmModal, Input, Notice, Stack } from "@myoxus/ui-facade";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import useSWR from "swr";
import { ServerSelector } from "./server-selector";
import { WorkspaceCloudForm } from "./cloud-form";
import {
  isUnacceptedWorkspaceName,
  isWorkspaceCreationGone,
  readWorkspaceCreationAttempt,
  saveWorkspaceCreationAttempt,
  workspaceCreationAttemptKey,
  workspaceCreationReady,
  type WorkspaceCreationAttempt,
} from "./model";

/** The opening draft survives authentication. Accepted remote inputs live in
 * the existing owner-scoped GlobalState until their native receipt is ready. */
export const CreateWorkspaceDialog = ({
  serverId,
  close,
  ...props
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["create-workspace"]>) => {
  const t = useI18n();
  const [name, setName] = useState("");
  const [open, setOpen] = useState(true);
  const [nameChecked, setNameChecked] = useState(false);
  const serversService = useService(ServersService);
  const dialogs = useService(GlobalDialogService);
  const [targetId, setTargetId] = useState(
    (serverId === "local" && !canUseLocalWorkspaces()
      ? serversService.selectedServerId$.value
      : (serverId ?? serversService.selectedServerId$.value)) ??
      (canUseLocalWorkspaces() ? "local" : ""),
  );
  const servers = useLiveData(serversService.servers$);
  const server = useLiveData(
    targetId && targetId !== "local" ? serversService.server$(targetId) : null,
  );
  const account = useLiveData(
    server?.scope.get(AuthService).session.account$ ?? null,
  );
  const showTarget = servers.length + (canUseLocalWorkspaces() ? 1 : 0) > 1;
  const target = (disabled: boolean) =>
    showTarget ? (
      <ServerSelector
        label={t["com.myoxus.nameWorkspace.subtitle.workspace-type"]()}
        selectedId={targetId}
        onChange={setTargetId}
        disabled={disabled}
      />
    ) : null;
  const modal: ComponentProps<typeof ConfirmModal> = {
    ...props,
    open,
    onOpenChange: setOpen,
    // Keep the native modal mounted until it returns focus to the visible opener.
    onExitTransitionEnd: () => {
      if (!open) close();
    },
    title: t["com.myoxus.nameWorkspace.title"](),
    cancelText: t.Cancel(),
    closeButtonOptions: { "data-testid": "create-workspace-close-button" },
  };
  const created = (metadata: WorkspaceMetadata) => close({ metadata });
  if (targetId === "local" && canUseLocalWorkspaces())
    return (
      <LocalWorkspaceDialog
        modal={modal}
        name={name}
        onNameChange={setName}
        target={target}
        onCreated={created}
      />
    );
  if (server && account)
    return (
      <CloudWorkspaceDialog
        key={JSON.stringify([server.id, account.id])}
        modal={modal}
        server={server}
        actorId={account.id}
        name={name}
        onNameChange={setName}
        target={target}
        onCreated={created}
      />
    );
  // Preserve the opening draft while authentication changes the active owner.
  return (
    <ConfirmModal
      {...modal}
      customConfirmButton={() => (
        <Button
          type="submit"
          form="create-workspace-sign-in-form"
          variant="primary"
          data-testid="create-workspace-create-button"
          disabled={!server}
        >
          {t.Create()}
        </Button>
      )}
    >
      <form
        id="create-workspace-sign-in-form"
        onSubmit={(event) => {
          event.preventDefault();
          setNameChecked(true);
          if (server && name.trim())
            dialogs.open("sign-in", { server: server.baseUrl });
        }}
      >
        <Stack>
          <Input
            autoFocus
            data-autofocus
            required
            value={name}
            onChange={setName}
            error={
              nameChecked && !name.trim()
                ? t["com.myoxus.document-metadata.validation.required"]({
                    label:
                      t["com.myoxus.nameWorkspace.subtitle.workspace-name"](),
                  })
                : undefined
            }
            maxLength={64}
            label={t["com.myoxus.nameWorkspace.subtitle.workspace-name"]()}
            data-testid="create-workspace-input"
          />
          {target(false)}
        </Stack>
      </form>
    </ConfirmModal>
  );
};

type NativeProps = {
  modal: ComponentProps<typeof ConfirmModal>;
  name: string;
  onNameChange: (value: string) => void;
  target: (disabled: boolean) => ReactNode;
  onCreated: (metadata: WorkspaceMetadata) => void;
};

function CloudWorkspaceDialog({
  modal,
  server,
  actorId,
  name,
  onNameChange,
  target,
  onCreated,
}: NativeProps & { server: Server; actorId: string }) {
  const t = useI18n();
  const state = useService(GlobalState);
  const workspaces = useService(WorkspacesService);
  const preferences = server.scope.get(UserPreferencesService);
  const key = workspaceCreationAttemptKey(server.id, actorId);
  const [retained, setRetained] = useState<{
    attempt?: WorkspaceCreationAttempt;
    invalid: boolean;
    loading: boolean;
  }>({ invalid: false, loading: true });
  const attemptRef = useRef<WorkspaceCreationAttempt | undefined>(undefined);
  const ownerValid = useRef(true);
  const active = useRef(true);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [outcome, setOutcome] =
    useState<WorkspaceCreationResultFragmentFragment | null>(null);
  const outcomeGeneration = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const subscription = server.scope
      .get(AuthService)
      .session.account$.subscribe((account) => {
        if (account?.id !== actorId) ownerValid.current = false;
      });
    return () => subscription.unsubscribe();
  }, [server, actorId]);
  const current = useCallback(
    () =>
      active.current &&
      ownerValid.current &&
      server.scope.get(AuthService).session.account$.value?.id === actorId,
    [server, actorId],
  );
  const save = async (attempt: WorkspaceCreationAttempt) => {
    // Publish to memory only after the durable Main-process acknowledgement.
    await saveWorkspaceCreationAttempt(state, key, attempt);
    attemptRef.current = attempt;
    if (current()) setRetained({ attempt, invalid: false, loading: false });
  };
  const readOutcome = useCallback(
    async (attempt: WorkspaceCreationAttempt) => {
      const generation = ++outcomeGeneration.current;
      try {
        const response = await server.gql({
          query: workspaceCreationQuery,
          variables: { requestId: attempt.input.requestId },
        });
        if (
          !current() ||
          generation !== outcomeGeneration.current ||
          response.currentUser?.id !== actorId
        )
          throw new Error("Workspace creation owner changed");
        const result = response.currentUser.workspaceCreation;
        if (
          result &&
          (result.requestId !== attempt.input.requestId ||
            result.setup != null ||
            result.projectSetup != null)
        )
          throw new Error("Workspace receipt identity changed");
        setOutcome(result);
        return result;
      } catch (error) {
        if (
          isWorkspaceCreationGone(error) &&
          current() &&
          generation === outcomeGeneration.current
        ) {
          const gone = { ...attempt, gone: true };
          await saveWorkspaceCreationAttempt(state, key, gone);
          if (current() && generation === outcomeGeneration.current) {
            attemptRef.current = gone;
            setRetained({ attempt: gone, invalid: false, loading: false });
            setOutcome(null);
          }
        }
        throw error;
      }
    },
    [server, actorId, current, state, key],
  );
  useEffect(() => {
    let cancelled = false;
    void readWorkspaceCreationAttempt(state, key)
      .then(async (attempt) => {
        if (cancelled || !current()) return;
        attemptRef.current = attempt;
        setRetained({ attempt, invalid: false, loading: false });
        if (attempt) onNameChange(attempt.input.name);
        if (attempt && !attempt.unaccepted && !attempt.gone)
          await readOutcome(attempt);
      })
      .catch(() => {
        if (cancelled || !current()) return;
        if (attemptRef.current) setFailed(true);
        else setRetained({ invalid: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [state, key, current, readOutcome, onNameChange]);
  const query = useSWR(
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
      if (!current() || catalog.currentUser?.id !== actorId)
        throw new Error("Workspace creation owner changed");
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
  const descriptor = query.data?.descriptor;
  const openOutcome = async (
    result: WorkspaceCreationResultFragmentFragment,
  ) => {
    await workspaces.list.waitForRevalidation();
    if (!current()) return;
    const metadata = workspaces.list.workspaces$.value.find(
      (item) => item.id === result.workspaceId && item.flavour === server.id,
    );
    if (!metadata) throw new Error("Workspace result unavailable");
    // Keep the exact request if the consumer synchronously fails to open it.
    // A later cleanup failure likewise leaves a ready receipt to reopen.
    onCreated({ ...metadata, creation: result });
    if (workspaceCreationReady(result))
      await writeGlobalStateConfirmed(state, key, undefined);
  };
  const apply = async (answers?: AssistantAnswers) => {
    if (
      submitting.current ||
      retained.invalid ||
      retained.loading ||
      !current()
    )
      return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      let attempt =
        attemptRef.current ?? (await readWorkspaceCreationAttempt(state, key));
      if (!current()) return;
      if (attempt?.gone) return;
      if (attempt && !attempt.unaccepted) {
        // Readback must succeed before replay: permission/transport failures
        // never stand in for an absent receipt.
        const latest = await readOutcome(attempt);
        if (!current()) return;
        if (latest && workspaceCreationReady(latest)) {
          await openOutcome(latest);
          return;
        }
      } else {
        if (!descriptor || query.error || !answers)
          throw new Error("Workspace package unavailable");
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
        if (!current()) return;
        if (response.currentUser?.id !== actorId)
          throw new Error("Workspace preparation owner changed");
        const plan = response.currentUser.prepareWorkspaceAssistant;
        if (
          plan.package.id !== descriptor.identity.id ||
          plan.package.version !== descriptor.identity.version ||
          plan.package.digest !== descriptor.identity.digest ||
          plan.project != null ||
          plan.setup != null ||
          plan.initialContent !== WorkspaceInitialContent.Empty ||
          plan.assistanceMode !== query.data?.assistance.interactiveMode
        )
          throw new Error("Workspace preparation identity changed");
        const existing = await readWorkspaceCreationAttempt(state, key);
        if (!current()) return;
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
      // Reflush even a recovered memory snapshot before any allocation/replay.
      await save(attempt);
      if (!current()) return;
      const metadata = await workspaces.create(server.id, undefined, {
        kind: "cloud-empty",
        input: attempt.input,
      });
      if (!current()) return;
      if (
        metadata.creation?.requestId !== attempt.input.requestId ||
        metadata.creation.workspaceId !== metadata.id ||
        metadata.creation.setup != null ||
        metadata.creation.projectSetup != null
      )
        throw new Error("Workspace receipt identity changed");
      ++outcomeGeneration.current;
      setOutcome(metadata.creation);
      if (workspaceCreationReady(metadata.creation))
        await openOutcome(metadata.creation);
      else setFailed(true);
    } catch (error) {
      if (current()) {
        if (
          attemptRef.current &&
          (isUnacceptedWorkspaceName(error) || isWorkspaceCreationGone(error))
        ) {
          try {
            await save({
              ...attemptRef.current,
              ...(isWorkspaceCreationGone(error)
                ? { gone: true }
                : { unaccepted: true }),
            });
          } catch {
            // A failed acknowledgement leaves the original request frozen.
          }
        }
        if (current()) setFailed(true);
      }
    } finally {
      submitting.current = false;
      if (current()) setBusy(false);
    }
  };
  const discardGone = async () => {
    if (!retained.attempt?.gone || busy || !current()) return;
    setBusy(true);
    try {
      await writeGlobalStateConfirmed(state, key, undefined);
      if (!current()) return;
      attemptRef.current = undefined;
      setRetained({ invalid: false, loading: false });
      setOutcome(null);
      setFailed(false);
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const frozen = Boolean(retained.attempt && !retained.attempt.unaccepted);
  const locked = busy || retained.loading || retained.invalid;
  const sourceUnavailable = Boolean(query.error || (query.data && !descriptor));
  const error = failed || retained.invalid || sourceUnavailable;
  const notices = (
    <>
      {frozen ? (
        <Notice tone="warning">
          {retained.attempt?.gone
            ? t["com.myoxus.create-workspace.gone"]()
            : t["com.myoxus.create-workspace.recovery"]()}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error">
          {sourceUnavailable
            ? t["com.myoxus.create-workspace.source-unavailable"]()
            : t["com.myoxus.create-workspace.error.message"]()}
          {sourceUnavailable ? (
            <Button disabled={busy} onClick={() => void query.mutate()}>
              {t.Retry()}
            </Button>
          ) : null}
        </Notice>
      ) : null}
    </>
  );
  const button = (
    <Button
      type="submit"
      form="create-workspace-form"
      variant="primary"
      data-testid={
        frozen && workspaceCreationReady(outcome)
          ? "create-workspace-open-button"
          : "create-workspace-create-button"
      }
      disabled={locked || (!frozen && (!descriptor || Boolean(query.error)))}
      loading={busy || retained.loading || (!frozen && query.isLoading)}
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
  const submit = () => {
    if (retained.attempt?.gone) void discardGone();
    else void apply();
  };
  if (descriptor && query.data && !frozen)
    return (
      <WorkspaceCloudForm
        descriptor={descriptor}
        mode={query.data.assistance.interactiveMode}
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
        onSubmit={(answers) => void apply(answers)}
      >
        {(_answers, _validate, form) => (
          <ConfirmModal
            {...modal}
            persistent={busy}
            cancelButtonOptions={{ disabled: busy }}
            customConfirmButton={() => button}
          >
            {form}
            {notices}
          </ConfirmModal>
        )}
      </WorkspaceCloudForm>
    );
  return (
    <ConfirmModal
      {...modal}
      persistent={busy}
      cancelButtonOptions={{ disabled: busy }}
      customConfirmButton={() => button}
    >
      <form
        id="create-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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

function LocalWorkspaceDialog({
  modal,
  name,
  onNameChange,
  target,
  onCreated,
}: NativeProps) {
  const t = useI18n();
  const workspaces = useService(WorkspacesService);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nameChecked, setNameChecked] = useState(false);
  const completed = useRef<WorkspaceMetadata | null>(null);
  const submitting = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const create = async () => {
    setNameChecked(true);
    if (submitting.current || !name.trim() || !canUseLocalWorkspaces()) return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const metadata =
        completed.current ??
        (await workspaces.create("local", undefined, {
          kind: "local-empty",
          name: name.trim(),
          assistanceMode: AssistanceMode.Guided,
        }));
      completed.current = metadata;
      if (active.current) onCreated(metadata);
    } catch {
      if (active.current) setFailed(true);
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <ConfirmModal
      {...modal}
      persistent={busy}
      cancelButtonOptions={{ disabled: busy }}
      customConfirmButton={() => (
        <Button
          type="submit"
          form="create-local-workspace-form"
          variant="primary"
          data-testid="create-workspace-create-button"
          disabled={busy}
          loading={busy}
        >
          {t.Create()}
        </Button>
      )}
    >
      <form
        id="create-local-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Stack>
          <Input
            autoFocus
            data-autofocus
            required
            maxLength={64}
            disabled={busy || Boolean(completed.current)}
            value={name}
            error={
              nameChecked && !name.trim()
                ? t["com.myoxus.document-metadata.validation.required"]({
                    label:
                      t["com.myoxus.nameWorkspace.subtitle.workspace-name"](),
                  })
                : undefined
            }
            onChange={onNameChange}
            label={t["com.myoxus.nameWorkspace.subtitle.workspace-name"]()}
            data-testid="create-workspace-input"
          />
          {target(busy || Boolean(completed.current))}
          {failed ? (
            <Notice tone="error">
              {t["com.myoxus.create-workspace.error.message"]()}
            </Notice>
          ) : null}
        </Stack>
      </form>
    </ConfirmModal>
  );
}
