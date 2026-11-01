// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CalendarDaysIcon,
  CommentIcon,
  PaletteIcon,
  PlusIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Button,
  Group,
  IconButton,
  Modal,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
  Tooltip,
} from "@myoxus/ui-facade";
import { GanttView, type GanttMoveIntent } from "@myoxus/ui-facade";
import {
  formatGanttDateValue,
  ganttDiagnosticText,
  ganttReorderImpact,
  parseGanttDateValue,
  mermaidGanttRendererToken,
  mermaidMessages as messages,
  type GanttCommand,
  type GanttSelection,
  type MermaidFamilyReactRendererRegistration,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ChartEditorSurface } from "../mermaid-chart-runtime/common";
import { GanttAccessibilityPopover } from "./accessibility-popover";
import { GanttAppearancePopover } from "./appearance-popover";
import { GanttCalendarPopover } from "./calendar-popover";
import { GanttComments } from "./comments";
import { GanttDeleteDialog } from "./delete-dialog";
import { GanttDependencyDeleteDialog } from "./dependency-delete-dialog";
import { GanttDependencyPopover } from "./dependency-popover";
import { projectGanttView, type GanttDependencyAnchor } from "./projection";
import { GanttTaskPopover } from "./task-popover";

type PopoverKind =
  | "accessibility"
  | "appearance"
  | "calendar"
  | "comments"
  | "dependency"
  | "more"
  | "schedule";

/** Start point for a new task: the latest scheduled day, or the epoch. */
function lastScheduledStart(
  intervals: Readonly<Record<string, { start: number }>>,
) {
  const values = Object.values(intervals);
  return values.length ? Math.max(...values.map((entry) => entry.start)) : 0;
}

/** Facade order counts visible rows; source order also contains real markers.
 * Translate the insertion slot by record identity without creating marker rows. */
function sourceTaskOrder(
  model: MermaidGanttReactHostProps["model"],
  taskId: string,
  sectionId: string,
  visibleOrder: number,
) {
  const siblings = model.tasks.filter(
    (task) => task.sectionId === sectionId && task.recordId !== taskId,
  );
  const visible = siblings.filter((task) => !task.isVert);
  const next = visible[Math.max(0, Math.min(visible.length, visibleOrder))];
  return next
    ? siblings.findIndex((task) => task.recordId === next.recordId)
    : siblings.length;
}

/**
 * Thin type host for Mermaid Gantt. It owns selection, focus, drafts and
 * intent routing only; grammar, schedule resolution and writing stay in the
 * engine, geometry and interaction mechanics in the Facade view.
 */
export function MermaidGanttRuntime({
  props,
}: {
  readonly props: MermaidGanttReactHostProps;
}) {
  const source = props.model.sourceDocument.source;
  const appearanceOptionsPortalId = useId();
  const calendarOptionsPortalId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  // Draft portals disappear on close, and shape edits may replace their actor.
  // Restore only inside this Gantt; outside-click dismissal keeps its new focus.
  const returnActorFocus = (taskId?: string, edgeId?: string) => {
    requestAnimationFrame(() => {
      const root = containerRef.current;
      const edge = edgeId
        ? root?.querySelector<SVGElement>(
            `[data-testid="gantt-dependency-${edgeId}"] [role="button"]`,
          )
        : null;
      const actor = taskId
        ? root?.querySelector<HTMLElement>(
            `[data-testid="gantt-bar-${taskId}"], [data-testid="gantt-marker-${taskId}"], [data-myoxus-ui-role="gantt-section-header"][data-section-id="${taskId}"]`,
          )
        : null;
      (
        edge ??
        actor ??
        root?.querySelector<HTMLElement>("button:not(:disabled)")
      )?.focus();
    });
  };
  const [locale] = useState(() => navigator.language);
  const [width, setWidth] = useState(900);
  const [selection, setSelection] = useState<GanttSelection>(props.selection);
  const [popover, setPopover] = useState<PopoverKind>();
  const [dependencyId, setDependencyId] = useState<string | null>(null);
  const [deletingDependency, setDeletingDependency] =
    useState<GanttDependencyAnchor>();
  const [deleting, setDeleting] = useState<{
    id: string;
    kind: "task" | "section";
  }>();
  const [adding, setAdding] = useState<
    | { kind: "section"; afterSectionId?: string }
    | { kind: "task" | "milestone"; sectionId: string; start: number }
  >();
  const [renaming, setRenaming] = useState<{ id: string; label: string }>();
  const [pendingMove, setPendingMove] = useState<GanttMoveIntent>();
  const [pendingReorder, setPendingReorder] = useState<{
    affected: readonly { label: string; taskId: string }[];
    command: GanttCommand | readonly GanttCommand[];
  }>();
  const [notice, setNotice] = useState<string>();
  const [connectMode, setConnectMode] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(false);
  useEffect(() => {
    setPopover(undefined);
    setDependencyId(null);
    setDeletingDependency(undefined);
    setDeleting(undefined);
    setAdding(undefined);
    setRenaming(undefined);
    setPendingMove(undefined);
    setPendingReorder(undefined);
    setConnectMode(false);
  }, [source, props.readonly, props.displayOnly]);
  useEffect(() => setSelection(props.selection), [props.selection]);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const [zoom, setZoom] = useState<
    "day" | "week" | "month" | "quarter" | "year" | null
  >(null);
  const commentAnchors = useMemo(() => {
    if (!commentsVisible) return [];
    const grouped = new Map<string, { id: string; text: string }[]>();
    for (const comment of props.model.comments) {
      const objectId =
        comment.anchor.kind === "task" || comment.anchor.kind === "section"
          ? comment.anchor.id
          : "diagram";
      grouped.set(objectId, [
        ...(grouped.get(objectId) ?? []),
        { id: comment.id, text: comment.text },
      ]);
    }
    return [...grouped.entries()].map(([objectId, entries]) => ({
      count: entries.length,
      id: objectId,
      objectId,
      text: entries.map((entry) => entry.text).join("\n"),
    }));
  }, [commentsVisible, props.model.comments]);
  const projection = useMemo(
    () => projectGanttView(props.model, locale, width, zoom),
    [props.model, locale, width, zoom],
  );
  // Rejected commands report their concrete cause at the surface instead of a
  // generic "line 1"; a plain no-op stays silent.
  const diagnosisMessage = (diagnosis: string) => {
    switch (diagnosis) {
      case "bound-start":
        return messages.ganttDiagnosticBoundStart(messages.ganttStart());
      case "bound-end":
        return messages.ganttDiagnosticBoundEnd();
      case "invalid-schedule":
      case "unresolved-schedule":
        return messages.ganttDiagnosticInvalidSchedule();
      case "invalid-label":
        return messages.ganttDiagnosticInvalidLabel();
      case "invalid-id":
        return messages.ganttDiagnosticInvalidId();
      case "invalid-date":
      case "invalid-duration":
        return messages.ganttSchedule();
      case "duplicate-reference":
        return messages.ganttDiagnosticDuplicateReference();
      case "cycle":
        return messages.ganttDiagnosticCycle();
      case "unknown-task":
      case "unknown-reference":
      case "unresolved-reference":
        return messages.ganttDiagnosticUnknownTask();
      case "conflict":
      case "duplicate-id":
        return messages.ganttDiagnosticConflict();
      case "ambiguous-source":
        return messages.ganttAmbiguousSource();
      case "readonly":
        return messages.ganttReadOnly();
      default:
        return messages.ganttCommandRejected();
    }
  };
  const applyResult: MermaidGanttReactHostProps["onCommand"] = (command) => {
    const result = props.onCommand(command);
    if (!result.changed) {
      setNotice(
        result.diagnosis === "no-change"
          ? undefined
          : diagnosisMessage(result.diagnosis),
      );
      return result;
    }
    setNotice(undefined);
    setSelection(result.selection);
    props.onSelectionChange(result.selection);
    return result;
  };
  const apply = (command: GanttCommand | readonly GanttCommand[]) =>
    applyResult(command).changed;
  const selectedSection =
    selection?.kind === "section"
      ? props.model.sections.find((section) => section.id === selection.id)
      : undefined;
  const selectedTask =
    selection?.kind === "task"
      ? props.model.tasks.find((task) => task.recordId === selection.id)
      : undefined;
  // A conversion drag of a bound task can also carry a lane/order change; both
  // are handed to the popover so one confirmed Apply writes one transaction.
  const pendingMoveExtras: GanttCommand[] = (() => {
    if (!pendingMove || !selectedTask) return [];
    const localIndex = projection.tasks
      .filter((entry) => entry.sectionId === pendingMove.targetLaneId)
      .findIndex((entry) => entry.id === selectedTask.recordId);
    const structural =
      pendingMove.mode === "move" &&
      Boolean(pendingMove.targetLaneId) &&
      (pendingMove.targetLaneId !== selectedTask.sectionId ||
        (pendingMove.targetOrder !== undefined &&
          pendingMove.targetOrder !== localIndex));
    return structural
      ? [
          {
            targetOrder: sourceTaskOrder(
              props.model,
              selectedTask.recordId,
              pendingMove.targetLaneId!,
              pendingMove.targetOrder ?? 0,
            ),
            targetSectionId: pendingMove.targetLaneId!,
            taskId: selectedTask.recordId,
            type: "task.reorder",
          },
        ]
      : [];
  })();
  // Readonly keeps exploration (comments, appearance, calendar, canvas zoom)
  // but drops every mutating affordance, including the create buttons.
  const toolbar = props.displayOnly ? null : (
    <Group gap="xs" wrap="wrap">
      {!props.readonly && props.model.sections.length > 0 ? (
        <>
          <Button
            prefix={<PlusIcon size={14} />}
            onClick={() =>
              setAdding({
                kind: "task",
                sectionId:
                  selectedSection?.id ??
                  selectedTask?.sectionId ??
                  props.model.sections[0]?.id ??
                  "",
                start: lastScheduledStart(props.model.intervals),
              })
            }
            size="compact-sm"
            variant="primary"
          >
            {messages.ganttAddTask()}
          </Button>
          <Button
            prefix={<PlusIcon size={14} />}
            onClick={() =>
              setAdding({
                kind: "milestone",
                sectionId:
                  selectedSection?.id ??
                  selectedTask?.sectionId ??
                  props.model.sections[0]?.id ??
                  "",
                start: lastScheduledStart(props.model.intervals),
              })
            }
            size="compact-sm"
            variant="default"
          >
            {messages.ganttAddMilestone()}
          </Button>
          <Button
            prefix={<PlusIcon size={14} />}
            onClick={() =>
              setAdding({
                kind: "section",
                afterSectionId: selectedSection?.id ?? selectedTask?.sectionId,
              })
            }
            size="compact-sm"
            variant="default"
          >
            {messages.ganttAddSection()}
          </Button>
          <Tooltip content={messages.ganttDependency()}>
            <IconButton
              aria-label={messages.ganttDependency()}
              aria-pressed={connectMode}
              onClick={() => {
                setConnectMode(!connectMode);
                setPopover(undefined);
              }}
              size="compact-sm"
              variant={connectMode ? "primary" : "default"}
            >
              <SettingsIcon size={14} />
            </IconButton>
          </Tooltip>
        </>
      ) : null}
      <Popover
        opened={popover === "comments"}
        fitViewport
        onChange={(opened) => setPopover(opened ? "comments" : undefined)}
      >
        <PopoverTarget>
          <IconButton
            aria-label={messages.visualComments()}
            aria-pressed={popover === "comments"}
            onClick={() => {
              const next = popover !== "comments";
              setPopover(next ? "comments" : undefined);
              setCommentsVisible(next);
            }}
            size="compact-sm"
            variant="default"
          >
            <CommentIcon size={14} />
          </IconButton>
        </PopoverTarget>
        <PopoverContent>
          <Scrollable.Viewport autosize maxHeight="floating">
            <GanttComments props={props} />
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
      <Popover
        opened={popover === "appearance"}
        fitViewport
        onChange={(opened) => setPopover(opened ? "appearance" : undefined)}
      >
        <PopoverTarget>
          <IconButton
            aria-label={messages.visualAppearance()}
            aria-pressed={popover === "appearance"}
            onClick={() =>
              setPopover(popover === "appearance" ? undefined : "appearance")
            }
            size="compact-sm"
            variant="default"
          >
            <PaletteIcon size={14} />
          </IconButton>
        </PopoverTarget>
        <PopoverContent id={appearanceOptionsPortalId}>
          <Scrollable.Viewport autosize maxHeight="floating">
            <GanttAppearancePopover
              optionsPortalTarget={`#${CSS.escape(appearanceOptionsPortalId)}`}
              props={props}
              onClose={() => setPopover(undefined)}
            />
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
      <Popover
        fitViewport
        opened={
          popover === "more" ||
          popover === "calendar" ||
          popover === "accessibility"
        }
        onChange={(opened) => {
          if (!opened) setPopover(undefined);
        }}
      >
        <PopoverTarget>
          <Button
            aria-expanded={
              popover === "more" ||
              popover === "calendar" ||
              popover === "accessibility"
            }
            onClick={() =>
              setPopover(
                popover === "more" ||
                  popover === "calendar" ||
                  popover === "accessibility"
                  ? undefined
                  : "more",
              )
            }
            size="compact-sm"
            variant="default"
          >
            {messages.visualMoreActions()}
          </Button>
        </PopoverTarget>
        <PopoverContent id={calendarOptionsPortalId}>
          {popover === "calendar" ? (
            <Scrollable.Viewport autosize maxHeight="floating">
              <GanttCalendarPopover
                optionsPortalTarget={`#${CSS.escape(calendarOptionsPortalId)}`}
                props={props}
                onClose={() => setPopover(undefined)}
              />
            </Scrollable.Viewport>
          ) : popover === "accessibility" ? (
            <Scrollable.Viewport autosize maxHeight="floating">
              <GanttAccessibilityPopover props={props} />
            </Scrollable.Viewport>
          ) : (
            <Stack p="xs" w={260}>
              <Button
                prefix={<CalendarDaysIcon size={14} />}
                onClick={() => setPopover("calendar")}
                variant="ghost"
              >
                {messages.ganttCalendar()}
              </Button>
              <Button
                onClick={() => setPopover("accessibility")}
                variant="ghost"
              >
                {messages.architectureAccessibility()}
              </Button>
              {selectedTask && !props.readonly ? (
                <Button
                  color="myoxusError"
                  onClick={() =>
                    setDeleting({ id: selectedTask.recordId, kind: "task" })
                  }
                  variant="ghost"
                >
                  {messages.visualDelete()}
                </Button>
              ) : null}
              {selectedSection && !props.readonly ? (
                <Button
                  color="myoxusError"
                  onClick={() =>
                    setDeleting({ id: selectedSection.id, kind: "section" })
                  }
                  variant="ghost"
                >
                  {messages.visualDelete()}
                </Button>
              ) : null}
            </Stack>
          )}
        </PopoverContent>
      </Popover>
    </Group>
  );
  const commitMove = (intent: GanttMoveIntent) => {
    const task = props.model.tasks.find(
      (candidate) => candidate.recordId === intent.taskId,
    );
    if (!task) return;
    const original = props.model.intervals[task.recordId];
    if (!original) return;
    const timeChanged =
      Math.round(intent.start) !== Math.round(original.start) ||
      Math.round(intent.end) !== Math.round(original.end);
    // `targetOrder` is section-local; compare it within the task's own section
    // so an unchanged order is a structural no-op even with several sections.
    const sectionOrder = (sectionId: string, taskId: string) =>
      projection.tasks
        .filter((entry) => entry.sectionId === sectionId)
        .findIndex((entry) => entry.id === taskId);
    const structuralChanged =
      intent.mode === "move" &&
      Boolean(intent.targetLaneId) &&
      (intent.targetLaneId !== task.sectionId ||
        (intent.targetOrder !== undefined &&
          intent.targetOrder !==
            sectionOrder(intent.targetLaneId!, task.recordId)));
    if (!timeChanged && !structuralChanged) return;
    // Decide by intent mode AND the actually changed bound boundary:
    //  * An end resize of a task whose (bound) start is untouched keeps the
    //    start reference and only changes the free end / duration, so it goes
    //    straight to the schedule owner. No conversion dialog is offered.
    //  * A move, a start resize or a change of an actually bound boundary needs
    //    the conscious conversion draft.
    const startBound =
      task.scheduleKind === "after" || task.scheduleKind === "previous";
    const endBound = task.untilIds.length > 0;
    // A resize-end never touches the start, so a bound start is preserved and
    // the free end (plus the derived duration) can be written directly by the
    // schedule owner without a conversion. Every other time change that touches
    // an actually bound boundary needs the conscious conversion draft.
    const directTimeEdit =
      (!startBound && !endBound) || (intent.mode === "resize-end" && !endBound);
    if (timeChanged && !directTimeEdit) {
      setPendingMove(intent);
      setPopover("schedule");
      return;
    }
    const reorderCommand: GanttCommand | null = structuralChanged
      ? {
          targetOrder: sourceTaskOrder(
            props.model,
            task.recordId,
            intent.targetLaneId!,
            intent.targetOrder ?? 0,
          ),
          targetSectionId: intent.targetLaneId!,
          taskId: task.recordId,
          type: "task.reorder",
        }
      : null;
    // A resize keeps one boundary fixed and moves the grabbed edge; only a
    // move shifts the whole interval, so each mode writes its own command.
    const timeCommand: GanttCommand | null = timeChanged
      ? intent.mode === "move"
        ? {
            deltaMs: intent.start - original.start,
            taskId: task.recordId,
            type: "task.move",
          }
        : {
            edge: intent.mode === "resize-start" ? "start" : "end",
            taskId: task.recordId,
            type: "task.resize",
            valueMs: intent.mode === "resize-start" ? intent.start : intent.end,
          }
      : null;
    // An implicit previous-start can change when a task is reordered; name the
    // affected successors and their new schedule instead of failing silently.
    if (reorderCommand && intent.targetLaneId) {
      const affected = ganttReorderImpact(
        props.model,
        task.recordId,
        intent.targetLaneId,
        reorderCommand.targetOrder,
      ).map((entry) => ({ label: entry.label, taskId: entry.recordId }));
      if (affected.length) {
        setPendingReorder({
          affected,
          command: timeCommand ? [timeCommand, reorderCommand] : reorderCommand,
        });
        return;
      }
    }
    // Every reachable path above is a no-op or produced a command, so exactly
    // one transaction is confirmed here.
    if (timeCommand || reorderCommand) {
      apply(
        timeCommand && reorderCommand
          ? [timeCommand, reorderCommand]
          : (timeCommand ?? reorderCommand)!,
      );
    }
  };
  return (
    <div ref={containerRef}>
      <ChartEditorSurface
        actionTarget={props.actionTarget}
        context={null}
        contextOpened={false}
        contextTitle={messages.ganttSchedule()}
        embedded={props.embedded}
        onCloseContext={() => setPopover(undefined)}
        pageViewport={props.pageViewport}
        selectedId={dependencyId ?? selection?.id}
        selectionAction={{
          disabled:
            props.readonly ||
            (!selection &&
              !(dependencyId && projection.dependencyById.has(dependencyId))),
          label: messages.visualDelete(),
          onSelect: () => {
            // A selected dependency wins over any previously selected task so
            // global Delete addresses exactly the visible edge. It routes
            // through the same impact decision as the anchored popover.
            if (dependencyId) {
              const anchor = projection.dependencyById.get(dependencyId);
              if (anchor) {
                setDeletingDependency(anchor);
                setPopover(undefined);
                return;
              }
            }
            if (selection)
              setDeleting({
                id: selection.id,
                kind: selection.kind === "section" ? "section" : "task",
              });
          },
          register: props.onSelectionActionChange,
          selectionKey: dependencyId
            ? `dependency:${dependencyId}`
            : selection
              ? `${selection.kind}:${selection.id}`
              : undefined,
        }}
        toolbar={toolbar}
        workareaLabel={messages.visualEditorLabel()}
      >
        {notice ? <Alert role="status">{notice}</Alert> : null}
        {props.model.ambiguous ? (
          <Alert color="myoxusWarning" role="status">
            {messages.ganttAmbiguousSource()}
          </Alert>
        ) : null}
        {!props.displayOnly ? (
          <Group gap="xs" justify="flex-end">
            <MyoxusSegmentedControl
              aria-label={messages.ganttTimeScale()}
              layout="fluid"
              data={[
                { label: messages.ganttTimeScaleDay(), value: "day" },
                { label: messages.ganttTimeScaleWeek(), value: "week" },
                { label: messages.ganttTimeScaleMonth(), value: "month" },
                { label: messages.ganttTimeScaleQuarter(), value: "quarter" },
                { label: messages.ganttTimeScaleYear(), value: "year" },
                { label: messages.ganttTimeScaleAuto(), value: "auto" },
              ]}
              value={zoom ?? "auto"}
              onChange={(next) =>
                setZoom(next === "auto" ? null : (next as typeof zoom))
              }
            />
          </Group>
        ) : null}
        {/* Empty owns exactly one `Add section`: the surface's own empty slot
            shows no duplicate while the toolbar keeps the same action. */}
        {props.model.tasks.length === 0 && props.model.sections.length === 0 ? (
          <Stack align="center" gap="sm" py="xl">
            <Button
              disabled={props.readonly}
              prefix={<PlusIcon size={14} />}
              onClick={() => setAdding({ kind: "section" })}
            >
              {messages.ganttAddSection()}
            </Button>
          </Stack>
        ) : null}
        <GanttView
          axis={projection.axis}
          dependencies={projection.dependencies}
          diagnostics={props.model.diagnostics.map((diagnostic, index) => ({
            id: `${diagnostic.code}-${diagnostic.range.line}-${index}`,
            message: ganttDiagnosticText(diagnostic),
            taskId: diagnostic.statementId,
          }))}
          excludedBands={projection.excludedBands}
          labels={{
            empty: messages.ganttAddSection(),
            region: messages.visualEditorLabel(),
            reorderSection: messages.visualMoveUp(),
            reorderTask: messages.visualMoveUp(),
          }}
          commentAnchors={commentAnchors}
          markers={projection.markers.map((marker) => ({
            ...marker,
            selected: selection?.kind === "task" && selection.id === marker.id,
          }))}
          onCommitMove={commitMove}
          onCreateDependency={(fromTaskId, toTaskId) => {
            apply({ fromTaskId, toTaskId, type: "dependency.create" });
            setPopover(undefined);
          }}
          onCreateTask={(sectionId, start, milestone) =>
            setAdding({
              kind: milestone ? "milestone" : "task",
              sectionId,
              start,
            })
          }
          onDeleteDependency={(id) => {
            const anchor = projection.dependencyById.get(id);
            if (anchor) setDeletingDependency(anchor);
          }}
          onDeleteSelection={(taskId) =>
            setDeleting({ id: taskId, kind: "task" })
          }
          onOpenComment={(anchor) => {
            setPopover("comments");
            if (anchor.objectId !== "diagram") {
              const kind = props.model.tasks.some(
                (task) => task.recordId === anchor.objectId,
              )
                ? "task"
                : "section";
              const next: GanttSelection = { id: anchor.objectId, kind };
              setSelection(next);
              props.onSelectionChange(next);
            }
          }}
          onOpenTask={(taskId) => {
            setSelection({ id: taskId, kind: "task" });
            props.onSelectionChange({ id: taskId, kind: "task" });
            setPopover("schedule");
          }}
          onPreviewMove={(intent) => setPendingMove(intent ?? undefined)}
          onSelectMarker={(markerId) => {
            setDependencyId(null);
            const next: GanttSelection = markerId
              ? { id: markerId, kind: "task" }
              : null;
            setSelection(next);
            props.onSelectionChange(next);
          }}
          onOpenMarker={(markerId) => {
            setSelection({ id: markerId, kind: "task" });
            props.onSelectionChange({ id: markerId, kind: "task" });
            setPopover("schedule");
          }}
          onRenameMarker={(markerId) => {
            const task = props.model.tasks.find(
              (candidate) => candidate.recordId === markerId,
            );
            if (task) setRenaming({ id: markerId, label: task.label });
          }}
          onDeleteMarker={(markerId) =>
            setDeleting({ id: markerId, kind: "task" })
          }
          onCommitMarker={(intent) => {
            const markerTask = props.model.tasks.find(
              (candidate) => candidate.recordId === intent.markerId,
            );
            const bound =
              markerTask?.scheduleKind === "after" ||
              markerTask?.scheduleKind === "previous" ||
              Boolean(markerTask?.untilIds.length);
            if (bound) {
              // A reference-bound marker must not move silently: its drag opens
              // the anchored conversion popover with the full shifted interval.
              const original = props.model.intervals[intent.markerId];
              if (!original) return;
              const delta = intent.value - original.start;
              setPendingMove({
                end: original.end + delta,
                mode: "move",
                start: intent.value,
                taskId: intent.markerId,
              });
              setSelection({ id: intent.markerId, kind: "task" });
              props.onSelectionChange({ id: intent.markerId, kind: "task" });
              setPopover("schedule");
              return;
            }
            // A free marker keeps its own source form: a millisecond move only
            // shifts its explicit start and leaves duration/end untouched.
            const original = props.model.intervals[intent.markerId];
            apply({
              deltaMs: intent.value - (original?.start ?? intent.value),
              taskId: intent.markerId,
              type: "task.move",
            });
          }}
          onReconnectDependency={(id, end, taskId) => {
            const anchor = projection.dependencyById.get(id);
            if (!anchor) return;
            if (end === "target") {
              // The grabbed end owns the reference: move the whole reference
              // from the old owner to the newly clicked task.
              apply({
                endpoint: "target",
                kind: anchor.kind,
                newOwnerRecordId: taskId,
                referenceId: anchor.referenceId,
                taskRecordId: anchor.taskRecordId,
                type: "dependency.reconnect",
              });
              return;
            }
            // Source endpoint: only the referenced task changes.
            const newReferenceId = props.model.tasks.find(
              (task) => task.recordId === taskId,
            )?.id;
            if (!newReferenceId) return;
            apply({
              endpoint: "source",
              kind: anchor.kind,
              newReferenceId,
              referenceId: anchor.referenceId,
              taskRecordId: anchor.taskRecordId,
              type: "dependency.reconnect",
            });
          }}
          onRenameTask={(taskId) => {
            const task = props.model.tasks.find(
              (candidate) => candidate.recordId === taskId,
            );
            if (task) setRenaming({ id: taskId, label: task.label });
          }}
          onReorderSection={(sectionId, targetOrder) => {
            const command: GanttCommand = {
              sectionId,
              targetOrder,
              type: "section.reorder",
            };
            const preview = props.onPreviewCommand(command);
            const planned = preview.rejectedModel ?? preview.model;
            const affected = props.model.tasks
              .filter((task) => {
                const before = props.model.intervals[task.recordId];
                const after = planned.intervals[task.recordId];
                return (
                  before?.start !== after?.start || before?.end !== after?.end
                );
              })
              .map((task) => ({ label: task.label, taskId: task.recordId }));
            if ((preview.changed || preview.rejectedModel) && affected.length)
              setPendingReorder({ command, affected });
            else apply(command);
          }}
          onReorderTask={(taskId, targetSectionId, targetOrder) => {
            const current = projection.tasks.filter(
              (task) => task.sectionId === targetSectionId,
            );
            if (current.findIndex((task) => task.id === taskId) === targetOrder)
              return;
            const sourceOrder = sourceTaskOrder(
              props.model,
              taskId,
              targetSectionId,
              targetOrder,
            );
            // Keyboard reorder shares the same impact plan as a pointer drag:
            // implicit previous-starts move with it and are named explicitly.
            const affected = ganttReorderImpact(
              props.model,
              taskId,
              targetSectionId,
              sourceOrder,
            ).map((entry) => ({ label: entry.label, taskId: entry.recordId }));
            const command: GanttCommand = {
              targetOrder: sourceOrder,
              targetSectionId,
              taskId,
              type: "task.reorder",
            };
            if (affected.length) {
              setPendingReorder({ affected, command });
              return;
            }
            apply(command);
          }}
          onSelectDependency={(id) => {
            setDependencyId(id);
            setPopover("dependency");
            setSelection(null);
            props.onSelectionChange(null);
          }}
          onSelectSection={(sectionId) => {
            setDependencyId(null);
            const next: GanttSelection = { id: sectionId, kind: "section" };
            setSelection(next);
            props.onSelectionChange(next);
          }}
          onSelectTask={(taskId) => {
            setDependencyId(null);
            const next: GanttSelection = taskId
              ? { id: taskId, kind: "task" }
              : null;
            setSelection(next);
            props.onSelectionChange(next);
          }}
          connectMode={connectMode}
          onConnectModeChange={setConnectMode}
          popover={
            renaming ? (
              <RenameDraft
                key={renaming.id}
                renaming={renaming}
                onApply={applyResult}
                onPreview={props.onPreviewCommand}
                diagnosisMessage={diagnosisMessage}
                onClose={(returnFocus) => {
                  setRenaming(undefined);
                  if (returnFocus) returnActorFocus(renaming.id);
                }}
                onEscape={props.onConsumeEscape}
              />
            ) : popover === "schedule" && selection?.kind === "task" ? (
              <GanttTaskPopover
                diagnosisMessage={diagnosisMessage}
                extraCommands={pendingMoveExtras}
                initialMove={pendingMove ?? null}
                open
                props={props}
                taskId={selection.id}
                onOpenChange={(opened, returnFocus) => {
                  if (!opened) setPopover(undefined);
                  setPendingMove(undefined);
                  if (!opened && returnFocus) returnActorFocus(selection.id);
                }}
              />
            ) : popover === "dependency" &&
              dependencyId &&
              !deletingDependency &&
              projection.dependencyById.has(dependencyId) ? (
              <GanttDependencyPopover
                key={dependencyId}
                diagnosisMessage={diagnosisMessage}
                anchor={{
                  ...projection.dependencyById.get(dependencyId)!,
                  dependencyId,
                }}
                onClose={(returnFocus) => {
                  // Closing a portal must not clear the selected edge before
                  // the outside-clicked global action receives its click.
                  setPopover(undefined);
                  if (returnFocus)
                    returnActorFocus(
                      projection.dependencyById.get(dependencyId)?.taskRecordId,
                      dependencyId,
                    );
                }}
                onDeleteRequest={(anchor) => {
                  setDeletingDependency(anchor);
                  setPopover(undefined);
                }}
                props={props}
              />
            ) : null
          }
          popoverAnchorTaskId={
            renaming?.id ??
            (dependencyId
              ? projection.dependencyById.get(dependencyId)?.taskRecordId
              : selection?.kind === "task"
                ? selection.id
                : null) ??
            null
          }
          readonly={props.readonly || Boolean(props.displayOnly)}
          sections={projection.sections.map((section) => ({
            ...section,
            selected:
              selection?.kind === "section" && selection.id === section.id,
          }))}
          selectedDependencyId={dependencyId}
          tasks={projection.tasks.map((task) => ({
            ...task,
            selected: selection?.kind === "task" && selection.id === task.id,
          }))}
        />
        <Modal
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setDeletingDependency(undefined)}
          open={Boolean(deletingDependency)}
          title={messages.ganttDependencyDeleteTitle()}
        >
          {deletingDependency ? (
            <GanttDependencyDeleteDialog
              anchor={deletingDependency}
              onDone={() => {
                const edgeId = [...projection.dependencyById].find(
                  ([, anchor]) =>
                    anchor.taskRecordId === deletingDependency.taskRecordId &&
                    anchor.kind === deletingDependency.kind &&
                    anchor.referenceId === deletingDependency.referenceId,
                )?.[0];
                returnActorFocus(deletingDependency.taskRecordId, edgeId);
                setDeletingDependency(undefined);
              }}
              props={props}
            />
          ) : null}
        </Modal>

        <Modal
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setDeleting(undefined)}
          open={Boolean(deleting)}
          title={messages.ganttDeleteImpact()}
        >
          {deleting ? (
            <GanttDeleteDialog
              onDone={() => {
                returnActorFocus(deleting.id);
                setDeleting(undefined);
              }}
              props={props}
              target={deleting}
            />
          ) : null}
        </Modal>

        <Modal
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setPendingReorder(undefined)}
          open={Boolean(pendingReorder)}
          title={messages.ganttReorderImpact()}
        >
          {pendingReorder ? (
            <ReorderImpactDialog
              apply={apply}
              diagnosisMessage={diagnosisMessage}
              onClose={() => setPendingReorder(undefined)}
              pending={pendingReorder}
              props={props}
            />
          ) : null}
        </Modal>

        <Modal
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setAdding(undefined)}
          open={Boolean(adding)}
          title={
            adding?.kind === "section"
              ? messages.ganttAddSection()
              : adding?.kind === "milestone"
                ? messages.ganttAddMilestone()
                : messages.ganttAddTask()
          }
        >
          {adding ? (
            <AddDraft
              adding={adding}
              onApply={applyResult}
              onPreview={props.onPreviewCommand}
              diagnosisMessage={diagnosisMessage}
              model={props.model}
              onClose={() => setAdding(undefined)}
            />
          ) : null}
        </Modal>
      </ChartEditorSurface>
    </div>
  );
}

/** An object-anchored draft uses the same engine plan for preview and commit. */
function RenameDraft({
  renaming,
  onApply,
  onPreview,
  diagnosisMessage,
  onClose,
  onEscape,
}: {
  readonly renaming: { id: string; label: string };
  readonly onApply: MermaidGanttReactHostProps["onCommand"];
  readonly onPreview: MermaidGanttReactHostProps["onPreviewCommand"];
  readonly diagnosisMessage: (diagnosis: string) => string;
  readonly onClose: (returnFocus?: boolean) => void;
  readonly onEscape: MermaidGanttReactHostProps["onConsumeEscape"];
}) {
  const [label, setLabel] = useState(renaming.label);
  const [rejected, setRejected] = useState<string>();
  const command = {
    type: "task.rename",
    taskId: renaming.id,
    label,
  } satisfies GanttCommand;
  const preview = onPreview(command);
  const diagnostic =
    rejected ??
    (!preview.changed && preview.diagnosis !== "no-change"
      ? diagnosisMessage(preview.diagnosis)
      : undefined);
  const confirm = () => {
    if (!preview.changed) return;
    const result = onApply(command);
    if (result.changed) onClose(true);
    else setRejected(diagnosisMessage(result.diagnosis));
  };
  return (
    <Popover
      opened
      fitViewport
      position="bottom-start"
      onChange={(opened) => {
        if (!opened) onClose();
      }}
    >
      <PopoverTarget>
        <span />
      </PopoverTarget>
      <PopoverContent
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onEscape(event.nativeEvent);
          onClose(true);
        }}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack p="sm" w={280}>
            <MyoxusTextInput
              autoFocus
              data-testid="gantt-inline-rename"
              label={messages.ganttTaskLabel()}
              value={label}
              onChange={(value) => {
                setLabel(value);
                setRejected(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  confirm();
                }
              }}
            />
            {diagnostic ? (
              <MyoxusText tone="danger" typographySlot="caption">
                {diagnostic}
              </MyoxusText>
            ) : null}
            <Group justify="flex-end">
              <Button variant="plain" onClick={() => onClose(true)}>
                {messages.cancel()}
              </Button>
              <Button disabled={!preview.changed} onClick={confirm}>
                {messages.architectureApply()}
              </Button>
            </Group>
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}

function AddDraft({
  adding,
  onApply,
  onPreview,
  diagnosisMessage,
  model,
  onClose,
}: {
  readonly adding:
    | { kind: "section"; afterSectionId?: string }
    | { kind: "task" | "milestone"; sectionId: string; start: number };
  readonly onApply: MermaidGanttReactHostProps["onCommand"];
  readonly onPreview: MermaidGanttReactHostProps["onPreviewCommand"];
  readonly diagnosisMessage: (diagnosis: string) => string;
  readonly model: MermaidGanttReactHostProps["model"];
  readonly onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [start, setStart] = useState(() =>
    adding.kind === "section"
      ? ""
      : // Prefill in the diagram's own dateFormat, so the draft is valid for a
        // non-ISO document instead of forcing a YYYY-MM-DD value.
        formatGanttDateValue(adding.start, model.calendar.dateFormat),
  );
  const [sectionId, setSectionId] = useState(() =>
    adding.kind === "section" ? "" : adding.sectionId,
  );
  const [error, setError] = useState<string>();
  const command: GanttCommand =
    adding.kind === "section"
      ? {
          type: "section.add",
          title: label.trim(),
          afterSectionId: adding.afterSectionId,
        }
      : {
          type: "task.add",
          label: label.trim(),
          milestone: adding.kind === "milestone",
          sectionId,
          start: start.trim(),
        };
  const invalidStart =
    adding.kind !== "section" &&
    parseGanttDateValue(start, model.calendar.dateFormat) === null;
  const preview = label.trim() && !invalidStart ? onPreview(command) : null;
  const diagnostic =
    error ??
    (invalidStart && start.trim()
      ? messages.ganttDiagnosticInvalidDate(start)
      : preview && !preview.changed
        ? diagnosisMessage(preview.diagnosis)
        : undefined);
  const confirm = () => {
    if (!preview?.changed) return;
    const result = onApply(command);
    if (result.changed) onClose();
    else setError(diagnosisMessage(result.diagnosis));
  };
  const changeLabel = (value: string) => {
    setLabel(value);
    setError(undefined);
  };
  if (adding.kind === "section") {
    return (
      <Stack p="sm">
        <MyoxusTextInput
          autoFocus
          label={messages.ganttSectionTitle()}
          value={label}
          onChange={changeLabel}
        />
        {diagnostic ? <Alert color="myoxusError">{diagnostic}</Alert> : null}
        <Group justify="flex-end">
          <Button variant="plain" onClick={onClose}>
            {messages.cancel()}
          </Button>
          <Button disabled={!preview?.changed} onClick={confirm}>
            {messages.architectureApply()}
          </Button>
        </Group>
      </Stack>
    );
  }
  return (
    <Stack p="sm">
      <MyoxusTextInput
        autoFocus
        label={messages.ganttTaskLabel()}
        value={label}
        onChange={changeLabel}
      />
      <MyoxusTextInput
        description={model.calendar.dateFormat}
        label={messages.ganttStart()}
        value={start}
        onChange={(value) => {
          setStart(value);
          setError(undefined);
        }}
      />
      <Select
        comboboxProps={{ withinPortal: false }}
        label={messages.ganttSection()}
        data={model.sections.map((section, index) => ({
          label: `${index + 1} · ${section.title}`,
          value: section.id,
        }))}
        value={sectionId}
        onChange={(next) => {
          if (next) setSectionId(next);
          setError(undefined);
        }}
      />
      {diagnostic ? <Alert color="myoxusError">{diagnostic}</Alert> : null}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        <Button disabled={!preview?.changed} onClick={confirm}>
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}

function ReorderImpactDialog({
  apply,
  diagnosisMessage,
  onClose,
  pending,
  props,
}: {
  readonly apply: (command: GanttCommand | readonly GanttCommand[]) => boolean;
  readonly diagnosisMessage: (diagnosis: string) => string;
  readonly onClose: () => void;
  readonly pending: {
    affected: readonly { label: string; taskId: string }[];
    command: GanttCommand | readonly GanttCommand[];
  };
  readonly props: MermaidGanttReactHostProps;
}) {
  const preview = props.onPreviewCommand(pending.command);
  const planned = preview.rejectedModel ?? preview.model;
  const affected = props.model.tasks.filter((task) => {
    const before = props.model.intervals[task.recordId];
    const after = planned.intervals[task.recordId];
    return before?.start !== after?.start || before?.end !== after?.end;
  });
  const range = (recordId: string, model: typeof props.model) => {
    const interval = model.intervals[recordId];
    if (!interval) return "—";
    return `${formatGanttDateValue(interval.start, model.calendar.dateFormat)} → ${formatGanttDateValue(interval.end, model.calendar.dateFormat, undefined, "end")}`;
  };
  return (
    <Stack p="sm" w={380}>
      <MyoxusText typographySlot="body-small">
        {messages.ganttReorderImpactDependents()}
      </MyoxusText>
      {affected.map((entry) => (
        <Stack gap={2} key={entry.recordId}>
          <MyoxusText typographySlot="dense-label">{entry.label}</MyoxusText>
          <MyoxusText tone="muted" typographySlot="caption">
            {`${messages.ganttImpactBefore()}: ${range(entry.recordId, props.model)}`}
          </MyoxusText>
          <MyoxusText tone="muted" typographySlot="caption">
            {`${messages.ganttImpactAfter()}: ${range(entry.recordId, planned)}`}
          </MyoxusText>
        </Stack>
      ))}
      {!preview.changed ? (
        <MyoxusText tone="danger" typographySlot="caption">
          {diagnosisMessage(preview.diagnosis)}
        </MyoxusText>
      ) : null}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={props.readonly || !preview.changed}
          onClick={() => {
            if (apply(pending.command)) onClose();
          }}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}

export function createMermaidGanttRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidGanttReactHostProps> {
  return {
    token: mermaidGanttRendererToken,
    render: (props) => reactToLit(<MermaidGanttRuntime props={props} />, true),
  };
}
