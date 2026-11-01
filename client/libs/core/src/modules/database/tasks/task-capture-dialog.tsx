// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AssistantActionFragmentFragment } from "@myoxus/graphql";

import type { TaskReferenceInsertionState } from "./task-reference-insertion";

import { getDatabasePath } from "@myoxus/core/desktop/route-paths";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import type { Server } from "@myoxus/core/modules/server/entities/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  AssistantContext,
  AssistantActionKind,
  AssistantControlKind,
  AssistantGroupRole,
  AssistantInputTarget,
  AssistantValueType,
  type AssistantInputFragmentFragment as AssistantInputFragment,
  databaseSchemaQuery,
  DatabaseTaskCaptureState,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { getArtworkUrl } from "@myoxus/theme/artwork";
import { useService } from "@myoxus/infra";
import {
  Button,
  FormFieldset,
  FormRow,
  Group,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  Popover,
  Stack,
  Textarea,
  ThemedImg,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import useSWR, { SWRConfig } from "swr";
import {
  assistantFormAction,
  AssistantGroups,
  AssistantActions,
} from "../presentation/renderer";
import {
  useAssistantNavigation,
  AssistantNativeDialog,
} from "../presentation/native-form";
import { useAssistantInputDefaults } from "../presentation/use-input-defaults";
import { useAssistantFormValidation } from "../presentation/use-form-validation";
import { useAssistantPresentation } from "../presentation/use-assistant-presentation";
import {
  semanticAssistantAnswers,
  visibleAssistantTargets,
} from "../presentation/semantic-inputs";
import {
  assistantValue,
  assistantText,
  assistantRequiredInputIds,
  assistantVisible,
} from "../presentation/values";
import { managedTaskFields } from "../managed";
import { TaskDestinationFields } from "./task-destination-fields";
import { useCaptureTask } from "./use-capture-task";
import { taskDescriptionCell } from "./use-create-task";
import { useTaskIdentity, useTaskDestinations } from "./use-workspace-tasks";

type Props = DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["task-capture"]>;

export function TaskCaptureDialog(props: Props) {
  const owner = useTaskIdentity();
  const { close } = props;
  // A reopened dialog must authorize its inventory again, even for the same actor.
  const queryCache = useMemo(
    () => (owner.identity ? new Map() : null),
    [owner.identity],
  );
  const openingOwner = useRef(props.openingOwnerIdentity);
  const ownerChanged = owner.identity !== openingOwner.current;
  useEffect(() => {
    if (ownerChanged) close();
  }, [ownerChanged, close]);
  const t = useI18n();
  if (
    ownerChanged ||
    !queryCache ||
    !owner.server ||
    !owner.account ||
    !owner.identity ||
    owner.availability.status !== "available"
  )
    return (
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) props.close();
        }}
        title={t["com.myoxus.database.tasks.capture"]()}
        returnFocusRef={props.returnFocusRef}
      >
        <Notice>{t["com.myoxus.database.embed.unavailable"]()}</Notice>
        <Button onClick={() => props.close()}>{t.Cancel()}</Button>
      </Modal>
    );
  return (
    <SWRConfig key={owner.identity} value={{ provider: () => queryCache }}>
      <CaptureSession
        key={JSON.stringify([owner.identity, props.sourceDocumentId])}
        {...props}
        server={owner.server}
        identity={owner.identity}
        workspaceId={owner.workspace.id}
      />
    </SWRConfig>
  );
}

function CaptureSession({
  close,
  returnFocusRef,
  excerpt,
  sourceExternalId,
  sourceDocumentId,
  blockId,
  selectionAnchor,
  onConfirmed,
  onInsertReference,
  onCaptureReleased,
  server,
  identity,
  workspaceId,
}: Props & { server: Server; identity: string; workspaceId: string }) {
  const t = useI18n();
  const [opened, setOpened] = useState(true);
  const titleId = useId();
  const workbench = useService(WorkbenchService).workbench;
  const projectsRead = useTaskDestinations();
  const projects = projectsRead.readyDestinations;
  const creator = useCaptureTask(
    server,
    workspaceId,
    identity,
    sourceDocumentId,
    excerpt,
    onConfirmed,
  );
  const initialDraft = creator.retained ?? creator.draft;
  // Retained optional fields preserve absence: a new selection cannot retarget recovery.
  const [sourceSnapshot] = useState(() =>
    initialDraft
      ? {
          sourceDocumentId: initialDraft.input.sourceDocumentId,
          sourceExternalId: initialDraft.input.sourceExternalId,
          blockId: initialDraft.input.blockId ?? "",
          selectionAnchor: initialDraft.input.selectionAnchor,
          excerpt: initialDraft.excerpt,
        }
      : {
          sourceDocumentId,
          sourceExternalId,
          blockId,
          selectionAnchor,
          excerpt,
        },
  );
  const sourceExcerpt = sourceSnapshot.excerpt;
  const [projectId, setProjectId] = useState(
    initialDraft?.input.databaseId ?? "",
  );
  const [title, setTitle] = useState(
    initialDraft?.input.title ?? excerpt.split("\n")[0],
  );
  // Recovery reads the frozen initial-cell paragraphs, including blank lines;
  // an omitted Cell is an intentionally empty description, not a fresh excerpt.
  const [descriptionText, setDescriptionText] = useState(() => {
    if (!initialDraft) return sourceExcerpt;
    const document = initialDraft.input.cells.find(
      (cell) => cell.value.richText,
    )?.value.richText?.document as
      { content?: { content?: { text?: string }[] }[] } | undefined;
    return (
      document?.content
        ?.map((paragraph) =>
          (paragraph.content ?? []).map((node) => node.text ?? "").join(""),
        )
        .join("\n") ?? ""
    );
  });
  const [titleError, setTitleError] = useState(false);
  const [activePopup, setActivePopup] = useState<string | null>(null);
  const validProject = projects.some((project) => project.id === projectId);
  const schema = useSWR(
    validProject ? ["task-capture-schema", identity, projectId] : null,
    () =>
      server.gql({
        query: databaseSchemaQuery,
        variables: { workspaceId, databaseId: projectId },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const record = schema.data?.workspace?.database;
  const bindings = managedTaskFields(record);
  const descriptionField = bindings?.get("task.description");
  const ready = Boolean(
    validProject &&
    bindings &&
    (!descriptionText.trim() || descriptionField) &&
    !record?.database.deletedAt &&
    !projectsRead.destinationError &&
    !schema.error &&
    !schema.isLoading,
  );
  useEffect(() => {
    if (projectId || initialDraft) return;
    const destination = projects.find((project) => project.workspaceTasks);
    if (destination) setProjectId(destination.id);
  }, [projectId, initialDraft, projects]);
  const locked = creator.phase !== "draft";
  const pending = creator.phase === "pending";
  const [insertion, setInsertion] = useState<
    TaskReferenceInsertionState | "idle" | "pending"
  >("idle");
  const insertionAttempted = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const insertReference = useCallback(async () => {
    const result = creator.result;
    if (
      !result ||
      result.state !== DatabaseTaskCaptureState.Available ||
      !onInsertReference ||
      insertion === "pending"
    )
      return;
    setInsertion("pending");
    try {
      const state = await onInsertReference(
        result.requestId,
        { workspaceId, databaseId: result.databaseId, rowId: result.rowId },
        {
          sourceDocumentId: sourceSnapshot.sourceDocumentId,
          sourceExternalId: sourceSnapshot.sourceExternalId,
          blockId: sourceSnapshot.blockId,
          selectionAnchor: sourceSnapshot.selectionAnchor,
        },
      );
      if (alive.current) setInsertion(state);
    } catch {
      if (alive.current) setInsertion("uncertain");
    }
  }, [
    creator.result,
    onInsertReference,
    insertion,
    workspaceId,
    sourceSnapshot,
  ]);
  useEffect(() => {
    if (
      !creator.result ||
      insertionAttempted.current === creator.result.requestId
    )
      return;
    insertionAttempted.current = creator.result.requestId;
    void insertReference();
  }, [creator.result, insertReference]);
  const requestClose = () => {
    // An unresolved request survives dismissal in the scoped capture store.
    if (!opened || pending || insertion === "pending") return;
    setActivePopup(null);
    if (
      onInsertReference &&
      (insertion === "failed" || insertion === "uncertain")
    )
      creator.retainForReferenceRecovery();
    else {
      creator.release();
      if (creator.result) onCaptureReleased?.(creator.result.requestId);
    }
    setOpened(false);
  };
  const presentation = useAssistantPresentation(
    AssistantContext.TaskCapture,
    projectId || undefined,
  );
  const descriptor = presentation.descriptor;
  useAssistantInputDefaults(
    descriptor,
    JSON.stringify([identity, projectId]),
    (input, value) => {
      if (input.target === AssistantInputTarget.Title && !title)
        setTitle(value.text ?? "");
    },
  );
  const answers = descriptor
    ? semanticAssistantAnswers(descriptor, {
        [AssistantInputTarget.Title]: assistantValue(AssistantValueType.Text, {
          text: title,
        }),
        ...(projectId
          ? {
              [AssistantInputTarget.Destination]: assistantValue(
                AssistantValueType.DatabaseDestination,
                { databaseId: projectId },
              ),
            }
          : {}),
        [AssistantInputTarget.Description]: assistantValue(
          AssistantValueType.Text,
          { text: descriptionText },
        ),
      })
    : {};
  const submittedTargets = descriptor
    ? visibleAssistantTargets(descriptor, answers)
    : new Set<AssistantInputTarget>();
  const descriptionUnavailable = Boolean(
    descriptionText.trim() &&
    !submittedTargets.has(AssistantInputTarget.Description),
  );
  const validation = useAssistantFormValidation(descriptor, answers);
  const validate: typeof validation.validate = (groups) => {
    const valid = validation.validate(groups);
    if (!valid && descriptor) {
      const first = assistantRequiredInputIds(
        descriptor,
        groups ??
          [
            ...descriptor.presentation.steps,
            ...descriptor.presentation.dialogs,
          ].flatMap((item) => item.groups),
        answers,
      )[0];
      const input = descriptor.inputs.find((input) => input.id === first);
      if (input?.target === AssistantInputTarget.Destination)
        setActivePopup(`input:${input.id}`);
    }
    return valid;
  };
  const submit = () => {
    if (locked || !validate()) return;
    if (!title.trim()) {
      setTitleError(true);
      return;
    }
    if (
      !ready ||
      !descriptor ||
      presentation.invalidated ||
      locked ||
      descriptionUnavailable
    )
      return;
    const descriptionCell =
      submittedTargets.has(AssistantInputTarget.Description) && descriptionField
        ? taskDescriptionCell(descriptionField.id, descriptionText)
        : undefined;
    const cells = descriptionCell ? [descriptionCell] : [];
    // Close optional UI before the native attempt locks its frozen draft.
    setActivePopup(null);
    void creator.submit(
      {
        databaseId: projectId,
        sourceExternalId: sourceSnapshot.sourceExternalId,
        sourceDocumentId: sourceSnapshot.sourceDocumentId,
        blockId: sourceSnapshot.blockId,
        selectionAnchor: sourceSnapshot.selectionAnchor,
        title: title.trim(),
        cells,
      },
      sourceExcerpt,
    );
  };
  const result = creator.result;
  const rowPath = result
    ? `${getDatabasePath(workspaceId, result.databaseId)}?${new URLSearchParams({ rowId: result.rowId })}`
    : null;
  const destinationFields = (
    include: readonly ("destination" | "audience" | "title")[],
    input?: AssistantInputFragment,
    error?: string,
    inputDisabled = false,
  ) => (
    <TaskDestinationFields
      include={include}
      autoFocus={include.includes("title")}
      sourceInputId={input?.id}
      sourceRequired={input?.required}
      sourceError={error}
      destinationLabel={
        input?.target === AssistantInputTarget.Destination
          ? assistantText(input.label, t.language)
          : undefined
      }
      titleLabel={
        input?.target === AssistantInputTarget.Title
          ? assistantText(input.label, t.language)
          : undefined
      }
      audienceText={
        descriptor
          ? assistantText(descriptor.description, t.language)
          : undefined
      }
      projects={projects}
      projectId={projectId}
      onProjectChange={setProjectId}
      title={title}
      onTitleChange={(value) => {
        setTitle(value);
        setTitleError(false);
      }}
      titleId={titleId}
      titleError={titleError}
      disabled={
        inputDisabled ||
        locked ||
        projectsRead.isLoading ||
        Boolean(projectsRead.destinationError)
      }
    />
  );
  const optionalEditor = (
    key: string,
    label: string,
    content: ReactNode,
    input?: AssistantInputFragment,
    error?: string,
    disabled = false,
  ) => (
    <Popover
      open={activePopup === key}
      onOpenChange={(opened) => {
        if (locked) return;
        setActivePopup((current) =>
          opened ? key : current === key ? null : current,
        );
      }}
      trapFocus
      returnFocus
      closeOnEscape
      content={content}
    >
      <Button
        type="button"
        variant="plain"
        data-assistant-input={input?.id}
        aria-label={input ? assistantText(input.label, t.language) : label}
        aria-invalid={Boolean(error)}
        tooltip={error}
        disabled={disabled || locked}
        onClick={() => {
          if (disabled || locked) return;
          setActivePopup((current) => (current === key ? null : key));
        }}
      >
        {label}
      </Button>
    </Popover>
  );
  const nativeAdapters: Parameters<typeof AssistantGroups>[0]["adapters"] = {
    control: (control) => {
      if (control.kind === AssistantControlKind.DestinationAudience)
        return null;
      if (control.kind === AssistantControlKind.SourceOrigin)
        return optionalEditor(
          "source",
          t["com.myoxus.database.tasks.capture-excerpt"](),
          <Stack>
            <Notice tone="warning">
              {t["com.myoxus.database.tasks.capture-audience"]()}
            </Notice>
            <MyoxusText preserveWhitespace>{sourceExcerpt}</MyoxusText>
          </Stack>,
        );
      return undefined;
    },
    input: ({ input, error, disabled }) => {
      if (input.target === AssistantInputTarget.Destination) {
        const destination = projects.find(
          (project) => project.id === projectId,
        );
        return optionalEditor(
          `input:${input.id}`,
          destination
            ? destination.workspaceTasks
              ? t["com.myoxus.database.tasks.workspace-tasks"]()
              : destination.title
            : assistantText(input.label, t.language),
          <Stack>
            {destinationFields(["destination"], input, error, disabled)}
            {navigation.step?.groups.some(
              (group) =>
                assistantVisible(group.visibleWhen, answers) &&
                group.controls.some(
                  (control) =>
                    control.kind === AssistantControlKind.DestinationAudience,
                ),
            )
              ? destinationFields(["audience"])
              : null}
          </Stack>,
          input,
          error,
          disabled ||
            projectsRead.isLoading ||
            Boolean(projectsRead.destinationError),
        );
      }
      if (input.target === AssistantInputTarget.Title)
        return destinationFields(["title"], input, error, disabled);
      if (input.target === AssistantInputTarget.Description)
        return (
          <FormRow
            data-assistant-input={input.id}
            label={assistantText(input.label, t.language)}
            labelFor={`${titleId}-description`}
            error={error}
          >
            <Textarea
              id={`${titleId}-description`}
              rows={4}
              value={descriptionText}
              onChange={setDescriptionText}
              disabled={disabled || locked}
              required={input.required}
            />
          </FormRow>
        );
      return undefined;
    },
  };
  const actionDisabled = (action: AssistantActionFragmentFragment) =>
    action.action === AssistantActionKind.Next ||
    action.action === AssistantActionKind.Back
      ? locked
      : action.action === AssistantActionKind.CaptureTask &&
        (!ready || locked || descriptionUnavailable);
  const navigation = useAssistantNavigation(
    descriptor,
    (action) => {
      if (
        action.action === AssistantActionKind.Cancel ||
        action.action === AssistantActionKind.Close
      )
        requestClose();
      else if (action.action === AssistantActionKind.CaptureTask) submit();
      else if (action.action === AssistantActionKind.Check)
        void creator.review();
    },
    pending || insertion === "pending",
    validate,
  );
  return (
    <Modal
      open={opened}
      // Keep the durable opener reachable until Mantine finishes restoring focus.
      onExitTransitionEnd={close}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      persistent={pending || insertion === "pending" || activePopup !== null}
      title={
        <Group>
          {/* Preserve the illustration's aspect ratio at the themed heading scale. */}
          <ThemedImg
            lightSrc={getArtworkUrl("assistant-first-task")}
            alt=""
            style={{ height: "var(--mantine-h1-font-size)", width: "auto" }}
          />
          {t["com.myoxus.database.tasks.capture"]()}
        </Group>
      }
      returnFocusRef={returnFocusRef}
      scrollable
      contentOptions={{ "data-testid": "task-capture-modal" }}
    >
      <form
        ref={validation.formRef}
        onSubmit={(event) => {
          event.preventDefault();
          if (locked) return;
          const action = assistantFormAction(
            navigation.step?.actions ?? [],
            answers,
          );
          if (action) navigation.act(action);
        }}
        noValidate
      >
        <Stack>
          <FormFieldset variant="unstyled" disabled={locked}>
            <Stack>
              {!projectsRead.isLoading &&
              (!projectsRead.defaultDestination ||
                projectsRead.defaultDestination.managedSchema.readiness !==
                  "Ready") ? (
                <Notice tone="warning">
                  {t["com.myoxus.database.tasks.default-unavailable"]()}
                  <Button
                    type="button"
                    onClick={() => void projectsRead.mutate()}
                  >
                    {t.Retry()}
                  </Button>
                </Notice>
              ) : null}
              {projectsRead.nextCursor ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void projectsRead.loadMore()}
                >
                  {t["com.myoxus.database.load-more"]()}
                </Button>
              ) : null}
              {presentation.isLoading ? (
                <Loading />
              ) : descriptor ? (
                <AssistantGroups
                  descriptor={descriptor}
                  stepId={navigation.step?.id}
                  artworkServer={server}
                  invalidInputs={validation.invalidInputs}
                  groups={navigation.step?.groups ?? []}
                  answers={answers}
                  disabled={locked}
                  adapters={nativeAdapters}
                  grouped={false}
                  renderGroup={(group, children) =>
                    group.role === AssistantGroupRole.More ? (
                      <Group>{children}</Group>
                    ) : (
                      <Stack>
                        {group.title ? (
                          <MyoxusText>
                            {assistantText(group.title, t.language)}
                          </MyoxusText>
                        ) : null}
                        {children}
                      </Stack>
                    )
                  }
                  onAnswer={(input, value) => {
                    if (input.target === AssistantInputTarget.Description)
                      setDescriptionText(value?.text ?? "");
                  }}
                />
              ) : presentation.isLoading ? (
                <Loading />
              ) : (
                <Notice tone="warning">
                  <Button
                    type="button"
                    onClick={() => void presentation.mutate()}
                  >
                    {t.Retry()}
                  </Button>
                </Notice>
              )}
              {projectsRead.isLoading || schema.isLoading ? <Loading /> : null}
              {projectsRead.error || schema.error ? (
                <Notice tone="error">
                  <Button
                    type="button"
                    onClick={() => {
                      void projectsRead.mutate();
                      void schema.mutate();
                    }}
                  >
                    {t.Retry()}
                  </Button>
                </Notice>
              ) : null}
            </Stack>
          </FormFieldset>
          {creator.failure ? (
            <Notice tone="error">
              {creator.failure === "preparation"
                ? t["com.myoxus.database.tasks.capture-preparation-failed"]()
                : creator.failure === "forbidden"
                  ? t["com.myoxus.database.row_detail.forbidden"]()
                  : creator.failure === "conflict"
                    ? t["com.myoxus.database.tasks.capture-conflict"]()
                    : t["com.myoxus.database.tasks.create-invalid"]()}
            </Notice>
          ) : null}
          {creator.phase === "uncertain" ? (
            <Notice tone="warning" data-testid="task-capture-uncertain">
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.database.tasks.create-uncertain"]()}
                </MyoxusText>
                <Group>
                  <Button
                    type="button"
                    disabled={creator.checking}
                    onClick={() => void creator.review()}
                  >
                    {t["com.myoxus.database.tasks.check-created"]()}
                  </Button>
                  <Button
                    type="button"
                    disabled={creator.checking}
                    onClick={() => void creator.replay()}
                  >
                    {t["com.myoxus.database.tasks.capture-replay"]()}
                  </Button>
                </Group>
                {creator.reviewFailed ? (
                  <MyoxusText>
                    {t["com.myoxus.database.embed.unavailable"]()}
                  </MyoxusText>
                ) : null}
              </Stack>
            </Notice>
          ) : null}
          {insertion === "pending" ? <Loading /> : null}
          {insertion === "failed" || insertion === "uncertain" ? (
            <Notice tone="warning">
              <MyoxusText>
                {t["com.myoxus.database.tasks.reference-insert-failed"]()}
              </MyoxusText>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void insertReference()}
              >
                {t["com.myoxus.database.tasks.insert-reference"]()}
              </Button>
            </Notice>
          ) : null}
          {result ? (
            <Notice data-testid="task-capture-confirmed">
              <Stack>
                <MyoxusText>
                  {result.state === DatabaseTaskCaptureState.Available
                    ? t["com.myoxus.database.tasks.capture-confirmed"]()
                    : t["com.myoxus.database.row_detail.unavailable"]()}
                </MyoxusText>
                {result.record ? (
                  <MyoxusText>{result.record.row.title}</MyoxusText>
                ) : null}
                {result.state === DatabaseTaskCaptureState.Available &&
                rowPath ? (
                  <Group>
                    <Button
                      type="button"
                      disabled={insertion === "pending"}
                      onClick={() => {
                        workbench.open(
                          `/databases/${result.databaseId}?${new URLSearchParams({ rowId: result.rowId })}`,
                          { at: "active" },
                        );
                        requestClose();
                      }}
                    >
                      {t["com.myoxus.database.tasks.open-task"]()}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        void copyTextToClipboard(
                          new URL(rowPath, server.baseUrl).toString(),
                        )
                      }
                    >
                      {t["com.myoxus.editor.toolbar.copy-link"]()}
                    </Button>
                  </Group>
                ) : null}
              </Stack>
            </Notice>
          ) : null}
          {descriptor ? (
            <AssistantActions
              submitActionId={
                assistantFormAction(navigation.step?.actions ?? [], answers)?.id
              }
              actions={(navigation.step?.actions ?? []).filter((action) =>
                result
                  ? action.action === AssistantActionKind.Close
                  : action.action === AssistantActionKind.Cancel ||
                    action.action === AssistantActionKind.CaptureTask ||
                    action.action === AssistantActionKind.Next ||
                    action.action === AssistantActionKind.Back,
              )}
              answers={answers}
              busy={pending || insertion === "pending"}
              disabled={actionDisabled}
              onAction={navigation.act}
            />
          ) : (
            <Button
              type="button"
              disabled={pending || insertion === "pending"}
              onClick={requestClose}
            >
              {result ? t["com.myoxus.peek-view-controls.close"]() : t.Cancel()}
            </Button>
          )}
        </Stack>
      </form>
      {descriptor && navigation.dialog ? (
        <AssistantNativeDialog
          descriptor={descriptor}
          dialog={navigation.dialog}
          actionDisabled={actionDisabled}
          invalidInputs={validation.invalidInputs}
          dialogRef={validation.dialogRef}
          answers={answers}
          adapters={nativeAdapters}
          disabled={locked}
          busy={pending || insertion === "pending"}
          onClose={navigation.closeDialog}
          onAction={(action) => navigation.act(action, true)}
        />
      ) : null}
    </Modal>
  );
}
