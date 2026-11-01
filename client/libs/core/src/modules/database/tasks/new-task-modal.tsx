// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AssistantActionFragmentFragment } from "@myoxus/graphql";

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import type { Server } from "@myoxus/core/modules/server/entities/server";
import {
  AssistantContext,
  AssistantActionKind,
  AssistantControlKind,
  AssistantGroupRole,
  AssistantInputTarget,
  AssistantValueType,
  type AssistantInputFragmentFragment as AssistantInputFragment,
  databaseSchemaQuery,
  DatabaseTaskScope,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormFieldset,
  FormRow,
  FormSelect,
  Group,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";

import { TaskDueInput } from "../cells/task-due-input";
import { databaseZonedDateTime } from "../shared/schedule";
import { scheduleWallTimeToInstant } from "../shared/schedule-values";
import {
  useCreateTask,
  taskDescriptionCell,
  type CreatedTask,
  type TaskCreationCell,
} from "./use-create-task";
import {
  useAssistantNavigation,
  AssistantNativeDialog,
} from "../presentation/native-form";
import {
  assistantFormAction,
  AssistantGroups,
  AssistantActions,
} from "../presentation/renderer";
import { assistantValue, assistantText } from "../presentation/values";
import {
  semanticAssistantAnswers,
  visibleAssistantTargets,
} from "../presentation/semantic-inputs";
import { useAssistantInputDefaults } from "../presentation/use-input-defaults";
import { useAssistantFormValidation } from "../presentation/use-form-validation";
import { useAssistantPresentation } from "../presentation/use-assistant-presentation";
import { TaskDestinationFields } from "./task-destination-fields";
import { managedTaskFields } from "../managed";
import { useTaskIdentity, type TaskDestination } from "./use-workspace-tasks";

type Project = TaskDestination;
type Props = {
  open: boolean;
  scope?: DatabaseTaskScope;
  projects: Project[];
  destinationsUnavailable: boolean;
  onLoadMoreProjects?: () => void;
  projectsLoading: boolean;
  projectsError: boolean;
  onRetryProjects: () => void;
  returnToHome: boolean;
  initialProjectId?: string;
  onClose: () => void;
  onCreated: (task: CreatedTask) => void;
  onOpenTask: (task: CreatedTask) => void;
  onOpenProject: (databaseId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
};

export function NewTaskModal(props: Props) {
  const { workspace, server, account, availability, identity } =
    useTaskIdentity();
  if (availability.status !== "available" || !server || !account || !identity)
    return null;
  return (
    <TaskCreationSession
      key={identity}
      {...props}
      identity={identity}
      actorId={account.id}
      server={server}
      workspaceId={workspace.id}
    />
  );
}

function TaskCreationSession({
  open,
  scope,
  projects,
  destinationsUnavailable,
  onLoadMoreProjects,
  projectsLoading,
  projectsError,
  onRetryProjects,
  returnToHome,
  initialProjectId,
  onClose,
  onCreated,
  onOpenTask,
  onOpenProject,
  returnFocusRef,
  identity,
  actorId,
  server,
  workspaceId,
}: Props & {
  identity: string;
  actorId: string;
  server: Server;
  workspaceId: string;
}) {
  const t = useI18n();
  const id = useId();
  const actorTimeZone = useRegionalPreferences().timezone;
  const [projectId, setProjectId] = useState(
    projects.some((p) => p.id === initialProjectId)
      ? initialProjectId!
      : (projects.find((p) => p.workspaceTasks)?.id ?? ""),
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const editedInputs = useRef(new Set<AssistantInputTarget>());
  const assigneeDefaultsOwner = useRef<string | null>(null);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [wallTime, setWallTime] = useState<string | null>(null);
  const [allDay, setAllDay] = useState(true);
  const [defaultDueTimeZone, setDefaultDueTimeZone] = useState<string | null>(
    null,
  );
  const [titleError, setTitleError] = useState(false);
  const [discardRequested, setDiscardRequested] = useState(false);
  const validProject = projects.some((project) => project.id === projectId);
  const schema = useSWR(
    validProject ? ["task-create-schema", identity, projectId] : null,
    () =>
      server.gql({
        query: databaseSchemaQuery,
        variables: { workspaceId, databaseId: projectId },
      }),
    { suspense: false, keepPreviousData: false },
  );
  const record = schema.data?.workspace?.database;
  const bindings = managedTaskFields(record);
  const ready = Boolean(
    bindings &&
    !record?.database.deletedAt &&
    validProject &&
    !schema.error &&
    (!description.trim() || Boolean(bindings.get("task.description"))),
  );
  const descriptionField = bindings?.get("task.description");
  const assigneesField = bindings?.get("task.assignees");
  const dueField = bindings?.get("task.dueDate");
  const hasAssignees = Boolean(assigneesField);
  const hasDue = Boolean(dueField);
  const timeZone =
    defaultDueTimeZone ??
    dueField?.config.dateTime?.defaultTimeZone ??
    actorTimeZone;
  const dueStart = wallTime
    ? scheduleWallTimeToInstant(
        allDay ? `${wallTime.slice(0, 10)} 00:00:00` : wallTime,
        timeZone,
      )
    : null;
  const creator = useCreateTask({
    server,
    identity,
    workspaceId,
    databaseId: projectId,
    timeZone,
    onCreated,
  });
  const pending = creator.phase === "pending";
  const locked =
    pending || creator.phase === "uncertain" || creator.phase === "confirmed";
  const requestClose = () => {
    if (pending) return;
    if (returnToHome && creator.phase === "uncertain") {
      setDiscardRequested(true);
      return;
    }
    onClose();
  };
  useEffect(() => {
    if (!open || creator.phase !== "uncertain") setDiscardRequested(false);
  }, [open, creator.phase]);
  const changeProject = (value: string) => {
    if (value === projectId || locked) return;
    setProjectId(value);
    if (!editedInputs.current.has(AssistantInputTarget.Due))
      setDefaultDueTimeZone(null);
    setTitleError(false);
  };
  useEffect(() => {
    if (!open || projectId) return;
    const preferred =
      projects.find((project) => project.id === initialProjectId) ??
      projects.find((project) => project.workspaceTasks);
    if (preferred) setProjectId(preferred.id);
  }, [open, projectId, initialProjectId, projects]);
  const presentation = useAssistantPresentation(
    AssistantContext.TaskCreation,
    projectId || undefined,
  );
  const descriptor = presentation.descriptor;
  useAssistantInputDefaults(
    open ? descriptor : null,
    JSON.stringify([identity, projectId]),
    (input, value) => {
      // Destination defaults may initialize untouched fields, never erase a draft.
      if (editedInputs.current.has(input.target)) return;
      if (input.target === AssistantInputTarget.Title && !title)
        setTitle(value.text ?? "");
      if (input.target === AssistantInputTarget.Description)
        setDescription(value.text ?? "");
      if (input.target === AssistantInputTarget.Assignees)
        setAssignees(value.memberIds ?? []);
      if (input.target === AssistantInputTarget.Due && value.dateTime) {
        setAllDay(value.dateTime.allDay);
        setDefaultDueTimeZone(value.dateTime.timeZone);
        setWallTime(
          databaseZonedDateTime(value.dateTime.start, value.dateTime.timeZone),
        );
      }
    },
  );
  useEffect(() => {
    if (!open || !descriptor) return;
    const owner = JSON.stringify([identity, projectId]);
    if (assigneeDefaultsOwner.current === owner) return;
    assigneeDefaultsOwner.current = owner;
    const input = descriptor.inputs.find(
      (input) => input.target === AssistantInputTarget.Assignees,
    );
    // Explicit package defaults, including an empty selection, take precedence.
    if (
      input &&
      !input.defaultValue &&
      scope === DatabaseTaskScope.Mine &&
      !editedInputs.current.has(AssistantInputTarget.Assignees)
    )
      setAssignees([actorId]);
  }, [open, descriptor, identity, projectId, scope, actorId]);
  const answers = descriptor
    ? semanticAssistantAnswers(descriptor, {
        [AssistantInputTarget.Title]: assistantValue(AssistantValueType.Text, {
          text: title,
        }),
        [AssistantInputTarget.Description]: assistantValue(
          AssistantValueType.Text,
          { text: description },
        ),
        ...(projectId
          ? {
              [AssistantInputTarget.Destination]: assistantValue(
                AssistantValueType.DatabaseDestination,
                { databaseId: projectId },
              ),
            }
          : {}),
        [AssistantInputTarget.Assignees]: assistantValue(
          AssistantValueType.Members,
          { memberIds: assignees },
        ),
        ...(dueStart
          ? {
              [AssistantInputTarget.Due]: assistantValue(
                AssistantValueType.DateTime,
                { dateTime: { start: dueStart, end: null, allDay, timeZone } },
              ),
            }
          : {}),
      })
    : {};
  const submittedTargets = descriptor
    ? visibleAssistantTargets(descriptor, answers)
    : new Set<AssistantInputTarget>();
  const validation = useAssistantFormValidation(descriptor, answers);
  const validate = validation.validate;
  const submit = () => {
    if (locked || !validate()) return;
    if (!title.trim()) {
      setTitleError(true);
      document.getElementById(`${id}-title`)?.focus();
      return;
    }
    if (
      !ready ||
      !descriptor ||
      presentation.invalidated ||
      (submittedTargets.has(AssistantInputTarget.Due) && wallTime && !dueStart)
    )
      return;
    const cells: TaskCreationCell[] = [];
    if (
      submittedTargets.has(AssistantInputTarget.Description) &&
      descriptionField
    ) {
      const cell = taskDescriptionCell(descriptionField.id, description);
      if (cell) cells.push(cell);
    }
    if (
      submittedTargets.has(AssistantInputTarget.Assignees) &&
      hasAssignees &&
      assignees.length
    )
      cells.push({ fieldId: assigneesField!.id, value: { users: assignees } });
    if (submittedTargets.has(AssistantInputTarget.Due) && hasDue && dueStart)
      cells.push({
        fieldId: dueField!.id,
        value: { dateTime: { start: dueStart, end: null, allDay, timeZone } },
      });
    void creator.submit({
      title,
      templateId: "",
      cells,
    });
  };
  const destinationFields = (
    include: readonly ("destination" | "audience" | "title")[],
    input?: AssistantInputFragment,
    error?: string,
    inputDisabled = false,
  ) => (
    <TaskDestinationFields
      include={include}
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
      onProjectChange={changeProject}
      title={title}
      onTitleChange={(value) => {
        setTitle(value);
        setTitleError(false);
      }}
      titleId={`${id}-title`}
      titleError={titleError}
      disabled={inputDisabled || locked}
      autoFocus
    />
  );
  const nativeAdapters: Parameters<typeof AssistantGroups>[0]["adapters"] = {
    control: (control) =>
      control.kind === AssistantControlKind.DestinationAudience
        ? null
        : undefined,
    input: ({ input, error, disabled }) => {
      const editor = (() => {
        switch (input.target) {
          case AssistantInputTarget.Destination:
            return (
              <FormSelect
                data-assistant-input={input.id}
                required={input.required}
                error={error}
                label={t["com.myoxus.database.template.profile.project"]()}
                value={projectId || null}
                data={projects.map((project) => ({
                  value: project.id,
                  label: project.workspaceTasks
                    ? t["com.myoxus.common.without-project"]()
                    : project.title,
                }))}
                onChange={changeProject}
                allowDeselect={false}
                searchable
                disabled={disabled || locked}
              />
            );
          case AssistantInputTarget.Title:
            return destinationFields(["title"], input, error, disabled);
          case AssistantInputTarget.Description:
            return (
              <FormRow
                data-assistant-input={input.id}
                label={assistantText(input.label, t.language)}
                labelFor={`${id}-description`}
                error={error}
              >
                <Textarea
                  id={`${id}-description`}
                  rows={4}
                  value={description}
                  onChange={(value) => {
                    editedInputs.current.add(input.target);
                    setDescription(value);
                  }}
                  disabled={disabled || locked}
                  required={input.required}
                />
              </FormRow>
            );
          case AssistantInputTarget.Assignees:
            return (
              <FormRow
                data-assistant-input={input.id}
                error={error}
                label={assistantText(input.label, t.language)}
              >
                {hasAssignees ? (
                  <MemberSelectorInline
                    selected={assignees}
                    placeholder={t.Select()}
                    onChange={(value) => {
                      editedInputs.current.add(input.target);
                      setAssignees(value);
                    }}
                    readonly={disabled || locked}
                  />
                ) : (
                  <MyoxusText>
                    {t["com.myoxus.template-list.unavailable"]()}
                  </MyoxusText>
                )}
              </FormRow>
            );
          case AssistantInputTarget.Due:
            return (
              <FormRow
                data-assistant-input={input.id}
                label={assistantText(input.label, t.language)}
                error={
                  error ??
                  (wallTime && !dueStart
                    ? t["com.myoxus.database.tasks.invalid-date"]()
                    : undefined)
                }
              >
                {hasDue ? (
                  <TaskDueInput
                    value={{ wallTime, allDay }}
                    onChange={(value) => {
                      editedInputs.current.add(input.target);
                      setWallTime(value.wallTime);
                      setAllDay(value.allDay);
                    }}
                    timeZone={timeZone}
                    label={assistantText(input.label, t.language)}
                    disabled={disabled || locked}
                    popoverProps={{ withinPortal: false }}
                  />
                ) : (
                  <MyoxusText>
                    {t["com.myoxus.template-list.unavailable"]()}
                  </MyoxusText>
                )}
              </FormRow>
            );
          default:
            return undefined;
        }
      })();
      return editor;
    },
  };
  const actionDisabled = (action: AssistantActionFragmentFragment) =>
    action.action === AssistantActionKind.Next ||
    action.action === AssistantActionKind.Back
      ? locked
      : action.action === AssistantActionKind.CreateTask &&
        (!ready ||
          locked ||
          (submittedTargets.has(AssistantInputTarget.Due) &&
            Boolean(wallTime && !dueStart)));
  const navigation = useAssistantNavigation(
    descriptor,
    (action) => {
      if (
        action.action === AssistantActionKind.Cancel ||
        action.action === AssistantActionKind.Close
      )
        requestClose();
      else if (action.action === AssistantActionKind.CreateTask) submit();
      else if (action.action === AssistantActionKind.Check)
        void creator.review();
    },
    pending,
    validate,
  );
  return (
    <Modal
      open={open}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      persistent={pending}
      title={t["com.myoxus.database.tasks.new"]()}
      returnFocusRef={returnFocusRef}
      scrollable
      contentOptions={{ "data-testid": "task-creation-modal" }}
    >
      <form
        ref={validation.formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (locked) return;
          const action = assistantFormAction(
            navigation.step?.actions ?? [],
            answers,
          );
          if (action) navigation.act(action);
        }}
      >
        <Stack>
          <FormFieldset variant="unstyled" disabled={locked}>
            <Stack>
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
                      <Stack>{children}</Stack>
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
              {onLoadMoreProjects ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onLoadMoreProjects}
                >
                  {t["com.myoxus.database.load-more"]()}
                </Button>
              ) : null}
              {destinationsUnavailable ? (
                <Notice tone="warning">
                  {t["com.myoxus.database.tasks.default-unavailable"]()}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={onRetryProjects}
                  >
                    {t.Retry()}
                  </Button>
                </Notice>
              ) : null}
              {projectsLoading ? <Loading /> : null}
              {projectsError ? (
                <Notice tone="error">
                  <Stack>
                    <MyoxusText>
                      {t["com.myoxus.database.embed.unavailable"]()}
                    </MyoxusText>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={onRetryProjects}
                    >
                      {t.Retry()}
                    </Button>
                  </Stack>
                </Notice>
              ) : null}
              {validProject && schema.isLoading ? <Loading /> : null}
              {schema.error || (validProject && !schema.isLoading && !ready) ? (
                <Notice tone="error">
                  {t["com.myoxus.database.embed.unavailable"]()}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      void schema.mutate();
                    }}
                  >
                    {t.Retry()}
                  </Button>
                </Notice>
              ) : null}
            </Stack>
          </FormFieldset>
          {creator.failure && creator.phase !== "uncertain" ? (
            <Notice tone="error">
              <Stack>
                <MyoxusText>
                  {creator.failure === "required"
                    ? t["com.myoxus.database.tasks.create-required"]()
                    : t["com.myoxus.database.tasks.create-invalid"]()}
                </MyoxusText>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => onOpenProject(projectId)}
                >
                  {projects.find((project) => project.id === projectId)
                    ?.workspaceTasks
                    ? t["com.myoxus.database.tasks.open-overview"]()
                    : t["com.myoxus.database.tasks.open-project"]()}
                </Button>
              </Stack>
            </Notice>
          ) : null}
          {discardRequested ? (
            <Notice tone="warning">
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.database.tasks.discard-uncertain"]()}
                </MyoxusText>
                <Group>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setDiscardRequested(false)}
                  >
                    {t.Cancel()}
                  </Button>
                  <Button type="button" variant="primary" onClick={onClose}>
                    {t["com.myoxus.database.tasks.discard-draft"]()}
                  </Button>
                </Group>
              </Stack>
            </Notice>
          ) : null}
          {creator.phase === "uncertain" ? (
            <Notice tone="warning" data-testid="task-create-uncertain">
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.database.tasks.create-uncertain"]()}
                </MyoxusText>
                <MyoxusText>
                  {t["com.myoxus.database.tasks.create-invalid"]()}
                </MyoxusText>
                <Group>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={creator.checking}
                    onClick={() => void creator.review()}
                  >
                    {t["com.myoxus.database.tasks.check-created"]()}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => onOpenProject(projectId)}
                  >
                    {projects.find((project) => project.id === projectId)
                      ?.workspaceTasks
                      ? t["com.myoxus.database.tasks.open-overview"]()
                      : t["com.myoxus.database.tasks.open-project"]()}
                  </Button>
                </Group>
                {creator.reviewFailed ? (
                  <MyoxusText>
                    {t["com.myoxus.database.embed.unavailable"]()}
                  </MyoxusText>
                ) : null}
                {creator.candidates.map((task) => (
                  <Button
                    key={task.rowId}
                    type="button"
                    variant="secondary"
                    onClick={() => onOpenTask(task)}
                  >
                    {task.title}
                  </Button>
                ))}
                {creator.checked ? (
                  <>
                    <MyoxusText>
                      {t["com.myoxus.database.tasks.review-count"]({
                        shown: creator.candidates.length.toLocaleString(
                          t.language,
                        ),
                        total: creator.reviewCount.toLocaleString(t.language),
                      })}
                    </MyoxusText>
                    <MyoxusText>
                      {t["com.myoxus.database.tasks.review-before-retry"]()}
                    </MyoxusText>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={creator.allowAnotherAttempt}
                    >
                      {t["com.myoxus.database.tasks.prepare-another"]()}
                    </Button>
                  </>
                ) : null}
              </Stack>
            </Notice>
          ) : null}
          {descriptor ? (
            <AssistantActions
              submitActionId={
                assistantFormAction(navigation.step?.actions ?? [], answers)?.id
              }
              actions={(navigation.step?.actions ?? []).filter(
                (action) =>
                  action.action === AssistantActionKind.Cancel ||
                  action.action === AssistantActionKind.Next ||
                  action.action === AssistantActionKind.Back ||
                  action.action === AssistantActionKind.CreateTask,
              )}
              answers={answers}
              busy={pending}
              disabled={actionDisabled}
              onAction={navigation.act}
            />
          ) : (
            <Button type="button" disabled={pending} onClick={requestClose}>
              {t.Cancel()}
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
          busy={pending}
          onClose={navigation.closeDialog}
          onAction={(action) => navigation.act(action, true)}
        />
      ) : null}
    </Modal>
  );
}
