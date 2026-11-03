// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import { GlobalState } from "@myoxus/core/modules/storage";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  AssistantInputTarget,
  AssistantValueType,
  DocumentReviewDecisionKind,
  WorkspaceAutomationRunOrigin,
  WorkspaceAutomationRunStatus,
  decideDocumentReviewMutation,
  documentReviewForTaskQuery,
  retryDocumentReviewMutation,
  stopDocumentReviewMutation,
  type DecideDocumentReviewInput,
  type DocumentReviewFragmentFragment,
  type PreparedDocumentReviewFragmentFragment,
  type PreparedTaskHandoverFragmentFragment,
  type AssistantPackageFragmentFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  FormRow,
  FormSelect,
  Group,
  LocalizedDateTimeInput,
  Loading,
  MyoxusText,
  Modal,
  Notice,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  DatabaseDocumentPicker,
  type DocumentPickerDocument,
} from "../document-picker";
import { formatDateTime } from "../model";
import { classifyDatabaseError } from "../route-state";
import type { DatabaseChangeHandler } from "../shared";
import type { AssistantInputAdapter } from "../presentation/renderer";
import {
  assistantText,
  assistantValue,
  type AssistantAnswers,
} from "../presentation/values";
import {
  databaseWallTimeToInstant,
  databaseZonedDateTime,
} from "../shared/schedule";
import {
  useTaskDestinations,
  useTaskIdentity,
} from "../tasks/use-workspace-tasks";
import {
  workspaceAutomationRunStatusLabel,
  workspaceAutomationRunTone,
} from "../workbench-context/database-automations";
import {
  readConfirmedAssistantAttempt,
  saveConfirmedAssistantAttempt,
} from "./context-documents-attempt";

function transportFields(value: unknown): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid confirmed review answers");
  return new Map(Object.entries(value));
}
/** Rehydrate only confirmed transport values for an explicit same-key edit.
 * This does not infer facts, restore a server receipt, or validate admission. */
export function nativeTaskAnswersFromTransport(
  descriptor: AssistantPackageFragmentFragment,
  payload: unknown,
): AssistantAnswers {
  const fields = transportFields(payload);
  if (
    [...fields.keys()].some(
      (key) => !descriptor.inputs.some((input) => input.id === key),
    )
  )
    throw new Error("Unknown confirmed review input");
  const answers: Record<string, ReturnType<typeof assistantValue>> = {};
  for (const input of descriptor.inputs) {
    if (!fields.has(input.id)) continue;
    const wire = transportFields(fields.get(input.id));
    if (
      wire.get("kind") !==
      input.valueType[0].toLowerCase() + input.valueType.slice(1)
    )
      throw new Error("Invalid confirmed review input kind");
    const value = wire.get("value");
    switch (input.valueType) {
      case AssistantValueType.TaskReferences:
        if (!Array.isArray(value))
          throw new Error("Invalid confirmed prerequisite Tasks");
        answers[input.id] = assistantValue(input.valueType, {
          taskReferences: value.map((reference) => {
            const fields = transportFields(reference);
            const databaseId = fields.get("databaseId"),
              rowId = fields.get("rowId");
            if (typeof databaseId !== "string" || typeof rowId !== "string")
              throw new Error("Invalid confirmed Task reference");
            return { databaseId, rowId };
          }),
        });
        break;
      case AssistantValueType.Document:
        if (typeof value !== "string")
          throw new Error("Invalid confirmed document");
        answers[input.id] = assistantValue(input.valueType, {
          documentId: value,
        });
        break;
      case AssistantValueType.Text:
        if (typeof value !== "string")
          throw new Error("Invalid confirmed title");
        answers[input.id] = assistantValue(input.valueType, { text: value });
        break;
      case AssistantValueType.DatabaseDestination:
        if (typeof value !== "string")
          throw new Error("Invalid confirmed destination");
        answers[input.id] = assistantValue(input.valueType, {
          databaseId: value,
        });
        break;
      case AssistantValueType.Members:
        if (
          !Array.isArray(value) ||
          !value.every((id): id is string => typeof id === "string")
        )
          throw new Error("Invalid confirmed reviewer");
        answers[input.id] = assistantValue(input.valueType, {
          memberIds: value,
        });
        break;
      case AssistantValueType.DateTime: {
        const date = transportFields(value);
        const start = date.get("start"),
          end = date.get("end"),
          allDay = date.get("allDay"),
          timeZone = date.get("timeZone");
        if (
          typeof start !== "string" ||
          !Number.isFinite(Date.parse(start)) ||
          (end !== null && typeof end !== "string") ||
          typeof allDay !== "boolean" ||
          typeof timeZone !== "string"
        )
          throw new Error("Invalid confirmed deadline");
        new Intl.DateTimeFormat("en", { timeZone }).format(new Date(start));
        answers[input.id] = assistantValue(input.valueType, {
          dateTime: { start, end, allDay, timeZone },
        });
        break;
      }
      default:
        throw new Error("Unsupported confirmed review input");
    }
  }
  return answers;
}

function ReviewDocumentInput({
  input,
  value,
  disabled,
  onChange,
  error,
}: AssistantInputAdapter) {
  const owner = useTaskIdentity();
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<DocumentPickerDocument>();
  return (
    <FormRow
      data-assistant-input={input.id}
      tabIndex={-1}
      label={assistantText(input.label, t.language)}
      error={error}
    >
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        {selected && selected.id === value?.documentId
          ? selected.title
          : assistantText(input.label, t.language)}
      </Button>
      <DatabaseDocumentPicker
        open={open}
        onOpenChange={setOpen}
        workspaceId={owner.workspace.id}
        currentDocumentId={null}
        onSelect={(doc) => {
          setSelected(doc);
          onChange(
            assistantValue(AssistantValueType.Document, { documentId: doc.id }),
          );
        }}
      />
    </FormRow>
  );
}
function ReviewDestinationInput({
  input,
  value,
  disabled,
  onChange,
  error,
}: AssistantInputAdapter) {
  const t = useI18n();
  const choices = useTaskDestinations();
  return (
    <FormSelect
      data-assistant-input={input.id}
      label={assistantText(input.label, t.language)}
      error={
        error ??
        (choices.destinationError
          ? t["com.myoxus.database.row_detail.unavailable"]()
          : undefined)
      }
      disabled={disabled || Boolean(choices.destinationError)}
      value={
        value?.databaseId ?? choices.defaultDestination?.databaseId ?? null
      }
      allowDeselect={false}
      data={choices.readyDestinations.map((destination) => ({
        value: destination.databaseId,
        label: destination.workspaceTasks
          ? t["com.myoxus.database.tasks.workspace-tasks"]()
          : destination.title,
      }))}
      onChange={(databaseId) =>
        onChange(
          databaseId
            ? assistantValue(AssistantValueType.DatabaseDestination, {
                databaseId,
              })
            : undefined,
        )
      }
    />
  );
}
function ReviewDeadlineInput({
  input,
  value,
  disabled,
  onChange,
  error,
}: AssistantInputAdapter) {
  const t = useI18n();
  const regional = useRegionalPreferences();
  const zone = value?.dateTime?.timeZone ?? regional.timezone;
  const start = value?.dateTime?.start;
  const [wallTime, setWallTime] = useState<string | null>(() =>
    start ? databaseZonedDateTime(start, zone) : null,
  );
  useEffect(() => {
    setWallTime(start ? databaseZonedDateTime(start, zone) : null);
  }, [start, zone]);
  return (
    <FormRow
      data-assistant-input={input.id}
      tabIndex={-1}
      label={assistantText(input.label, t.language)}
      error={error}
      help={zone}
    >
      <LocalizedDateTimeInput
        aria-label={assistantText(input.label, t.language)}
        locale={t.language}
        disabled={disabled}
        clearable
        value={wallTime}
        onChange={(next) => {
          const wall = typeof next === "string" ? next : null;
          setWallTime(wall);
          if (!wall) {
            onChange(undefined);
            return;
          }
          const instant = databaseWallTimeToInstant(wall, zone);
          if (instant)
            onChange(
              assistantValue(AssistantValueType.DateTime, {
                dateTime: {
                  start: instant,
                  end: null,
                  allDay: false,
                  timeZone: zone,
                },
              }),
            );
          else onChange(undefined);
        }}
      />
    </FormRow>
  );
}
/** Native adapters retain one shared descriptor/form owner; values are facts,
 * never inferred document access, assignments or a replacement deadline. */
export function documentReviewInput(props: AssistantInputAdapter) {
  switch (props.input.target) {
    case AssistantInputTarget.SourceDocument:
      return <ReviewDocumentInput {...props} />;
    case AssistantInputTarget.Destination:
      return <ReviewDestinationInput {...props} />;
    case AssistantInputTarget.Deadline:
      return <ReviewDeadlineInput {...props} />;
    case AssistantInputTarget.Assignees:
    case AssistantInputTarget.Reviewer:
      return <ReviewReviewerInput {...props} />;
    default:
      return undefined;
  }
}
function ReviewReviewerInput({
  input,
  value,
  disabled,
  onChange,
  error,
}: AssistantInputAdapter) {
  const t = useI18n();
  return (
    <FormRow
      data-assistant-input={input.id}
      tabIndex={-1}
      label={assistantText(input.label, t.language)}
      error={error}
    >
      <MemberSelectorInline
        selectionMode="single"
        selected={value?.memberIds ?? []}
        readonly={disabled}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        onChange={(memberIds) =>
          onChange(assistantValue(AssistantValueType.Members, { memberIds }))
        }
      />
    </FormRow>
  );
}
function deadlineLabel(
  plan:
    | PreparedDocumentReviewFragmentFragment
    | PreparedTaskHandoverFragmentFragment,
  language: string,
  regional: ReturnType<typeof useRegionalPreferences>,
) {
  const zone = plan.deadlineTimeZone;
  return `${formatDateTime(plan.deadlineAt, language, { ...regional, timezone: zone })} (${zone})`;
}
export function DocumentTaskPlan({
  plan,
  onOpenSource,
  sourceAvailable = true,
}: {
  plan:
    | PreparedDocumentReviewFragmentFragment
    | PreparedTaskHandoverFragmentFragment;
  onOpenSource: () => void;
  sourceAvailable?: boolean;
}) {
  const t = useI18n();
  const regional = useRegionalPreferences();
  const destinations = useTaskDestinations();
  const destination = destinations.readyDestinations.find(
    (item) => item.databaseId === plan.destinationDatabaseId,
  );
  return (
    <Stack data-testid="document-review-plan">
      {!plan.executionAvailable ? (
        <Notice tone="warning">
          {t["com.myoxus.database.setup.status.unavailable"]()}
        </Notice>
      ) : null}
      <MyoxusText>{plan.title}</MyoxusText>
      <Button
        variant="secondary"
        disabled={!sourceAvailable}
        onClick={onOpenSource}
      >
        {t["com.myoxus.database.review.open-source"]()}
      </Button>
      <MemberSelectorInline
        readonly
        selectionMode="single"
        selected={["reviewerId" in plan ? plan.reviewerId : plan.responsibleId]}
        onChange={() => {}}
      />
      <MyoxusText>
        {destination
          ? destination.workspaceTasks
            ? t["com.myoxus.database.tasks.workspace-tasks"]()
            : destination.title
          : t["com.myoxus.database.row_detail.unavailable"]()}
      </MyoxusText>
      <MyoxusText>{deadlineLabel(plan, t.language, regional)}</MyoxusText>
    </Stack>
  );
}
export function DocumentReviewResults({
  view,
  current,
  showSource = true,
}: {
  view: DocumentReviewFragmentFragment;
  current: () => boolean;
  showSource?: boolean;
}) {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const openTask = (rowId: string) => {
    if (current())
      workbench.open(
        `/tasks?${new URLSearchParams({ databaseId: view.acceptedPlan.destinationDatabaseId, rowId })}`,
        { at: "tail" },
      );
  };
  return (
    <Group>
      {showSource && view.sourceAvailable ? (
        <Button
          onClick={() => {
            if (current())
              workbench.openDoc(view.acceptedPlan.sourceExternalId, {
                at: "tail",
              });
          }}
        >
          {t["com.myoxus.database.review.open-source"]()}
        </Button>
      ) : null}
      {view.reviewTaskAvailable ? (
        <Button onClick={() => openTask(view.reviewTaskId)}>
          {t["com.myoxus.database.review.open-task"]()}
        </Button>
      ) : null}
      {view.followUpTaskAvailable ? (
        <Button onClick={() => openTask(view.followUpTaskId)}>
          {t["com.myoxus.database.review.open-follow-up"]()}
        </Button>
      ) : null}
    </Group>
  );
}

function validateDecision(input: DecideDocumentReviewInput) {
  if (
    !input ||
    typeof input.runId !== "string" ||
    !input.runId ||
    typeof input.waitId !== "string" ||
    !input.waitId ||
    typeof input.requestId !== "string" ||
    !input.requestId ||
    typeof input.expectedDocumentRevision !== "string" ||
    !input.expectedDocumentRevision ||
    !Number.isSafeInteger(input.expectedTaskEditRevision) ||
    !Number.isSafeInteger(input.expectedStatusEditRevision) ||
    ![
      DocumentReviewDecisionKind.Approve,
      DocumentReviewDecisionKind.RequestChanges,
    ].includes(input.decision) ||
    (input.decision === DocumentReviewDecisionKind.RequestChanges &&
      (typeof input.reason !== "string" || !input.reason.trim())) ||
    (input.decision === DocumentReviewDecisionKind.Approve &&
      input.reason != null)
  )
    throw new Error("Invalid confirmed review decision");
}
/** Deliberate presentation shares the inline owner's draft and durable attempt. */
type DocumentReviewTaskPresentation = {
  open: boolean;
  onClose: () => void;
  onAvailable: (available: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

/** The assigned review Task consumes native decision authority, not Automation
 * management permissions or a generic engine-signal endpoint. */
export function DocumentReviewTask({
  databaseId,
  rowId,
  revision,
  onChanged,
  presentation,
  showSource = true,
}: {
  databaseId: string;
  rowId: string;
  revision: string;
  onChanged: DatabaseChangeHandler;
  presentation?: DocumentReviewTaskPresentation;
  /** Embedded document metadata already exposes its source; Task hosts retain the link. */
  showSource?: boolean;
}) {
  const owner = useTaskIdentity();
  const identity = JSON.stringify([owner.identity, databaseId, rowId]);
  if (
    !owner.server ||
    !owner.account ||
    owner.availability.status !== "available"
  )
    return null;
  return (
    <DocumentReviewTaskOwner
      key={identity}
      databaseId={databaseId}
      rowId={rowId}
      revision={revision}
      onChanged={onChanged}
      presentation={presentation}
      showSource={showSource}
    />
  );
}
function DocumentReviewTaskOwner({
  databaseId,
  rowId,
  revision,
  onChanged,
  presentation,
  showSource,
}: {
  databaseId: string;
  rowId: string;
  revision: string;
  onChanged: DatabaseChangeHandler;
  presentation?: DocumentReviewTaskPresentation;
  showSource: boolean;
}) {
  const owner = useTaskIdentity();
  const t = useI18n();
  const regional = useRegionalPreferences();
  const state = useService(GlobalState);
  const [view, setView] = useState<DocumentReviewFragmentFragment | null>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [required, setRequired] = useState(false);
  const [attempt, setAttempt] = useState<DecideDocumentReviewInput>();
  const [editing, setEditing] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const alive = useRef(true);
  const valid = useRef(true);
  const flight = useRef(false);
  const sequence = useRef(0);
  const checkRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const current = useCallback(() => alive.current && valid.current, []);
  const key = `document-review:decision:${JSON.stringify([owner.server?.id, owner.account?.id, owner.workspace.id, databaseId, rowId])}`;
  useEffect(() => {
    alive.current = true;
    const sub = owner.server?.account$.subscribe((account) => {
      if (account?.id !== owner.account?.id) {
        valid.current = false;
        setView(undefined);
        setStorageReady(false);
        setFailed(true);
      }
    });
    return () => {
      alive.current = false;
      sub?.unsubscribe();
    };
  }, [owner.server, owner.account?.id]);
  const accept = (value: DocumentReviewFragmentFragment, runId?: string) => {
    if (!current()) return;
    if (
      value.run.workspaceId !== owner.workspace.id ||
      value.run.origin !== WorkspaceAutomationRunOrigin.DocumentReview ||
      !value.run.requestId ||
      (runId && value.run.id !== runId) ||
      (value.reviewTaskId !== rowId && value.followUpTaskId !== rowId)
    )
      throw new Error("Review owner changed");
    setView(value);
    if (value.decision != null) setEditing(false);
  };
  const read = async () => {
    const epoch = ++sequence.current;
    const response = await owner.server!.gql({
      query: documentReviewForTaskQuery,
      variables: { workspaceId: owner.workspace.id, databaseId, rowId },
    });
    if (!current() || epoch !== sequence.current) return undefined;
    if (
      response.currentUser?.id !== owner.account?.id ||
      response.workspace?.id !== owner.workspace.id
    ) {
      setView(undefined);
      throw new Error("Review owner unavailable");
    }
    const value = response.workspace.documentReviewForTask;
    if (value) accept(value);
    else setView(null);
    return value;
  };
  const load = async () => {
    const saved = await readConfirmedAssistantAttempt(
      state,
      key,
      validateDecision,
    );
    if (!current()) return;
    setAttempt(saved ?? undefined);
    const value = await read();
    if (!current()) return;
    if (saved && value && saved.runId !== value.run.id)
      throw new Error("Confirmed review owner changed");
    if (saved && value?.decision != null) {
      await saveConfirmedAssistantAttempt(
        state,
        key,
        undefined,
        validateDecision,
      );
      if (!current()) return;
      setAttempt(undefined);
      await onChanged();
      if (!current()) return;
    }
    setStorageReady(true);
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let active = true;
    void loadRef.current().catch((error) => {
      if (active && current()) {
        if (["forbidden", "missing"].includes(classifyDatabaseError(error)))
          setView(undefined);
        setFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [state, key, current, revision]);
  const run = async (action: () => Promise<unknown>) => {
    if (flight.current || !current()) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    flight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch (error) {
      if (current()) {
        if (["forbidden", "missing"].includes(classifyDatabaseError(error)))
          setView(undefined);
        setFailed(true);
      }
    } finally {
      flight.current = false;
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    if (!busy && current() && returnFocus.current) {
      const opener = returnFocus.current;
      returnFocus.current = null;
      (opener.isConnected ? opener : checkRef.current)?.focus();
    }
  }, [busy, current]);
  useEffect(() => {
    if (editing && !busy && current()) reasonRef.current?.focus();
  }, [editing, busy, current]);
  const send = async (input: DecideDocumentReviewInput) => {
    await saveConfirmedAssistantAttempt(state, key, input, validateDecision);
    if (!current()) return;
    setAttempt(input);
    setEditing(false);
    const response = await owner.server!.gql({
      query: decideDocumentReviewMutation,
      variables: { input },
    });
    if (!current()) return;
    ++sequence.current;
    accept(response.decideDocumentReview, input.runId);
    if (response.decideDocumentReview.decision !== input.decision)
      throw new Error("Review decision not confirmed");
    await saveConfirmedAssistantAttempt(
      state,
      key,
      undefined,
      validateDecision,
    );
    if (current()) {
      setAttempt(undefined);
      await onChanged();
    }
  };
  const decide = (kind: DocumentReviewDecisionKind) => {
    if (!storageReady || (attempt && !editing)) return;
    if (kind === DocumentReviewDecisionKind.RequestChanges && !reason.trim()) {
      setRequired(true);
      reasonRef.current?.focus();
      return;
    }
    const chosenReason = reason;
    void run(async () => {
      const latest = await read();
      if (
        !current() ||
        !latest ||
        (attempt && latest.run.id !== attempt.runId) ||
        latest.decision != null ||
        !(kind === DocumentReviewDecisionKind.Approve
          ? latest.canApprove
          : latest.canRequestChanges) ||
        latest.currentSourceRevision == null ||
        latest.expectedTaskEditRevision == null ||
        latest.expectedStatusEditRevision == null
      )
        return;
      await send({
        runId: latest.run.id,
        waitId: latest.waitId,
        // An explicit correction keeps the reserved identity; late acceptance wins.
        requestId: attempt?.requestId ?? crypto.randomUUID(),
        expectedDocumentRevision: latest.currentSourceRevision,
        expectedTaskEditRevision: latest.expectedTaskEditRevision,
        expectedStatusEditRevision: latest.expectedStatusEditRevision,
        decision: kind,
        reason:
          kind === DocumentReviewDecisionKind.RequestChanges
            ? chosenReason
            : null,
      });
    });
  };
  const onAvailable = presentation?.onAvailable;
  useEffect(() => {
    onAvailable?.(valid.current && (Boolean(view) || failed));
  }, [onAvailable, view, failed]);
  useEffect(() => () => onAvailable?.(false), [onAvailable]);
  const renderBody = () => {
    if (!valid.current)
      return (
        <Notice tone="warning">
          {t["com.myoxus.database.setup.status.unavailable"]()}
        </Notice>
      );
    if (view === null && !failed) return null;
    if (!view)
      return failed ? (
        <Notice tone="warning">
          <Button onClick={() => void run(load)}>{t.Retry()}</Button>
        </Notice>
      ) : (
        <Loading />
      );
    return (
      <Stack data-testid="document-review-task">
        <Badge tone={workspaceAutomationRunTone(view.run.status)}>
          {workspaceAutomationRunStatusLabel(t, view.run.status)}
        </Badge>
        {failed ? (
          <Notice tone="warning">
            {attempt && !view.decision
              ? t["com.myoxus.database.setup.status.unknown"]()
              : t["com.myoxus.common.operation-failed"]()}
          </Notice>
        ) : null}
        {view.reasonCode ? (
          <Notice tone="warning">
            {t["com.myoxus.database.setup.status.unavailable"]()}
          </Notice>
        ) : null}
        {!view.decision &&
        !view.reasonCode &&
        [
          WorkspaceAutomationRunStatus.Queued,
          WorkspaceAutomationRunStatus.Running,
        ].includes(view.run.status) ? (
          <MyoxusText>
            {t["com.myoxus.database.review.waiting"]({
              deadline: deadlineLabel(view.acceptedPlan, t.language, regional),
            })}
          </MyoxusText>
        ) : null}
        <DocumentReviewResults
          view={view}
          current={current}
          showSource={showSource}
        />
        {view.decision ? (
          <Notice>
            {view.decision === DocumentReviewDecisionKind.Approve
              ? t["com.myoxus.database.review.approve"]()
              : t["com.myoxus.database.review.request-changes"]()}
            {view.reason ? ` — ${view.reason}` : ""}
          </Notice>
        ) : null}
        {(view.canApprove || view.canRequestChanges) &&
        (!attempt || editing) ? (
          <>
            <Textarea
              ref={reasonRef}
              label={t["com.myoxus.database.review.reason"]()}
              value={reason}
              onChange={(value) => {
                setReason(value);
                setRequired(false);
              }}
              disabled={busy}
              error={
                required
                  ? t["com.myoxus.page-properties.property.required"]()
                  : undefined
              }
            />
            <Group>
              <Button
                disabled={busy || !storageReady || !view.canApprove}
                onClick={() => decide(DocumentReviewDecisionKind.Approve)}
              >
                {t["com.myoxus.database.review.approve"]()}
              </Button>
              <Button
                disabled={busy || !storageReady || !view.canRequestChanges}
                onClick={() =>
                  decide(DocumentReviewDecisionKind.RequestChanges)
                }
              >
                {t["com.myoxus.database.review.request-changes"]()}
              </Button>
              {editing ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setRequired(false);
                    checkRef.current?.focus();
                  }}
                >
                  {t.Cancel()}
                </Button>
              ) : null}
            </Group>
          </>
        ) : null}
        <Group>
          <Button ref={checkRef} disabled={busy} onClick={() => void run(load)}>
            {t["com.myoxus.database.setup.check"]()}
          </Button>
          {attempt && !editing ? (
            <Button
              disabled={
                busy ||
                !storageReady ||
                (!view.decision &&
                  !view.canRetry &&
                  !(attempt.decision === DocumentReviewDecisionKind.Approve
                    ? view.canApprove
                    : view.canRequestChanges))
              }
              onClick={() =>
                void run(async () => {
                  const latest = await read();
                  if (!current() || !latest) return;
                  if (latest.run.id !== attempt.runId)
                    throw new Error("Review changed");
                  if (latest.decision != null) {
                    await saveConfirmedAssistantAttempt(
                      state,
                      key,
                      undefined,
                      validateDecision,
                    );
                    if (current()) setAttempt(undefined);
                    return;
                  }
                  if (latest.canRetry) {
                    const response = await owner.server!.gql({
                      query: retryDocumentReviewMutation,
                      variables: { input: { runId: latest.run.id } },
                    });
                    if (current()) {
                      ++sequence.current;
                      accept(response.retryDocumentReview, latest.run.id);
                    }
                    return;
                  }
                  if (
                    !(attempt.decision === DocumentReviewDecisionKind.Approve
                      ? latest.canApprove
                      : latest.canRequestChanges)
                  )
                    return;
                  await send(attempt);
                })
              }
            >
              {t.Retry()}
            </Button>
          ) : null}
          {attempt &&
          !editing &&
          !view.decision &&
          (view.canApprove || view.canRequestChanges) ? (
            <Button
              disabled={busy || !storageReady}
              onClick={() =>
                void run(async () => {
                  const latest = await read();
                  if (
                    !current() ||
                    !latest ||
                    latest.run.id !== attempt.runId ||
                    latest.decision != null ||
                    !(latest.canApprove || latest.canRequestChanges)
                  )
                    return;
                  setReason(attempt.reason ?? "");
                  setRequired(false);
                  setEditing(true);
                })
              }
            >
              {t["com.myoxus.database.review.edit-unaccepted"]()}
            </Button>
          ) : null}
          {view.canRetry && !attempt ? (
            <Button
              disabled={busy || !storageReady}
              onClick={() =>
                void run(async () => {
                  const latest = await read();
                  if (!current() || !latest?.canRetry) return;
                  const response = await owner.server!.gql({
                    query: retryDocumentReviewMutation,
                    variables: { input: { runId: latest.run.id } },
                  });
                  if (current()) {
                    ++sequence.current;
                    accept(response.retryDocumentReview, latest.run.id);
                  }
                })
              }
            >
              {t.Retry()}
            </Button>
          ) : null}
          {view.canStop ? (
            <Button
              disabled={busy || !storageReady}
              onClick={() =>
                void run(async () => {
                  const latest = await read();
                  if (!current() || !latest?.canStop) return;
                  const response = await owner.server!.gql({
                    query: stopDocumentReviewMutation,
                    variables: { input: { runId: latest.run.id } },
                  });
                  if (current()) {
                    ++sequence.current;
                    accept(response.stopDocumentReview, latest.run.id);
                  }
                })
              }
            >
              {t["com.myoxus.database.setup.stop"]()}
            </Button>
          ) : null}
        </Group>
      </Stack>
    );
  };
  if (!presentation) return renderBody();
  return (
    <Modal
      open={presentation.open}
      title={t["com.myoxus.database.review.details"]()}
      persistent={busy}
      onOpenChange={(open) => {
        if (!open && !flight.current) presentation.onClose();
      }}
      returnFocusRef={presentation.returnFocusRef}
    >
      {presentation.open ? renderBody() : null}
    </Modal>
  );
}
