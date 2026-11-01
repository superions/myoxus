// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AssistantActionFragmentFragment } from "@myoxus/graphql";

import {
  AssistantContext,
  AssistantControlKind,
  AssistantInputTarget,
  AssistantActionKind,
  AssistantValueType,
} from "@myoxus/graphql";
import { AssistantGroups, AssistantActions } from "../presentation/renderer";
import { useAssistantFormValidation } from "../presentation/use-form-validation";
import { useAssistantPresentation } from "../presentation/use-assistant-presentation";
import {
  useAssistantNavigation,
  AssistantNativeDialog,
} from "../presentation/native-form";
import {
  semanticAssistantAnswers,
  visibleAssistantTargets,
} from "../presentation/semantic-inputs";
import { assistantValue, assistantText } from "../presentation/values";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormSelect,
  FormRow,
  Group,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import type { RefObject } from "react";
import { databaseManagedCapabilities } from "../managed";
import { useTaskIdentity } from "./use-workspace-tasks";
import {
  useTaskMoveController,
  type TaskMoveControllerProps,
} from "./task-move-controller";

type Props = Omit<
  TaskMoveControllerProps,
  "identity" | "server" | "workspaceId"
> & {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

export function taskMoveReasonLabel(
  t: ReturnType<typeof useI18n>,
  reason: string,
) {
  switch (reason) {
    case "TASK_IMPORT_IN_PROGRESS":
      return t["com.myoxus.database.tasks.move-import-in-progress"]();
    case "SCHEMA_REVISION_CHANGED_OR_UNAVAILABLE":
    case "CONTAINER_REVISION_CHANGED":
    case "ROW_REVISION_CHANGED":
    case "CELL_REVISIONS_CHANGED":
      return t["com.myoxus.database.tasks.schema-changed"]();
    case "EXTERNAL_RELATION_REQUIRES_REPAIR":
    case "RELATED_TASKS_OR_REFERENCES_REQUIRE_EXPLICIT_REPAIR":
    case "GRAPH_BOUNDARY_LIMIT":
      return t["com.myoxus.database.tasks.move-boundary"]();
    case "CONTAINER_UNAVAILABLE":
    case "SELECTED_TASK_UNAVAILABLE":
    case "SELECTED_TASK_OWNER_OR_LIFECYCLE_CHANGED":
      return t["com.myoxus.database.row_detail.unavailable"]();
    default:
      return t["com.myoxus.database.tasks.move-failed"]();
  }
}

/** Preview and commit share the exact server-returned optimistic plan. Neither
 * a failed acknowledgement nor a cancelled overlay replays the native write.
 */
export function TaskMoveModal(props: Props) {
  const owner = useTaskIdentity();
  if (!owner.server || !owner.identity) return null;
  return (
    <TaskMoveSession
      key={`${owner.identity}:${props.record.database.id}:${props.row.row.id}`}
      {...props}
      identity={owner.identity}
      server={owner.server}
      workspaceId={owner.workspace.id}
    />
  );
}

function TaskMoveSession(
  props: Props &
    Pick<TaskMoveControllerProps, "identity" | "server" | "workspaceId">,
) {
  const t = useI18n();
  const { onClose, returnFocusRef } = props;
  const {
    destinations,
    target,
    targetRecord,
    source,
    supportsPhase,
    supportsMilestone,
    targetRows,
    membershipRows,
    selection,
    phaseId,
    milestoneId,
    preview,
    phase,
    failed,
    related,
    projectChoices,
    selectedIds,
    expansionTooLarge,
    locked,
    invalidate,
    setPhaseId,
    setMilestoneId,
    openRelated,
    createProject,
    prepare,
    refresh,
    expand,
    commit,
    check,
    chooseTarget,
    targetId,
    hasMoreMemberships,
  } = useTaskMoveController(props);
  const presentation = useAssistantPresentation(
    AssistantContext.TaskMovement,
    source.database.id,
    props.row.row.id,
  );
  const descriptor = presentation.descriptor;
  const presentationReady = Boolean(
    descriptor &&
    !presentation.invalidated &&
    presentation.projection?.databaseId === source.database.id,
  );
  const answers = descriptor
    ? semanticAssistantAnswers(descriptor, {
        ...(targetId
          ? {
              [AssistantInputTarget.Destination]: assistantValue(
                AssistantValueType.DatabaseDestination,
                { databaseId: targetId },
              ),
            }
          : {}),
        ...(phaseId
          ? {
              [AssistantInputTarget.Phase]: assistantValue(
                AssistantValueType.Row,
                { rowId: phaseId },
              ),
            }
          : {}),
        ...(milestoneId
          ? {
              [AssistantInputTarget.Milestone]: assistantValue(
                AssistantValueType.Row,
                { rowId: milestoneId },
              ),
            }
          : {}),
      })
    : {};
  const targets = descriptor
    ? visibleAssistantTargets(descriptor, answers)
    : new Set<AssistantInputTarget>();
  const validation = useAssistantFormValidation<HTMLDivElement>(
    descriptor,
    answers,
  );
  const renderImpact = () =>
    preview ? (
      <Stack>
        {preview.reasons.map((reason) => (
          <Notice key={reason} tone="warning">
            {taskMoveReasonLabel(t, reason)}
          </Notice>
        ))}
        {preview.requiredRelatedTasks.length ? (
          <Notice tone="warning">
            <MyoxusText>
              {t["com.myoxus.database.tasks.move-related"]()}
            </MyoxusText>
            {expansionTooLarge ? (
              <MyoxusText>
                {t["com.myoxus.database.tasks.move-selection-limit"]({
                  max: new Intl.NumberFormat(t.language).format(100),
                })}
              </MyoxusText>
            ) : null}
            <Button
              data-testid="task-move-expand-selection"
              disabled={
                locked ||
                expansionTooLarge ||
                preview.boundaries.some((boundary) => boundary.recoverableTrash)
              }
              onClick={() => void expand()}
            >
              {t["com.myoxus.database.tasks.move-expand"]()}
            </Button>
          </Notice>
        ) : null}
        {preview.boundaries.map((boundary, index) => {
          const relatedRow = related.data?.find(
            (row) => row.id === boundary.relatedRowId,
          )?.row;
          const title =
            relatedRow && !relatedRow.redacted
              ? relatedRow.row.title
              : t["com.myoxus.database.row_detail.unavailable"]();
          return (
            <Notice key={index} tone="warning">
              {boundary.inbound
                ? t["com.myoxus.database.tasks.move-inbound"]({ title })
                : t["com.myoxus.database.tasks.move-outbound"]({ title })}
              {boundary.recoverableTrash ? (
                <MyoxusText>{t.Deleted()}</MyoxusText>
              ) : null}
            </Notice>
          );
        })}
        {related.isLoading ? <Loading /> : null}
        {related.data?.map(({ id, row: relatedRow, failed }) => (
          <Group key={id}>
            <MyoxusText>
              {relatedRow && !relatedRow.redacted
                ? relatedRow.row.title
                : t["com.myoxus.database.row_detail.unavailable"]()}
            </MyoxusText>
            {failed ? (
              <Notice tone="error" data-testid="task-move-related-read-error">
                <Button disabled={locked} onClick={() => void related.mutate()}>
                  {t.Retry()}
                </Button>
              </Notice>
            ) : null}
            {relatedRow?.row.deletedAt ? (
              <MyoxusText tone="secondary">{t.Deleted()}</MyoxusText>
            ) : null}
            {relatedRow && !relatedRow.redacted ? (
              <Button
                disabled={locked}
                variant="secondary"
                onClick={() =>
                  openRelated(id, Boolean(relatedRow.row.deletedAt))
                }
              >
                {t["com.myoxus.database.row.open-details"]()}
              </Button>
            ) : null}
          </Group>
        ))}
        {related.error ? (
          <Notice tone="warning">
            {t["com.myoxus.database.row_detail.unavailable"]()}
          </Notice>
        ) : null}
        {preview.allocatesDisplayIds ? (
          <Notice tone="info">
            {t["com.myoxus.database.tasks.move-display-id"]()}
          </Notice>
        ) : null}
      </Stack>
    ) : null;
  const renderReadback = () =>
    phase === "uncertain" ? (
      <Notice tone="warning">
        <MyoxusText>
          {t["com.myoxus.database.tasks.move-uncertain"]()}
        </MyoxusText>
        <Button data-testid="task-move-check" onClick={() => void check()}>
          {t["com.myoxus.database.tasks.move-check"]()}
        </Button>
      </Notice>
    ) : null;
  const canRefresh = !locked && phase !== "previewing";
  const refreshCurrent = async () => {
    // Denied readback can still hide a committed move; keep its write lock.
    if (!canRefresh) return;
    await refresh();
    if (supportsPhase || supportsMilestone) void targetRows.mutate();
    await presentation.mutate();
  };
  const nativeAdapters: Parameters<typeof AssistantGroups>[0]["adapters"] = {
    control: (control) => {
      if (control.kind === AssistantControlKind.MoveSelection)
        return (
          <>
            <MyoxusText>
              {t["com.myoxus.database.tasks.move-selection"]({
                count: new Intl.NumberFormat(t.language).format(
                  selectedIds.length,
                ),
              })}
            </MyoxusText>
            {selection.map((selected) => (
              <MyoxusText key={selected.row.id}>
                {selected.row.title}
              </MyoxusText>
            ))}
          </>
        );
      if (control.kind === AssistantControlKind.MoveImpact)
        return renderImpact();
      if (control.kind === AssistantControlKind.CurrentOwnerReadback)
        return renderReadback();
      if (control.kind === AssistantControlKind.DestinationAudience)
        return (
          <MyoxusText tone="secondary">
            {descriptor
              ? assistantText(descriptor.description, t.language)
              : t["com.myoxus.database.tasks.destination-audience"]()}
          </MyoxusText>
        );
      return undefined;
    },
    input: ({ input, error, disabled }) => {
      if (input.target === AssistantInputTarget.Destination)
        return (
          <FormSelect
            data-testid="task-move-destination"
            data-assistant-input={input.id}
            error={error}
            required={input.required}
            label={assistantText(input.label, t.language)}
            value={targetId || null}
            onChange={chooseTarget}
            disabled={disabled || locked || phase === "previewing"}
            data={projectChoices.map((project) => ({
              value: project.id,
              label: project.title,
            }))}
          />
        );
      if (input.target === AssistantInputTarget.Phase)
        return supportsPhase ? (
          <FormSelect
            data-testid="task-move-phase"
            data-assistant-input={input.id}
            error={error}
            required={input.required}
            label={assistantText(input.label, t.language)}
            disabled={disabled || locked}
            clearable
            value={phaseId || null}
            onChange={(value) => {
              invalidate();
              setPhaseId(value);
            }}
            onClear={() => {
              invalidate();
              setPhaseId("");
            }}
            data={membershipRows
              .filter((row) => row.row.rowKind === "phase")
              .map((row) => ({ value: row.row.id, label: row.row.title }))}
          />
        ) : input.required ? (
          <FormRow label={assistantText(input.label, t.language)} error={error}>
            <MyoxusText>
              {t["com.myoxus.template-list.unavailable"]()}
            </MyoxusText>
          </FormRow>
        ) : null;
      if (input.target === AssistantInputTarget.Milestone)
        return supportsMilestone ? (
          <FormSelect
            data-testid="task-move-milestone"
            data-assistant-input={input.id}
            error={error}
            required={input.required}
            label={assistantText(input.label, t.language)}
            disabled={disabled || locked}
            clearable
            value={milestoneId || null}
            onChange={(value) => {
              invalidate();
              setMilestoneId(value);
            }}
            onClear={() => {
              invalidate();
              setMilestoneId("");
            }}
            data={membershipRows
              .filter((row) => row.row.rowKind === "milestone")
              .map((row) => ({ value: row.row.id, label: row.row.title }))}
          />
        ) : input.required ? (
          <FormRow label={assistantText(input.label, t.language)} error={error}>
            <MyoxusText>
              {t["com.myoxus.template-list.unavailable"]()}
            </MyoxusText>
          </FormRow>
        ) : null;
      return undefined;
    },
  };
  const actionDisabled = (action: AssistantActionFragmentFragment) => {
    if (
      action.action === AssistantActionKind.Cancel ||
      action.action === AssistantActionKind.Close
    )
      return phase === "pending";
    if (action.action === AssistantActionKind.Check)
      return phase !== "uncertain";
    if (action.action === AssistantActionKind.Refresh) return !canRefresh;
    if (action.action === AssistantActionKind.CommitTaskMove)
      return (
        locked ||
        phase === "previewing" ||
        !preview?.eligible ||
        !presentationReady
      );
    if (action.action === AssistantActionKind.PrepareTaskMove)
      return (
        locked ||
        phase === "previewing" ||
        !targetRecord?.managedSchema ||
        !databaseManagedCapabilities(targetRecord).ready ||
        !presentationReady
      );
    return locked;
  };
  const navigation = useAssistantNavigation(
    descriptor,
    (action) => {
      if (
        action.action === AssistantActionKind.Cancel ||
        action.action === AssistantActionKind.Close
      )
        onClose();
      else if (action.action === AssistantActionKind.Check) void check();
      else if (action.action === AssistantActionKind.Refresh) refreshCurrent();
      else if (
        action.action === AssistantActionKind.OpenProjectCreation &&
        !locked
      )
        createProject();
      else if (
        action.action === AssistantActionKind.PrepareTaskMove &&
        presentationReady &&
        validation.validate()
      )
        void prepare(undefined, {
          phaseRowId:
            supportsPhase && targets.has(AssistantInputTarget.Phase)
              ? phaseId || undefined
              : undefined,
          milestoneRowId:
            supportsMilestone && targets.has(AssistantInputTarget.Milestone)
              ? milestoneId || undefined
              : undefined,
        });
      else if (
        action.action === AssistantActionKind.CommitTaskMove &&
        presentationReady &&
        validation.validate()
      )
        void commit();
    },
    phase === "pending",
    validation.validate,
  );
  return (
    <Modal
      open
      title={t["com.myoxus.database.tasks.move-to-project"]()}
      persistent={phase === "pending"}
      onOpenChange={(open) => {
        if (!open && phase !== "pending") onClose();
      }}
      returnFocusRef={returnFocusRef}
      contentOptions={{ "data-testid": "task-move-modal" }}
      scrollable
    >
      <Stack ref={validation.formRef}>
        {presentation.isLoading ? (
          <Loading />
        ) : descriptor ? (
          <AssistantGroups
            descriptor={descriptor}
            stepId={navigation.step?.id}
            artworkServer={props.server}
            invalidInputs={validation.invalidInputs}
            groups={navigation.step?.groups ?? []}
            answers={answers}
            disabled={locked}
            adapters={nativeAdapters}
          />
        ) : (
          <>
            <Notice tone="warning">
              <Button disabled={!canRefresh} onClick={refreshCurrent}>
                {t.Retry()}
              </Button>
            </Notice>
            {renderImpact()}
            {renderReadback()}
          </>
        )}

        {destinations.nextCursor ? (
          <Button
            variant="secondary"
            disabled={locked}
            onClick={() => void destinations.loadMore()}
          >
            {t["com.myoxus.database.load-more"]()}
          </Button>
        ) : null}
        {!projectChoices.length && !destinations.isLoading ? (
          <Notice tone="info">
            {t["com.myoxus.database.tasks.no-ready-projects"]()}
          </Notice>
        ) : null}

        {hasMoreMemberships ? (
          <Button
            disabled={locked}
            variant="secondary"
            onClick={() => void targetRows.setSize(targetRows.size + 1)}
          >
            {t["com.myoxus.database.load-more"]()}
          </Button>
        ) : null}
        {destinations.isLoading ||
        target.isLoading ||
        phase === "previewing" ? (
          <Loading />
        ) : null}
        {failed || target.error || targetRows.error || destinations.error ? (
          <Notice tone="error">
            <Stack>
              <MyoxusText>
                {t["com.myoxus.database.tasks.move-failed"]()}
              </MyoxusText>
              <Button disabled={!canRefresh} onClick={refreshCurrent}>
                {t.Retry()}
              </Button>
            </Stack>
          </Notice>
        ) : null}
        {phase === "denied" ? (
          <Notice tone="warning">
            {t["com.myoxus.database.row_detail.forbidden"]()}
          </Notice>
        ) : null}
        {descriptor ? (
          <AssistantActions
            actions={(navigation.step?.actions ?? []).filter((action) =>
              action.action === AssistantActionKind.Check
                ? false
                : action.action === AssistantActionKind.Close
                  ? false
                  : true,
            )}
            answers={answers}
            busy={phase === "pending"}
            disabled={actionDisabled}
            testId={(action) =>
              action.action === AssistantActionKind.CommitTaskMove
                ? "task-move-confirm"
                : action.action === AssistantActionKind.PrepareTaskMove
                  ? "task-move-preview"
                  : action.action === AssistantActionKind.Check
                    ? "task-move-check"
                    : undefined
            }
            onAction={navigation.act}
          />
        ) : (
          <Button disabled={phase === "pending"} onClick={onClose}>
            {t.Cancel()}
          </Button>
        )}
      </Stack>
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
          busy={phase === "pending"}
          onClose={navigation.closeDialog}
          onAction={(action) => navigation.act(action, true)}
        />
      ) : null}
    </Modal>
  );
}
