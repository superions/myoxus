// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AssistantActionFragmentFragment } from "@myoxus/graphql";

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Button,
  FormRow,
  Group,
  Input,
  Loading,
  MyoxusText,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { taskParentReason } from "../relation/task-parent-reason";
import {
  type CreatedTask,
  type TaskCreationRetentionSlot,
  taskCreationOwnerKey,
  useCreateTask,
} from "./use-create-task";
import {
  AssistantContext,
  AssistantInputTarget,
  AssistantValueType,
  AssistantActionKind,
} from "@myoxus/graphql";
import {
  assistantFormAction,
  AssistantGroups,
  AssistantActions,
} from "../presentation/renderer";
import { useAssistantFormValidation } from "../presentation/use-form-validation";
import { useAssistantPresentation } from "../presentation/use-assistant-presentation";
import {
  useAssistantNavigation,
  AssistantNativeDialog,
} from "../presentation/native-form";
import { useAssistantInputDefaults } from "../presentation/use-input-defaults";
import { semanticAssistantAnswers } from "../presentation/semantic-inputs";
import { assistantValue, assistantText } from "../presentation/values";
import { useTaskIdentity } from "./use-workspace-tasks";
import { TaskDetailNavigationContext } from "../row-detail/task-navigation";

export function NewSubtask({
  databaseId,
  parentRowId,
  fieldId,
  disabled,
  onCreated,
  onOpen,
  retention,
  focusRequest = 0,
  onCancel,
}: {
  databaseId: string;
  parentRowId: string;
  fieldId: string;
  disabled: boolean;
  onCreated: (task: CreatedTask) => void;
  onOpen: (task: CreatedTask) => void;
  retention?: TaskCreationRetentionSlot;
  focusRequest?: number;
  onCancel?: () => void;
}) {
  const owner = useTaskIdentity();
  const taskNavigation = useContext(TaskDetailNavigationContext);
  const workspace = useService(WorkspaceService);
  const servers = useService(WorkspaceServerService);
  const t = useI18n();
  const timeZone = useRegionalPreferences().timezone;
  const creationOwner = taskCreationOwnerKey(
    owner.identity ?? "",
    databaseId,
    parentRowId,
  );
  const restored =
    retention?.current?.owner === creationOwner ? retention.current : undefined;
  const [title, setTitle] = useState(
    restored && restored.phase !== "confirmed" ? restored.draft.title : "",
  );
  const titleId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const current = useCallback(() => {
    const server = servers.server$.value;
    return Boolean(
      owner.identity &&
      server &&
      JSON.stringify([
        server.id,
        server.baseUrl,
        server.account$.value?.id,
        workspace.workspace.id,
      ]) === owner.identity,
    );
  }, [servers, workspace, owner.identity]);
  const creator = useCreateTask({
    server: owner.server!,
    identity: owner.identity ?? "",
    workspaceId: owner.workspace.id,
    databaseId,
    timeZone,
    isCurrent: current,
    creationScope: parentRowId,
    retention,
    onCreated: (task) => {
      validation.reset();
      setTitle("");
      onCreated(task);
      creator.prepareNext();
    },
  });
  useEffect(() => {
    if (creator.phase === "draft" && creator.failure && !disabled && current())
      titleInput.current?.focus();
  }, [
    creator.phase,
    creator.failure,
    creator.relationReason,
    disabled,
    current,
  ]);
  const otherPending = creator.blockedByRetainedAttempt;
  const locked =
    otherPending ||
    disabled ||
    creator.phase === "pending" ||
    creator.phase === "uncertain";
  const presentation = useAssistantPresentation(
    AssistantContext.TaskSubtask,
    databaseId,
    parentRowId,
  );
  const descriptor = presentation.descriptor;
  const admitted = Boolean(
    descriptor &&
    !presentation.invalidated &&
    presentation.projection?.databaseId === databaseId,
  );
  const focusedRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (
      !admitted ||
      disabled ||
      !current() ||
      focusedRequest.current === focusRequest ||
      !titleInput.current
    )
      return;
    titleInput.current.focus();
    focusedRequest.current = focusRequest;
  }, [admitted, disabled, current, focusRequest]);
  useAssistantInputDefaults(descriptor, creationOwner, (input, value) => {
    if (input.target === AssistantInputTarget.Title && !title)
      setTitle(value.text ?? "");
  });
  const answers = descriptor
    ? semanticAssistantAnswers(descriptor, {
        [AssistantInputTarget.Title]: assistantValue(AssistantValueType.Text, {
          text: title,
        }),
      })
    : {};
  const validation = useAssistantFormValidation(descriptor, answers);
  const draft = (nextTitle: string) => ({
    title: nextTitle,
    templateId: "",
    cells: [{ fieldId, value: { relation: [parentRowId] } }],
  });
  const submit = async (): Promise<boolean> => {
    if (locked || !validation.validate()) return false;
    if (!admitted || !current() || !title.trim()) return false;
    return creator.submit(draft(title));
  };
  const discard = () => {
    if (!creator.discardDraft()) return;
    validation.reset();
    setTitle("");
    onCancel?.();
  };
  const registerEditor = taskNavigation?.registerEditor;
  const editorActions = useRef({ apply: submit, discard });
  editorActions.current = { apply: submit, discard };
  const dirty = creator.phase === "draft" && title.length > 0;
  const pending = creator.phase === "pending";
  const ownsEditor = useRef(false);
  useEffect(() => {
    if (dirty || pending) {
      ownsEditor.current = true;
      registerEditor?.({
        dirty,
        pending,
        apply: () => editorActions.current.apply(),
        discard: () => editorActions.current.discard(),
      });
    } else if (ownsEditor.current) {
      ownsEditor.current = false;
      registerEditor?.(null);
    }
  }, [registerEditor, dirty, pending]);
  // Successful Apply may unmount this editor before its Promise resolves;
  // the existing navigation owner permits that cleanup for the same Row.
  useEffect(
    () => () => {
      if (ownsEditor.current) {
        ownsEditor.current = false;
        registerEditor?.(null);
      }
    },
    [registerEditor],
  );
  const actionDisabled = (action: AssistantActionFragmentFragment) =>
    action.action === AssistantActionKind.CreateSubtask
      ? locked || !admitted || !title.trim()
      : (action.action === AssistantActionKind.Cancel ||
          action.action === AssistantActionKind.Close) &&
        locked;
  const navigation = useAssistantNavigation(
    descriptor,
    (action) => {
      if (action.action === AssistantActionKind.CreateSubtask) void submit();
      else if (action.action === AssistantActionKind.Check)
        void creator.review();
      else if (
        (action.action === AssistantActionKind.Cancel ||
          action.action === AssistantActionKind.Close) &&
        !locked
      ) {
        discard();
      }
    },
    creator.phase === "pending",
    validation.validate,
  );
  const nativeAdapters: Parameters<typeof AssistantGroups>[0]["adapters"] = {
    input: ({ input, error, disabled: inputDisabled }) =>
      input.target === AssistantInputTarget.Title ? (
        <FormRow
          data-assistant-input={input.id}
          error={error}
          label={assistantText(input.label, t.language)}
          labelFor={titleId}
        >
          <Input
            ref={titleInput}
            data-task-detail-control="new-subtask"
            id={titleId}
            value={title}
            disabled={disabled}
            // Retained uncertain drafts must remain focusable after Open/Back.
            readOnly={locked || !admitted || inputDisabled}
            onChange={(next) => {
              if (disabled || locked || !admitted || inputDisabled) return;
              creator.prepareNext();
              setTitle(next);
              if (next.length) creator.preserveDraft(draft(next));
              else creator.discardDraft();
            }}
          />
        </FormRow>
      ) : undefined,
  };
  if (!owner.identity || !owner.server) return null;
  return (
    <Stack>
      {otherPending ? (
        <Notice tone="warning">
          {retention?.current?.phase === "draft"
            ? t["com.myoxus.database.view.unsaved"]()
            : t["com.myoxus.database.tasks.create-uncertain"]()}
        </Notice>
      ) : null}
      <form
        ref={validation.formRef}
        aria-labelledby={`${titleId}-heading`}
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
        <MyoxusText
          component="h3"
          typographySlot="h3"
          id={`${titleId}-heading`}
        >
          {t["com.myoxus.database.task-children.add"]()}
        </MyoxusText>
        {presentation.isLoading ? (
          <Loading />
        ) : descriptor ? (
          <AssistantGroups
            descriptor={descriptor}
            stepId={navigation.step?.id}
            artworkServer={owner.server}
            invalidInputs={validation.invalidInputs}
            groups={navigation.step?.groups ?? []}
            answers={answers}
            disabled={locked || !admitted}
            adapters={nativeAdapters}
          />
        ) : (
          <Notice tone="warning">
            <Button type="button" onClick={() => void presentation.mutate()}>
              {t.Retry()}
            </Button>
          </Notice>
        )}
        {descriptor ? (
          <AssistantActions
            submitActionId={
              assistantFormAction(navigation.step?.actions ?? [], answers)?.id
            }
            actions={(navigation.step?.actions ?? []).filter(
              (action) =>
                action.action === AssistantActionKind.CreateSubtask ||
                action.action === AssistantActionKind.Next ||
                action.action === AssistantActionKind.Back ||
                action.action === AssistantActionKind.Cancel,
            )}
            answers={answers}
            busy={creator.phase === "pending"}
            disabled={actionDisabled}
            onAction={navigation.act}
          />
        ) : null}
      </form>
      {creator.failure && creator.phase !== "uncertain" ? (
        <Notice tone="error">
          {creator.relationReason
            ? taskParentReason(t, creator.relationReason)
            : creator.failure === "required"
              ? t["com.myoxus.database.tasks.create-required"]()
              : t["com.myoxus.database.tasks.create-invalid"]()}
        </Notice>
      ) : null}
      {creator.phase === "uncertain" ? (
        <Notice tone="warning">
          <Stack>
            <MyoxusText>
              {t["com.myoxus.database.tasks.create-uncertain"]()}
            </MyoxusText>
            <Button
              type="button"
              disabled={creator.checking}
              onClick={() => void creator.review()}
            >
              {t["com.myoxus.database.tasks.check-created"]()}
            </Button>
            {creator.reviewFailed ? (
              <MyoxusText>
                {t["com.myoxus.database.embed.unavailable"]()}
              </MyoxusText>
            ) : null}
            <Group>
              {creator.candidates.map((task) => (
                <Button
                  key={task.rowId}
                  type="button"
                  onClick={() => onOpen(task)}
                >
                  {task.title}
                </Button>
              ))}
            </Group>
            {creator.checked ? (
              <>
                <MyoxusText>
                  {t["com.myoxus.database.tasks.review-count"]({
                    shown: creator.candidates.length.toLocaleString(t.language),
                    total: creator.reviewCount.toLocaleString(t.language),
                  })}
                </MyoxusText>
                <MyoxusText>
                  {t["com.myoxus.database.tasks.review-before-retry"]()}
                </MyoxusText>
                <Button type="button" onClick={creator.allowAnotherAttempt}>
                  {t["com.myoxus.database.tasks.prepare-another"]()}
                </Button>
              </>
            ) : null}
          </Stack>
        </Notice>
      ) : null}
      {descriptor && navigation.dialog ? (
        <AssistantNativeDialog
          descriptor={descriptor}
          dialog={navigation.dialog}
          actionDisabled={actionDisabled}
          invalidInputs={validation.invalidInputs}
          dialogRef={validation.dialogRef}
          answers={answers}
          adapters={nativeAdapters}
          disabled={locked || !admitted}
          busy={creator.phase === "pending"}
          onClose={navigation.closeDialog}
          onAction={(action) => navigation.act(action, true)}
        />
      ) : null}
    </Stack>
  );
}
