// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Checkbox,
  Divider,
  Group,
  LocalizedDateInput,
  MyoxusNumberInput,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  GANTT_DURATION_UNITS,
  ganttClickArgumentValue,
  ganttClickBindingError,
  formatGanttDateValue,
  ganttSourceEndMs,
  inspectGanttDateFormat,
  parseGanttDateValue,
  mermaidMessages as messages,
  type GanttCommand,
  type MermaidGanttReactHostProps,
  type MermaidGanttTask,
} from "@virgultum/block-mermaid";
import { useEffect, useId, useMemo, useState } from "react";

type Mode =
  "explicit-range" | "explicit-duration" | "previous" | "after" | "until";

const MODES: ReadonlyArray<{ label: () => string; value: Mode }> = [
  { label: messages.ganttScheduleExplicitRange, value: "explicit-range" },
  { label: messages.ganttScheduleExplicitDuration, value: "explicit-duration" },
  { label: messages.ganttSchedulePrevious, value: "previous" },
  { label: messages.ganttScheduleAfter, value: "after" },
  { label: messages.ganttScheduleUntil, value: "until" },
];

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|M|y)$/;

/** The source form a task currently carries, independent of UI mode names. */
function sourceMode(task: MermaidGanttTask): Mode {
  if (task.scheduleKind === "after") return "after";
  if (task.scheduleKind === "previous") return "previous";
  if (task.untilIds.length || task.scheduleKind === "until") return "until";
  // `explicit` covers both `start, end` and `start, duration`; the UI splits
  // them by which boundary the source actually holds.
  return !task.end ? "explicit-duration" : "explicit-range";
}

/**
 * Object-anchored schedule editor. It shows the effective source form plus the
 * previewed result and never degrades into a raw data form; every mode change
 * stays a draft until Apply.
 */
export function GanttTaskPopover({
  diagnosisMessage,
  extraCommands = [],
  initialMove,
  props,
  taskId,
  open,
  onOpenChange,
}: {
  readonly diagnosisMessage: (diagnosis: string) => string;
  /**
   * Additional typed commands a conversion drag produced (for example a lane/
   * order change); they join the confirmed Apply transaction unchanged.
   */
  readonly extraCommands?: readonly GanttCommand[];
  /** Dragged values of a bound task: the conversion must be confirmed here. */
  readonly initialMove?: { end: number; start: number } | null;
  readonly open: boolean;
  readonly props: MermaidGanttReactHostProps;
  readonly taskId: string;
  readonly onOpenChange: (opened: boolean, returnFocus?: boolean) => void;
}) {
  const t = useI18n();
  const optionsPortalId = useId();
  const model = props.model;
  const task = model.tasks.find((candidate) => candidate.recordId === taskId);
  const format = model.calendar.dateFormat;
  const { hasTime } = inspectGanttDateFormat(format);
  const interval = task ? model.intervals[task.recordId] : undefined;

  const [mode, setMode] = useState<Mode>("explicit-range");
  const [rejected, setRejected] = useState<string>();
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [durationAmount, setDurationAmount] = useState<string | number>("");
  const [durationUnit, setDurationUnit] = useState<string>("d");
  const [afterRefs, setAfterRefs] = useState<string[]>([]);
  const [untilRefs, setUntilRefs] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [milestone, setMilestone] = useState(false);
  const [vert, setVert] = useState(false);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [bindingKind, setBindingKind] = useState<"href" | "click">("href");
  const [bindingTarget, setBindingTarget] = useState("");
  const [bindingArgs, setBindingArgs] = useState<string[]>([]);
  const [bindingDelete, setBindingDelete] = useState(false);

  const seedKey = task ? `${task.recordId}:${model.sourceHash}` : "";
  useEffect(
    () => setRejected(undefined),
    [
      mode,
      start,
      end,
      startTime,
      endTime,
      durationAmount,
      durationUnit,
      afterRefs,
      untilRefs,
      label,
      sourceId,
      statuses,
      milestone,
      vert,
      bindingId,
      bindingKind,
      bindingTarget,
      bindingArgs,
      bindingDelete,
      seedKey,
    ],
  );
  // The draft re-seeds on object/source change and on a fresh conversion drag,
  // but never on every render, so unconfirmed user input survives.
  useEffect(() => {
    if (!task) return;
    const resolved = model.intervals[task.recordId];
    setBindingId(null);
    setBindingDelete(false);
    setMode(sourceMode(task));
    setLabel(task.label);
    setSourceId(task.id);
    setStatuses([...task.statuses]);
    setMilestone(task.isMilestone);
    setVert(task.isVert);
    setAfterRefs([...task.afterIds]);
    setUntilRefs([...task.untilIds]);
    setStart(
      resolved ? formatGanttDateValue(resolved.start, "YYYY-MM-DD") : null,
    );
    setStartTime(
      resolved && hasTime
        ? formatGanttDateValue(resolved.start, "HH:mm:ss")
        : "",
    );
    setEnd(
      resolved && resolved.end !== resolved.start
        ? formatGanttDateValue(
            ganttSourceEndMs(
              resolved.end,
              model.calendar.inclusiveEndDates,
              task,
            ),
            "YYYY-MM-DD",
          )
        : null,
    );
    setEndTime(
      resolved && resolved.end !== resolved.start && hasTime
        ? formatGanttDateValue(
            ganttSourceEndMs(
              resolved.end,
              model.calendar.inclusiveEndDates,
              task,
            ),
            "HH:mm:ss",
          )
        : "",
    );
    const match = DURATION_RE.exec(task.duration);
    setDurationAmount(match ? Number(match[1]) : "");
    setDurationUnit(match?.[2] ?? "d");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, open]);

  // A conversion drag seeds the explicit range from the dragged preview without
  // any day truncation and keeps its lane/order intent untouched.
  const conversionKey = initialMove
    ? `${initialMove.start}:${initialMove.end}`
    : null;
  useEffect(() => {
    if (!initialMove || !task) return;
    setMode("explicit-range");
    setStart(formatGanttDateValue(initialMove.start, "YYYY-MM-DD"));
    setStartTime(
      hasTime ? formatGanttDateValue(initialMove.start, "HH:mm:ss") : "",
    );
    const sourceEnd = ganttSourceEndMs(
      initialMove.end,
      model.calendar.inclusiveEndDates,
      task,
    );
    setEnd(formatGanttDateValue(sourceEnd, "YYYY-MM-DD"));
    setEndTime(hasTime ? formatGanttDateValue(sourceEnd, "HH:mm:ss") : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversionKey]);

  const modelClicks = useMemo(
    () => props.model.clicks.filter((click) => click.targetTaskId === task?.id),
    [props.model.clicks, task?.id],
  );
  if (!task || !interval) return null;

  const options = model.tasks
    .filter((candidate) => candidate.id !== task.id)
    .map((candidate) => ({
      label:
        model.tasks.filter((other) => other.label === candidate.label).length >
        1
          ? `${candidate.label} · ${candidate.id}`
          : candidate.label,
      value: candidate.id,
      recordId: candidate.recordId,
      disabled:
        model.tasks.filter((other) => other.id === candidate.id).length !== 1,
    }));

  // Original source lexeme of each boundary: an untouched value keeps its exact
  // source form instead of being reformatted when the popover opens.
  const initialStartDate = formatGanttDateValue(interval.start, "YYYY-MM-DD");
  const initialStartTime = hasTime
    ? formatGanttDateValue(interval.start, "HH:mm:ss")
    : "";
  const hasDistinctEnd = interval.end !== interval.start;
  const sourceEnd = ganttSourceEndMs(
    interval.end,
    model.calendar.inclusiveEndDates,
    task,
  );
  const initialEndDate = hasDistinctEnd
    ? formatGanttDateValue(sourceEnd, "YYYY-MM-DD")
    : "";
  const initialEndTime =
    hasDistinctEnd && hasTime
      ? formatGanttDateValue(sourceEnd, "HH:mm:ss")
      : "";
  const startEdited =
    (start ?? "") !== initialStartDate ||
    (hasTime && startTime !== initialStartTime);
  const endEdited =
    (end ?? "") !== initialEndDate || (hasTime && endTime !== initialEndTime);

  // Compose through the configured dateFormat; an invalid time stays invalid
  // instead of silently falling back to midnight.
  const startOwnedByMode =
    mode === "explicit-range" ||
    mode === "explicit-duration" ||
    (mode === "until" && !task.afterIds.length);
  const composeDateTime = (
    date: string | null,
    time: string,
    basis: number,
    original: string,
    boundary: "start" | "end",
  ) => {
    if (!date) return "";
    const dateMs = parseGanttDateValue(date, "YYYY-MM-DD");
    if (dateMs === null) return "";
    if (!hasTime || !time)
      return formatGanttDateValue(dateMs, format, original, boundary);
    const withTimeMs = parseGanttDateValue(
      `${date} ${time}`,
      "YYYY-MM-DD HH:mm:ss",
    );
    if (withTimeMs === null) return "";
    // Seconds-only controls must not discard an unchanged finer source part,
    // including the interval carried by a direct conversion drag.
    const fraction = new Date(basis).getUTCMilliseconds();
    return formatGanttDateValue(
      withTimeMs + fraction,
      format,
      original,
      boundary,
    );
  };
  const startTimeInvalid =
    hasTime &&
    startOwnedByMode &&
    startEdited &&
    parseGanttDateValue(
      `${start ?? ""} ${startTime}`,
      "YYYY-MM-DD HH:mm:ss",
    ) === null;
  const endTimeInvalid =
    hasTime &&
    mode === "explicit-range" &&
    endEdited &&
    parseGanttDateValue(`${end ?? ""} ${endTime}`, "YYYY-MM-DD HH:mm:ss") ===
      null;
  const startBoundaryValid =
    !startOwnedByMode ||
    !start ||
    parseGanttDateValue(start, "YYYY-MM-DD") !== null;
  const endBoundaryValid =
    mode !== "explicit-range" ||
    !end ||
    parseGanttDateValue(end, "YYYY-MM-DD") !== null;

  // An untouched boundary keeps its original source lexeme when the task's
  // current source form actually owns that boundary; otherwise (for example a
  // duration task switched to explicit range) the displayed resolved value is
  // the honest draft, never an empty boundary.
  const sourceOwnsStart =
    task.scheduleKind === "explicit" || task.scheduleKind === "until";
  const startSource =
    start && mode !== "after" && mode !== "previous"
      ? startEdited || !sourceOwnsStart
        ? composeDateTime(
            start,
            startTime,
            initialMove?.start ?? interval.start,
            task.start,
            "start",
          )
        : task.start
      : "";
  const endSource =
    mode === "explicit-range" && end
      ? endEdited || !task.end
        ? composeDateTime(
            end,
            endTime,
            ganttSourceEndMs(
              initialMove?.end ?? interval.end,
              model.calendar.inclusiveEndDates,
              task,
            ),
            task.end,
            "end",
          )
        : task.end
      : "";

  // A mode that does not own the end boundary (after/previous) leaves an
  // existing `until` reference untouched; only an end-owning mode replaces it.
  const endOwnedByMode =
    mode === "explicit-range" ||
    mode === "explicit-duration" ||
    mode === "until";
  const preservedUntil = endOwnedByMode
    ? mode === "until"
      ? untilRefs
      : []
    : [...task.untilIds];
  const endViaUntil = preservedUntil.length > 0;
  const durationOwnedByMode =
    !endViaUntil &&
    (mode === "explicit-duration" || mode === "after" || mode === "previous");

  const durationMatch = DURATION_RE.exec(task.duration);
  const initialDurationAmount = durationMatch ? Number(durationMatch[1]) : "";
  const initialDurationUnit = durationMatch?.[2] ?? "d";
  const durationEdited =
    (durationAmount === "") !== (initialDurationAmount === "") ||
    Number(durationAmount) !== Number(initialDurationAmount) ||
    durationUnit !== initialDurationUnit;
  const durationSource = durationOwnedByMode
    ? durationEdited || !task.duration
      ? durationAmount === ""
        ? ""
        : `${Number(durationAmount)}${durationUnit}`
      : task.duration
    : "";
  // An unchanged binding keeps its original clause, not a normalized draft
  // that could create a source/history commit just by opening the popover.
  const afterSource =
    task.scheduleKind === "after" &&
    JSON.stringify(afterRefs) === JSON.stringify(task.afterIds)
      ? task.start
      : `after ${afterRefs.join(" ")}`;
  const commands: GanttCommand[] = [];
  if (label !== task.label)
    commands.push({ label, taskId: task.recordId, type: "task.rename" });
  if (sourceId !== task.id)
    commands.push({
      newId: sourceId.trim(),
      taskId: task.recordId,
      type: "task.rename-id",
    });
  if (statuses.join(",") !== task.statuses.join(","))
    commands.push({
      statuses,
      taskId: task.recordId,
      type: "task.set-statuses",
    });
  // Converting between duration bar, milestone and `vert` marker keeps id,
  // label, section, schedule, dependencies, click and comments intact.
  if (milestone !== task.isMilestone || vert !== task.isVert)
    commands.push({
      milestone,
      taskId: task.recordId,
      type: "task.set-shape",
      vert,
    });

  // Only a genuinely changed schedule form converts the task; editing the label
  // or status must never silently rewrite its schedule statement, and opening
  // without an edit must not reformat the existing lexemes.
  const currentForm = {
    afterIds: [...task.afterIds],
    duration: task.duration,
    end: task.end,
    kind: task.scheduleKind,
    start: task.start,
    untilIds: [...task.untilIds],
  };
  const draftForm = {
    // Each reference family keeps its own list, so an untouched complementary
    // boundary (for example `until` while editing `after`, or the `after`
    // start while editing `until`) stays in the draft.
    afterIds:
      mode === "after" ? afterRefs : mode === "until" ? [...task.afterIds] : [],
    duration: mode === "explicit-range" ? "" : durationSource,
    end: mode === "explicit-range" ? endSource : "",
    kind:
      mode === "explicit-duration" || mode === "explicit-range"
        ? "explicit"
        : mode === "until"
          ? task.afterIds.length
            ? "after"
            : "explicit"
          : mode,
    start:
      mode === "after"
        ? afterSource
        : mode === "until" && task.afterIds.length
          ? task.start
          : startSource,
    untilIds: preservedUntil,
  };
  const scheduleChanged =
    JSON.stringify(currentForm) !== JSON.stringify(draftForm);
  if (scheduleChanged)
    commands.push({
      afterIds: draftForm.afterIds,
      duration: draftForm.duration,
      end: draftForm.end,
      mode,
      start: draftForm.start,
      taskId: task.recordId,
      type: "schedule.set",
      untilIds: draftForm.untilIds,
    });
  // The carried lane/order intent joins the same transaction and is never lost.
  commands.push(...extraCommands);

  const existingBinding = modelClicks.find((click) => click.id === bindingId);
  const bindingError =
    bindingId && !bindingDelete
      ? ganttClickBindingError(bindingKind, bindingTarget, bindingArgs)
      : null;
  if (bindingId && !bindingError) {
    if (bindingDelete && existingBinding)
      commands.push({ type: "click.remove", clickId: existingBinding.id });
    else if (
      !bindingDelete &&
      (!existingBinding ||
        existingBinding.kind !== bindingKind ||
        existingBinding.callbackOrUrl !== bindingTarget ||
        JSON.stringify(existingBinding.args.map(ganttClickArgumentValue)) !==
          JSON.stringify(bindingKind === "click" ? bindingArgs : []))
    ) {
      commands.push({
        type: "click.set",
        clickId: existingBinding?.id,
        taskRecordId: task.recordId,
        kind: bindingKind,
        callbackOrUrl: bindingTarget,
        args: bindingKind === "click" ? bindingArgs : [],
      });
    }
  }

  const valid =
    !bindingError &&
    (!durationOwnedByMode ||
      durationAmount === "" ||
      (Number.isFinite(Number(durationAmount)) &&
        Number(durationAmount) >= 0)) &&
    startBoundaryValid &&
    endBoundaryValid &&
    !startTimeInvalid &&
    !endTimeInvalid &&
    (mode === "previous" ||
      (mode === "after" && afterRefs.length > 0) ||
      (mode === "until" && untilRefs.length > 0) ||
      (mode === "explicit-range" && Boolean(start) && Boolean(end)) ||
      (mode === "explicit-duration" &&
        Boolean(start) &&
        ((durationAmount === "" &&
          !task.duration &&
          !task.end &&
          !startEdited &&
          mode === sourceMode(task)) ||
          (durationAmount !== "" &&
            Number.isFinite(Number(durationAmount)) &&
            Number(durationAmount) >= 0))));
  // The same atomic engine plan validates the draft before Apply, not only
  // after a pointer hover. A rejected schedule never looks confirmable.
  const preview =
    valid && commands.length ? props.onPreviewCommand(commands) : null;
  const draftDiagnosis = (diagnosis: string) =>
    diagnosis === "duplicate-id"
      ? messages.ganttDiagnosticDuplicateId(sourceId.trim())
      : diagnosisMessage(diagnosis);
  const previewInterval = preview?.changed
    ? (preview.model.intervals[task.recordId] ?? interval)
    : interval;
  const previewDate = new Intl.DateTimeFormat(t.language, {
    dateStyle: "medium",
    timeZone: "UTC",
    ...(hasTime ? { timeStyle: "medium" as const } : {}),
  });
  const referenceLabels = (ids: readonly string[]) =>
    ids
      .map((id) => {
        const target = model.tasks.find((candidate) => candidate.id === id);
        if (!target) return id;
        return model.tasks.filter(
          (candidate) => candidate.label === target.label,
        ).length > 1
          ? `${target.label} · ${id}`
          : target.label;
      })
      .join(", ");
  const seedBinding = (id: string | null) => {
    setBindingId(id);
    setBindingDelete(false);
    const selected = modelClicks.find((click) => click.id === id);
    setBindingKind(selected?.kind ?? "href");
    setBindingTarget(selected?.callbackOrUrl ?? "");
    setBindingArgs(selected?.args.map(ganttClickArgumentValue) ?? []);
    setRejected(undefined);
  };

  return (
    <Popover
      opened={open}
      onChange={onOpenChange}
      fitViewport
      position="bottom-start"
    >
      <PopoverTarget>
        <span />
      </PopoverTarget>
      <PopoverContent
        id={optionsPortalId}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          props.onConsumeEscape(event.nativeEvent);
          onOpenChange(false, true);
        }}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack p="sm" w={360}>
            <MyoxusText typographySlot="dense-label">
              {task.label} · {messages.ganttSchedule()}
            </MyoxusText>
            <MyoxusTextInput
              label={messages.ganttTaskLabel()}
              value={label}
              onChange={setLabel}
            />
            <MyoxusTextInput
              label={messages.ganttTaskId()}
              value={sourceId}
              onChange={setSourceId}
            />
            <Group gap="xs">
              {["active", "done", "crit"].map((status) => (
                <Checkbox
                  key={status}
                  checked={statuses.includes(status)}
                  label={status}
                  size="xs"
                  onChange={(event) =>
                    setStatuses((current) =>
                      event.target.checked
                        ? [...new Set([...current, status])]
                        : current.filter((entry) => entry !== status),
                    )
                  }
                />
              ))}
            </Group>
            <Group gap="xs">
              <Checkbox
                checked={milestone}
                label={messages.ganttMilestone()}
                size="xs"
                onChange={(event) => {
                  const next = event.target.checked;
                  setMilestone(next);
                  if (next) setVert(false);
                }}
              />
              <Checkbox
                checked={vert}
                label={messages.ganttMarker()}
                size="xs"
                onChange={(event) => {
                  const next = event.target.checked;
                  setVert(next);
                  if (next) setMilestone(false);
                }}
              />
            </Group>
            <Divider />
            {/* Native options must stay inside the owning popover's dismiss
                and embedded-editor interaction boundary. */}
            <Select
              // Keep options inside the owning popover, but outside its
              // autosizing scroll viewport: an inline dropdown otherwise
              // feeds its floating geometry back into scroll measurement.
              comboboxProps={{
                withinPortal: true,
                portalProps: { target: `#${CSS.escape(optionsPortalId)}` },
              }}
              label={messages.ganttSchedule()}
              data={MODES.map((entry) => ({
                label: entry.label(),
                value: entry.value,
              }))}
              value={mode}
              onChange={(next) => {
                if (next) setMode(next as Mode);
              }}
            />
            {startOwnedByMode ? (
              <LocalizedDateInput
                locale={t.language}
                label={messages.ganttStart()}
                value={start}
                onChange={setStart}
                clearable={false}
              />
            ) : null}
            {mode === "explicit-range" ? (
              <LocalizedDateInput
                locale={t.language}
                label={messages.ganttEnd()}
                value={end ?? ""}
                onChange={setEnd}
                clearable={false}
              />
            ) : null}
            {mode === "until" && task.afterIds.length ? (
              <MyoxusText tone="muted" typographySlot="caption">
                {`${messages.ganttScheduleAfter()}: ${referenceLabels(task.afterIds)}`}
              </MyoxusText>
            ) : null}
            {hasTime && startOwnedByMode ? (
              <MyoxusTextInput
                description={format}
                error={
                  startTimeInvalid
                    ? messages.ganttDiagnosticInvalidTime(startTime)
                    : undefined
                }
                label={messages.ganttStart()}
                value={startTime}
                onChange={setStartTime}
              />
            ) : null}
            {hasTime && mode === "explicit-range" ? (
              <MyoxusTextInput
                description={format}
                error={
                  endTimeInvalid
                    ? messages.ganttDiagnosticInvalidTime(endTime)
                    : undefined
                }
                label={messages.ganttEnd()}
                value={endTime}
                onChange={setEndTime}
              />
            ) : null}
            {durationOwnedByMode ? (
              <>
                <MyoxusNumberInput
                  label={messages.ganttDuration()}
                  min={0}
                  step={0.5}
                  value={durationAmount}
                  onChange={setDurationAmount}
                />
                <MyoxusSegmentedControl
                  aria-label={messages.ganttDuration()}
                  data={GANTT_DURATION_UNITS.map((unit) => ({
                    label: unit,
                    value: unit,
                  }))}
                  value={durationUnit}
                  onChange={(next) => setDurationUnit(String(next))}
                />
              </>
            ) : null}
            {!endOwnedByMode && endViaUntil ? (
              <MyoxusText tone="muted" typographySlot="caption">
                {`${messages.ganttScheduleUntil()}: ${referenceLabels(preservedUntil)}`}
              </MyoxusText>
            ) : null}
            {mode === "after" || mode === "until" ? (
              <Stack gap={4}>
                {options.map((option) => {
                  const list = mode === "after" ? afterRefs : untilRefs;
                  const setList =
                    mode === "after" ? setAfterRefs : setUntilRefs;
                  return (
                    <Checkbox
                      checked={list.includes(option.value)}
                      key={option.recordId}
                      disabled={option.disabled || props.readonly}
                      label={option.label}
                      onChange={(event) =>
                        setList((current) =>
                          event.target.checked
                            ? [...current, option.value]
                            : current.filter((entry) => entry !== option.value),
                        )
                      }
                      size="xs"
                    />
                  );
                })}
              </Stack>
            ) : null}
            <Divider />
            {preview &&
            !preview.changed &&
            preview.diagnosis !== "no-change" ? (
              <MyoxusText tone="danger" typographySlot="caption">
                {draftDiagnosis(preview.diagnosis)}
              </MyoxusText>
            ) : null}
            {rejected ? (
              <MyoxusText tone="danger" typographySlot="caption">
                {draftDiagnosis(rejected)}
              </MyoxusText>
            ) : null}
            <MyoxusText typographySlot="dense-label">
              {messages.ganttLink()}
            </MyoxusText>
            <Select
              label={messages.ganttBindingChoose()}
              value={bindingId}
              disabled={props.readonly}
              comboboxProps={{
                withinPortal: true,
                portalProps: { target: `#${CSS.escape(optionsPortalId)}` },
              }}
              data={[
                ...modelClicks.map((click, index) => ({
                  value: click.id,
                  label: `${index + 1} · ${click.callbackOrUrl}`,
                })),
                { value: "new-binding", label: messages.ganttBindingNew() },
              ]}
              onChange={seedBinding}
            />
            {bindingId ? (
              <>
                <MyoxusSegmentedControl
                  aria-label={messages.ganttBindingKind()}
                  disabled={props.readonly || bindingDelete}
                  value={bindingKind}
                  data={[
                    { value: "href", label: messages.ganttBindingLink() },
                    { value: "click", label: messages.ganttBindingCallback() },
                  ]}
                  onChange={(value) =>
                    setBindingKind(value as "href" | "click")
                  }
                />
                <MyoxusTextInput
                  label={
                    bindingKind === "href"
                      ? messages.ganttBindingUrl()
                      : messages.ganttBindingName()
                  }
                  disabled={props.readonly || bindingDelete}
                  value={bindingTarget}
                  onChange={setBindingTarget}
                  error={
                    bindingError === "target"
                      ? messages.ganttBindingInvalidTarget()
                      : undefined
                  }
                />
                {bindingKind === "click" ? (
                  <>
                    <MyoxusText tone="muted" typographySlot="caption">
                      {messages.ganttBindingNotExecuted()}
                    </MyoxusText>
                    {bindingArgs.map((argument, index) => (
                      <Group key={index} wrap="nowrap">
                        <MyoxusTextInput
                          label={messages.ganttBindingArgument(index + 1)}
                          disabled={props.readonly || bindingDelete}
                          value={argument}
                          onChange={(value) =>
                            setBindingArgs((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? value : item,
                              ),
                            )
                          }
                          error={
                            ganttClickBindingError("click", bindingTarget, [
                              argument,
                            ]) === "argument"
                              ? messages.ganttBindingInvalidArgument()
                              : undefined
                          }
                        />
                        <Button
                          variant="plain"
                          disabled={props.readonly || bindingDelete}
                          aria-label={`${messages.visualDelete()} · ${messages.ganttBindingArgument(index + 1)}`}
                          onClick={() =>
                            setBindingArgs((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            )
                          }
                        >
                          {messages.visualDelete()}
                        </Button>
                      </Group>
                    ))}
                    <Button
                      variant="plain"
                      disabled={props.readonly || bindingDelete}
                      onClick={() =>
                        setBindingArgs((current) => [...current, ""])
                      }
                    >
                      {messages.ganttBindingAddArgument()}
                    </Button>
                  </>
                ) : null}
                {existingBinding ? (
                  <Checkbox
                    checked={bindingDelete}
                    disabled={props.readonly}
                    label={messages.visualDelete()}
                    onChange={(event) => setBindingDelete(event.target.checked)}
                  />
                ) : null}
              </>
            ) : null}
            <MyoxusText tone="muted" typographySlot="caption">
              {`${messages.ganttStart()}: ${previewDate.format(new Date(previewInterval.start))} → ${previewDate.format(new Date(previewInterval.end))}`}
            </MyoxusText>
            <Group justify="flex-end">
              <Button variant="plain" onClick={() => onOpenChange(false, true)}>
                {messages.cancel()}
              </Button>
              <Button
                disabled={!valid || props.readonly || !preview?.changed}
                onClick={() => {
                  const result = props.onCommand(commands);
                  if (result.changed) onOpenChange(false, true);
                  else setRejected(result.diagnosis);
                }}
              >
                {messages.architectureApply()}
              </Button>
            </Group>
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
