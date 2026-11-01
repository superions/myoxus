// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseFieldKind, databaseRowQuery } from "@myoxus/graphql";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import { classifyDatabaseError } from "../route-state";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  MyoxusTextInput,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Checkbox,
  Select,
  useConfirmModal,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Group,
  Text,
  Button,
  EmptyState,
  Stack,
  TimelineView,
  type TimeTimelineTimeIntent,
} from "@myoxus/ui-facade";
import { useEffect, useRef, useState } from "react";
import {
  DatabaseViewFieldValues,
  DatabaseRowActionMenu,
  useDeleteDatabaseRowAction,
  useDatabaseRowDetail,
} from "../row-detail";
import {
  DatabasePresenceTarget,
  useDatabasePresenceContext,
} from "../presence";
import {
  getVisibleFieldIds,
  getCellValue,
  getCellPrimitiveValue,
  formatCellValue,
} from "../model";
import type { DatabaseViewPrimaryAction } from "../shared";
import type { DatabaseChangeHandler } from "../shared/change-invalidation";
import type { DatabaseRecord, DatabaseRowRecord, DatabaseView } from "../types";
import {
  timelineIntervalLabel,
  timelineTimePreviewValues,
  projectDatabaseTimeline,
} from "./projection";
import {
  useTimelineMutations,
  timelineTitleDraft,
  timelineTitleWritable,
  timelineTitleConflict,
  type TimelineTitleDraft,
  type TimelineCreateDraft,
  timelineCreateDraft,
  timelineCreateWritable,
  timelineCreateDisplay,
  timelineCreateSetBoundary,
  timelineTimeDraft,
  timelineTimeWritable,
  timelineTimeSettings,
  timelineTimeDisplay,
  timelineTimeSetBoundary,
  timelineTimeSetMetadata,
  timelineTimeSetRange,
  timelineTimeInterval,
  type TimelineTimeDraft,
  timelineTimeIntent,
  timelineTimeConflict,
  timelineCurrentTime,
  timelineTimeError,
} from "./mutations";
export { databaseTimelineGroups } from "./projection";

const diagnosticKeys = {
  "missing-start": "com.myoxus.database.schedule.missing-start",
  "invalid-start": "com.myoxus.database.schedule.invalid-start",
  "missing-end": "com.myoxus.database.schedule.missing-end",
  "invalid-end": "com.myoxus.database.schedule.invalid-end",
  "end-before-start": "com.myoxus.database.schedule.end-before-start",
} as const;

/** Shared Workbench/Embed composition; time geometry stays inside the Facade. */
export function DatabaseTimelineView({
  canEdit,
  workspaceId,
  databaseId,
  date,
  requestedDate,
  requestedView,
  onChanged,
  record,
  rows,
  view,
  loading = false,
  onConfigureFields,
  hasActiveQuery = false,
  search = "",
  activeFilterCount = 0,
  onClearQuery,
  onShowToday,
  onChooseDate,
  onToolbarActionChange,
}: {
  canEdit: boolean;
  workspaceId: string;
  databaseId: string;
  date: string;
  requestedDate?: string;
  requestedView?: DatabaseView;
  onChanged: DatabaseChangeHandler;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  view: DatabaseView;
  loading?: boolean;
  onConfigureFields?: () => void;
  hasActiveQuery?: boolean;
  search?: string;
  activeFilterCount?: number;
  onClearQuery?: () => void;
  onShowToday?: () => void;
  onChooseDate?: () => void;
  onToolbarActionChange?: (action: DatabaseViewPrimaryAction | null) => void;
}) {
  const t = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const { openConfirmModal } = useConfirmModal();
  const [rename, setRename] = useState<TimelineTitleDraft | null>(null);
  const [timeDraft, setTimeDraft] = useState<TimelineTimeDraft | null>(null);
  const [createDraft, setCreateDraft] = useState<TimelineCreateDraft | null>(
    null,
  );
  const createConfirmedRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const draftRowId = timeDraft?.item.row.row.id ?? rename?.row.row.id;
  const windowDraftRow = rows.find((row) => row.row.id === draftRowId);
  // A draft may leave the query window. Resolve only that identity through
  // the canonical peek; never merge its readback into the projected row list.
  const outsideDraftQuery = useQuery(
    draftRowId && !windowDraftRow
      ? {
          query: databaseRowQuery,
          variables: { workspaceId, databaseId, rowId: draftRowId },
        }
      : undefined,
    { suspense: false, suppressErrorNotification: true },
  );
  const outsideStatus = outsideDraftQuery.error
    ? classifyDatabaseError(outsideDraftQuery.error)
    : null;
  const outsideRow = outsideDraftQuery.data?.workspace?.databaseRow;
  const draftRows = windowDraftRow
    ? rows
    : outsideRow && !outsideStatus
      ? [...rows, outsideRow]
      : rows;
  const latest = useRef({ record, view, rows: draftRows, canEdit });
  latest.current = {
    record,
    view: requestedView ?? view,
    rows: draftRows,
    canEdit,
  };
  const draftChanged: DatabaseChangeHandler = async (reason) => {
    await onChanged(reason);
    if (draftRowId && !windowDraftRow) await outsideDraftQuery.mutate();
  };
  const actionError = (failure: unknown) => {
    const status = classifyDatabaseError(failure);
    setError(
      t[
        status === "offline"
          ? "com.myoxus.database.embed.offline"
          : status === "forbidden"
            ? "com.myoxus.no-permission"
            : status === "missing"
              ? "com.myoxus.database.row_detail.missing"
              : "com.myoxus.common.operation-failed"
      ](),
    );
  };
  const titleWritable = (draft: TimelineTitleDraft) => {
    const current = latest.current;
    return timelineTitleWritable(
      draft,
      current.record,
      current.view,
      current.rows,
      current.canEdit,
    );
  };
  const createWritable = (draft: TimelineCreateDraft) => {
    const current = latest.current;
    return timelineCreateWritable(
      draft,
      current.record,
      current.view,
      current.canEdit,
    );
  };
  const timeWritable = (draft: TimelineTimeDraft) => {
    const current = latest.current;
    return timelineTimeWritable(
      draft,
      current.record,
      current.view,
      current.rows,
      current.canEdit,
    );
  };
  const mutations = useTimelineMutations(
    databaseId,
    workspaceId,
    draftChanged,
    titleWritable,
    createWritable,
    timeWritable,
  );
  useEffect(() => {
    if (!draftRowId || windowDraftRow) return;
    if (outsideStatus === "forbidden" || outsideRow?.redacted) {
      mutations.discardConflict(draftRowId);
      setRename(null);
      setTimeDraft(null);
      setError(t["com.myoxus.database.row_detail.forbidden"]());
    } else if (
      outsideStatus === "missing" ||
      outsideRow?.row.deletedAt ||
      (outsideDraftQuery.data && !outsideRow)
    ) {
      mutations.discardConflict(draftRowId);
      setRename(null);
      setTimeDraft(null);
      setError(t["com.myoxus.database.row_detail.missing"]());
    }
  }, [
    draftRowId,
    windowDraftRow,
    outsideStatus,
    outsideRow,
    outsideDraftQuery.data,
    t,
  ]);
  const focusEntry = (id: string) =>
    requestAnimationFrame(() => {
      const entry = [
        ...(rootRef.current?.querySelectorAll<HTMLElement>(
          "[data-time-entry-id]",
        ) ?? []),
      ].find((element) => element.dataset.timeEntryId === id);
      (entry ?? rootRef.current)?.focus();
    });
  const closeRename = () => {
    if (rename) focusEntry(rename.row.row.id);
    setRename(null);
    setError(null);
  };
  const readyForIntent =
    !loading &&
    (!requestedDate || requestedDate === date) &&
    (!requestedView ||
      (requestedView.id === view.id &&
        requestedView.editRevision === view.editRevision));
  const beginRename = (id: string) => {
    if (
      !canEdit ||
      !readyForIntent ||
      savingRef.current ||
      createDraft ||
      timeDraft
    )
      return;
    const row = rows.find(
      (row) => row.row.id === id && !row.redacted && !row.row.deletedAt,
    );
    const draft = row ? timelineTitleDraft(row, view) : null;
    if (draft && titleWritable(draft)) {
      setSelectedId(id);
      setError(null);
      setRename(draft);
    }
  };
  const applyRename = async () => {
    if (
      !rename ||
      savingRef.current ||
      !titleWritable(rename) ||
      !rename.value.trim()
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (await mutations.rename(rename, closeRename)) closeRename();
    } catch (failure) {
      actionError(failure);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const deleteRow = useDeleteDatabaseRowAction(databaseId, onChanged, () => {
    setSelectedId(null);
    rootRef.current?.focus();
  });
  const requestDelete = (row: DatabaseRowRecord) => {
    if (
      !canEdit ||
      !readyForIntent ||
      row.redacted ||
      row.row.deletedAt ||
      savingRef.current
    )
      return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : rootRef.current;
    openConfirmModal({
      returnFocusRef,
      title: t["com.myoxus.database.row.delete"](),
      description: row.row.title,
      confirmText: t["com.myoxus.database.row.delete"](),
      cancelText: t["Cancel"](),
      onCancel: () => focusEntry(row.row.id),
      onConfirm: async () => {
        const current = latest.current;
        const readable = current.rows.find(
          (item) => item.row.id === row.row.id,
        );
        if (
          !current.canEdit ||
          !readable ||
          readable.redacted ||
          readable.row.deletedAt ||
          savingRef.current
        )
          return;
        savingRef.current = true;
        setSaving(true);
        try {
          await deleteRow(row);
        } catch (failure) {
          actionError(failure);
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      },
    });
  };
  useEffect(() => {
    if (!rename) return;
    const row = rows.find((row) => row.row.id === rename.row.row.id);
    if (
      (requestedView ?? view).id !== rename.view.id ||
      row?.redacted ||
      row?.row.deletedAt
    ) {
      mutations.discardConflict(rename.row.row.id);
      setRename(null);
      setError(null);
    }
  }, [rename, requestedView, view, rows]);

  const detail = useDatabaseRowDetail();
  const presence = useDatabasePresenceContext();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const projection = projectDatabaseTimeline(
    record,
    rows,
    view,
    date,
    t.language,
    selectedId,
    t["com.myoxus.database.temporal.projection-readonly"](),
    timeDraft?.intent ? timelineTimeInterval(timeDraft) : null,
  );
  // A query-empty Window cannot prove global emptiness; only the server count can.
  const databaseEmpty = record.rowCount === 0;
  const closeTime = () => {
    if (savingRef.current) return;
    if (timeDraft) focusEntry(timeDraft.item.row.row.id);
    setTimeDraft(null);
    setError(null);
  };
  const beginTime = (id: string) => {
    const item = projection.intervalById.get(id);
    if (
      !readyForIntent ||
      savingRef.current ||
      !canEdit ||
      rename ||
      createDraft ||
      timeDraft ||
      !item ||
      !projection.startField
    )
      return;
    const draft = timelineTimeDraft(
      item,
      view,
      projection.startField,
      projection.endField,
    );
    if (!timeWritable(draft)) return;
    closeRename();
    setCreateDraft(null);
    setTimeDraft(draft);
    setSelectedId(id);
    setError(null);
  };
  const applyTime = async () => {
    if (
      !timeDraft ||
      !readyForIntent ||
      savingRef.current ||
      !timelineTimeInterval(timeDraft) ||
      !timeWritable(timeDraft)
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const recovered = () => {
      setTimeDraft(null);
      focusEntry(timeDraft.item.row.row.id);
    };
    try {
      if (
        await mutations.time(
          timeDraft,
          timelineIntervalLabel(
            timelineTimeInterval(timeDraft)!,
            t.language,
            timeDraft.endField,
            timelineTimeSettings(timeDraft, "end"),
          ),
          (current) =>
            current
              ? timelineIntervalLabel(current, t.language, timeDraft.endField)
              : t["com.myoxus.database.schedule.missing-start"](),
          recovered,
        )
      )
        recovered();
    } catch (failure) {
      actionError(failure);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    if (!timeDraft) return;
    const row = rows.find((row) => row.row.id === timeDraft.item.row.row.id);
    if (
      (requestedView ?? view).id !== timeDraft.view.id ||
      row?.redacted ||
      row?.row.deletedAt
    ) {
      mutations.discardConflict(timeDraft.item.row.row.id);
      setTimeDraft(null);
      setError(null);
    }
  }, [timeDraft, requestedView, view, rows]);
  const previewTime = (intent: TimeTimelineTimeIntent) => {
    if (
      savingRef.current ||
      rename ||
      createDraft ||
      (timeDraft && !timeDraft.intent) ||
      !canEdit
    )
      return;
    if (!timeDraft && !readyForIntent) return;
    if (
      timeDraft &&
      timelineTimeConflict(timeDraft, draftRows) &&
      timeDraft.intent?.mode !== intent.mode
    )
      return;
    const item = projection.intervalById.get(intent.id);
    if (!item || !projection.startField) return;
    const basis =
      timeDraft ??
      timelineTimeDraft(item, view, projection.startField, projection.endField);
    if (!timeWritable(basis)) return;
    setTimeDraft(timelineTimeIntent(basis, intent));
    setSelectedId(intent.id);
    setError(null);
  };
  const cancelCreate = () => {
    if (savingRef.current) return;
    setCreateDraft(null);
    createConfirmedRef.current = null;
    setError(null);
    returnFocusRef.current?.focus();
  };
  const beginPlace = () => {
    if (
      !readyForIntent ||
      !canEdit ||
      savingRef.current ||
      rename ||
      timeDraft ||
      createDraft
    )
      return;
    const draft = timelineCreateDraft(record, view, projection.axis.start);
    if (!draft) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : rootRef.current;
    closeRename();
    setTimeDraft(null);
    setCreateDraft(draft);
    createConfirmedRef.current = null;
    requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector<HTMLElement>("[data-time-placement-plane]")
        ?.focus(),
    );
  };
  const createValid = Boolean(
    createDraft &&
    Number.isFinite(createDraft.start) &&
    (createDraft.end === null ||
      (Number.isFinite(createDraft.end) &&
        createDraft.end >= createDraft.start)),
  );
  const applyCreate = async () => {
    if (!createDraft || savingRef.current) return;
    if (
      !createConfirmedRef.current &&
      (!createValid ||
        !createWritable(createDraft) ||
        createDraft.uncertain ||
        !createDraft.title.trim())
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      let id = createConfirmedRef.current;
      if (id) await onChanged({ kind: "row_created", target: { rowId: id } });
      else
        id = await mutations.create(
          createDraft,
          (confirmed) => {
            createConfirmedRef.current = confirmed;
            setCreateDraft((current) =>
              current ? { ...current, confirmedId: confirmed } : null,
            );
          },
          cancelCreate,
        );
      if (id) {
        setCreateDraft(null);
        createConfirmedRef.current = null;
        setSelectedId(id);
        focusEntry(id);
      }
    } catch (failure) {
      const known = Boolean(
        (failure as { extensions?: { code?: unknown } })?.extensions?.code,
      );
      if (!known && !createConfirmedRef.current)
        setCreateDraft((current) =>
          current ? { ...current, uncertain: true } : null,
        );
      actionError(failure);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    if (createDraft && (requestedView ?? view).id !== createDraft.view.id) {
      setCreateDraft(null);
      createConfirmedRef.current = null;
      setError(null);
    }
  }, [createDraft, requestedView, view]);
  useEffect(() => {
    const available = timelineCreateDraft(record, view, projection.axis.start);
    onToolbarActionChange?.(
      canEdit
        ? {
            label: t["com.myoxus.database.row.add"](),
            disabled:
              !available ||
              !readyForIntent ||
              Boolean(createDraft || rename || timeDraft) ||
              saving,
            disabledReason: !available
              ? t["com.myoxus.database.temporal.projection-readonly"]()
              : undefined,
            onSelect: beginPlace,
          }
        : null,
    );
  });
  useEffect(() => () => onToolbarActionChange?.(null), [onToolbarActionChange]);
  useEffect(() => {
    if (selectedId && !projection.intervalById.has(selectedId))
      setSelectedId(null);
  }, [selectedId, projection.intervalById]);
  const open = (id: string) => {
    const row = rows.find(
      (row) => row.row.id === id && !row.redacted && !row.row.deletedAt,
    );
    if (row)
      detail?.open(
        row,
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      );
  };
  if (!projection.validConfig)
    return (
      <EmptyState
        title={t["com.myoxus.database.timeline.invalid-title"]()}
        description={t["com.myoxus.database.timeline.invalid-description"]()}
        cta={
          onConfigureFields ? (
            <Button onClick={onConfigureFields}>
              {t["com.myoxus.database.fields"]()}
            </Button>
          ) : undefined
        }
      />
    );
  const visibleIds = getVisibleFieldIds(record, view);
  return (
    <Stack
      ref={rootRef}
      tabIndex={-1}
      data-testid="database-timeline-view"
      data-myoxus-editor-keyboard-owner="database-timeline"
      aria-busy={loading}
    >
      {error && !rename && !createDraft && !timeDraft ? (
        <Alert>{error}</Alert>
      ) : null}
      {createDraft && !createDraft.chosen ? (
        <Alert>{t["com.myoxus.database.timeline.place-instruction"]()}</Alert>
      ) : null}
      {draftRowId &&
      !windowDraftRow &&
      outsideStatus !== "forbidden" &&
      outsideStatus !== "missing" &&
      !outsideRow?.redacted &&
      !outsideRow?.row.deletedAt ? (
        <Alert title={t["com.myoxus.database.timeline.draft-outside-window"]()}>
          <Stack>
            <Text>
              {rename?.value ??
                (timeDraft && timelineTimeInterval(timeDraft)
                  ? timelineIntervalLabel(
                      timelineTimeInterval(timeDraft)!,
                      t.language,
                      timeDraft.endField,
                      timelineTimeSettings(timeDraft, "end"),
                    )
                  : t["com.myoxus.database.row_detail.unavailable"]())}
            </Text>
            {(rename && timelineTitleConflict(rename, draftRows) !== null) ||
            (timeDraft && timelineTimeConflict(timeDraft, draftRows)) ? (
              <Alert title={t["com.myoxus.database.conflict.title"]()}>
                <Text>
                  {t["com.myoxus.database.conflict.server-value"]()}:{" "}
                  {rename
                    ? timelineTitleConflict(rename, draftRows)
                    : timeDraft && timelineCurrentTime(timeDraft, draftRows)
                      ? timelineIntervalLabel(
                          timelineCurrentTime(timeDraft, draftRows)!,
                          t.language,
                          timeDraft.endField,
                        )
                      : t["com.myoxus.database.row_detail.unavailable"]()}
                </Text>
              </Alert>
            ) : null}
            {error ? <Alert>{error}</Alert> : null}
            {outsideStatus ? (
              <Text>
                {t[
                  outsideStatus === "offline"
                    ? "com.myoxus.database.embed.offline"
                    : "com.myoxus.database.row_detail.unavailable"
                ]()}
              </Text>
            ) : null}
            <Group>
              <Button
                disabled={
                  saving ||
                  !outsideRow ||
                  Boolean(outsideStatus) ||
                  !readyForIntent ||
                  !(rename
                    ? titleWritable(rename)
                    : timeDraft &&
                      timeWritable(timeDraft) &&
                      timelineTimeInterval(timeDraft))
                }
                onClick={() => void (rename ? applyRename() : applyTime())}
              >
                {t["Apply"]()}
              </Button>
              <Button
                disabled={saving}
                variant="secondary"
                onClick={() =>
                  void outsideDraftQuery.mutate().catch(actionError)
                }
              >
                {t["Retry"]()}
              </Button>
              <Button
                disabled={saving}
                variant="secondary"
                onClick={() => (rename ? closeRename() : closeTime())}
              >
                {t["Cancel"]()}
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : null}
      {projection.diagnostics.length ? (
        <Accordion>
          <AccordionItem value="problems">
            <AccordionControl>
              {t["com.myoxus.database.timeline.problems"]({
                count: String(projection.diagnostics.length),
              })}
            </AccordionControl>
            <AccordionPanel>
              <Stack>
                {projection.diagnostics.map((item) => (
                  <Group key={item.row.row.id}>
                    <Button
                      variant="plain"
                      onClick={() => open(item.row.row.id)}
                    >
                      {item.row.row.title}
                    </Button>
                    <Text>{t[diagnosticKeys[item.reason]]()}</Text>
                  </Group>
                ))}
              </Stack>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      ) : null}
      <TimelineView
        axis={projection.axis}
        accessibility={{ title: t["com.myoxus.database.view.timeline"]() }}
        now={now}
        timeLabels={{
          move: t["com.myoxus.rootAppSidebar.explorer.drop-effect.move"](),
          start: t["com.myoxus.database.schedule.resize-start"](),
          end: t["com.myoxus.database.schedule.resize-end"](),
          apply: t["Apply"](),
          cancel: t["Cancel"](),
        }}
        onTimePreview={previewTime}
        onTimeApply={() => void applyTime()}
        onTimeCancel={closeTime}
        groups={projection.groups.map((group) => ({
          ...group,
          entries: group.entries.map((entry) => {
            const row = projection.intervalById.get(entry.id)!.row;
            const fields = record.fields.filter(
              (field) =>
                visibleIds.includes(field.id) &&
                ![
                  view.config.timeline?.titleFieldId,
                  projection.startField?.id,
                  projection.endField?.id,
                ].includes(field.id) &&
                getCellPrimitiveValue(row, field) !== null &&
                Boolean(getCellValue(row, field.id)),
            );
            return {
              ...entry,
              accessibleLabel: [
                entry.accessibleLabel,
                ...fields
                  .filter(
                    (field) => field.fieldType === DatabaseFieldKind.Status,
                  )
                  .map((field) => formatCellValue(row, field, t.language)),
                entry.selected ? t["com.myoxus.selectPage.selected"]() : null,
                !canEdit
                  ? t["com.myoxus.share-menu.option.link.readonly"]()
                  : null,
              ]
                .filter(Boolean)
                .join(", "),
              timeActions: entry.timeActions
                ? {
                    ...entry.timeActions,
                    move: {
                      ...entry.timeActions.move,
                      enabled:
                        entry.timeActions.move.enabled &&
                        canEdit &&
                        readyForIntent &&
                        !saving &&
                        !rename &&
                        !createDraft &&
                        (!timeDraft ||
                          (Boolean(timeDraft.intent) &&
                            timeDraft.item.row.row.id === entry.id)) &&
                        !(
                          timeDraft &&
                          timelineTimeConflict(timeDraft, draftRows)
                        ),
                    },
                    start: {
                      ...entry.timeActions.start,
                      enabled:
                        entry.timeActions.start.enabled &&
                        canEdit &&
                        readyForIntent &&
                        !saving &&
                        !rename &&
                        !createDraft &&
                        (!timeDraft ||
                          (Boolean(timeDraft.intent) &&
                            timeDraft.item.row.row.id === entry.id)) &&
                        !(
                          timeDraft &&
                          timelineTimeConflict(timeDraft, draftRows)
                        ),
                    },
                    end: {
                      ...entry.timeActions.end,
                      enabled:
                        entry.timeActions.end.enabled &&
                        canEdit &&
                        readyForIntent &&
                        !saving &&
                        !rename &&
                        !createDraft &&
                        (!timeDraft ||
                          (Boolean(timeDraft.intent) &&
                            timeDraft.item.row.row.id === entry.id)) &&
                        !(
                          timeDraft &&
                          timelineTimeConflict(timeDraft, draftRows)
                        ),
                    },
                  }
                : undefined,
              timePreview:
                timeDraft?.intent && timeDraft.item.row.row.id === entry.id
                  ? {
                      ...timeDraft.intent,
                      valid: Boolean(
                        timelineTimeInterval(timeDraft) &&
                        timeWritable(timeDraft) &&
                        readyForIntent,
                      ),
                      error:
                        error ??
                        (timelineTimeConflict(timeDraft, draftRows)
                          ? t["com.myoxus.database.conflict.description"]()
                          : undefined),
                      message: timelineTimeInterval(timeDraft)
                        ? t["com.myoxus.database.schedule.preview"]({
                            ...timelineTimePreviewValues(
                              timeDraft.item,
                              timelineTimeInterval(timeDraft)!,
                              timeDraft.endField,
                              timeDraft.intent.mode === "resize-start"
                                ? entry.timeActions!.startStep
                                : timeDraft.intent.mode === "resize-end"
                                  ? entry.timeActions!.endStep
                                  : entry.timeActions!.moveStep,
                              t.language,
                            ),
                            group:
                              group.label ??
                              t[
                                "com.myoxus.page.display.grouping.no-grouping"
                              ](),
                          })
                        : t[
                            timelineTimeError(timeDraft) === "end-before-start"
                              ? "com.myoxus.database.schedule.end-before-start"
                              : "com.myoxus.database.schedule.invalid-local-time"
                          ](),
                    }
                  : undefined,
              rename: {
                enabled:
                  canEdit &&
                  readyForIntent &&
                  !saving &&
                  !timeDraft &&
                  !createDraft,
              },
              labelContent:
                rename?.row.row.id === entry.id ? (
                  <Stack>
                    <MyoxusTextInput
                      autoFocus
                      aria-label={t["Title"]()}
                      value={rename.value}
                      disabled={saving}
                      readOnly={!titleWritable(rename)}
                      onChange={(value) => setRename({ ...rename, value })}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Escape" && !saving) {
                          event.preventDefault();
                          closeRename();
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void applyRename();
                        }
                      }}
                    />
                    {timelineTitleConflict(rename, draftRows) !== null ? (
                      <Alert title={t["com.myoxus.database.conflict.title"]()}>
                        <Text>
                          {t["com.myoxus.database.conflict.local-value"]()}:{" "}
                          {rename.value}
                        </Text>
                        <Text>
                          {t["com.myoxus.database.conflict.server-value"]()}:{" "}
                          {timelineTitleConflict(rename, draftRows)}
                        </Text>
                      </Alert>
                    ) : null}
                    {!titleWritable(rename) ? (
                      <Alert>
                        {t["com.myoxus.database.conflict.description"]()}
                      </Alert>
                    ) : null}
                    {error ? <Alert>{error}</Alert> : null}
                    <Group>
                      <Button
                        disabled={
                          saving ||
                          !titleWritable(rename) ||
                          !rename.value.trim()
                        }
                        onClick={() => void applyRename()}
                      >
                        {t["Apply"]()}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={saving}
                        onClick={closeRename}
                      >
                        {t["Cancel"]()}
                      </Button>
                    </Group>
                  </Stack>
                ) : undefined,
              dateEditor:
                canEdit && (projection.startEditable || projection.endEditable)
                  ? {
                      label: t["Date"](),
                      enabled:
                        !saving &&
                        readyForIntent &&
                        !rename &&
                        !createDraft &&
                        (!timeDraft ||
                          (!timeDraft.intent &&
                            timeDraft.item.row.row.id === entry.id)),
                      opened:
                        !timeDraft?.intent &&
                        timeDraft?.item.row.row.id === entry.id,
                      onOpen: () => beginTime(entry.id),
                      onClose: closeTime,
                      content:
                        timeDraft?.item.row.row.id === entry.id ? (
                          <Stack
                            data-testid="database-timeline-time-draft"
                            data-myoxus-editor-keyboard-owner="database-timeline"
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Escape") {
                                event.preventDefault();
                                closeTime();
                              }
                            }}
                          >
                            <Text>
                              {timelineTimeInterval(timeDraft)
                                ? timelineIntervalLabel(
                                    timelineTimeInterval(timeDraft)!,
                                    t.language,
                                    timeDraft.endField,
                                    timelineTimeSettings(timeDraft, "end"),
                                  )
                                : t[
                                    timelineTimeError(timeDraft) ===
                                    "end-before-start"
                                      ? "com.myoxus.database.schedule.end-before-start"
                                      : "com.myoxus.database.schedule.invalid-local-time"
                                  ]()}
                            </Text>
                            {timelineTimeConflict(timeDraft, draftRows) ? (
                              <Alert
                                title={t[
                                  "com.myoxus.database.conflict.title"
                                ]()}
                              >
                                <Text>
                                  {t[
                                    "com.myoxus.database.conflict.local-value"
                                  ]()}
                                  :{" "}
                                  {timelineTimeInterval(timeDraft)
                                    ? timelineIntervalLabel(
                                        timelineTimeInterval(timeDraft)!,
                                        t.language,
                                        timeDraft.endField,
                                        timelineTimeSettings(timeDraft, "end"),
                                      )
                                    : t[
                                        "com.myoxus.database.schedule.invalid-local-time"
                                      ]()}
                                </Text>
                                <Text>
                                  {t[
                                    "com.myoxus.database.conflict.server-value"
                                  ]()}
                                  :{" "}
                                  {timelineCurrentTime(timeDraft, draftRows)
                                    ? timelineIntervalLabel(
                                        timelineCurrentTime(
                                          timeDraft,
                                          draftRows,
                                        )!,
                                        t.language,
                                        timeDraft.endField,
                                      )
                                    : t[
                                        "com.myoxus.database.row_detail.unavailable"
                                      ]()}
                                </Text>
                              </Alert>
                            ) : null}
                            {(["start", "end"] as const)
                              .filter(
                                (edge) =>
                                  edge === "start" ||
                                  timelineTimeInterval(timeDraft)?.end !== null,
                              )
                              .map((edge) => {
                                const settings = timelineTimeSettings(
                                  timeDraft,
                                  edge,
                                );
                                const label =
                                  edge === "start"
                                    ? t[
                                        "com.myoxus.database.view.timeline-start"
                                      ]()
                                    : t[
                                        "com.myoxus.database.view.timeline-end"
                                      ]();
                                const value = timelineTimeDisplay(
                                  timeDraft,
                                  edge,
                                );
                                const change = (input: string | null) =>
                                  setTimeDraft(
                                    timelineTimeSetBoundary(
                                      timeDraft,
                                      edge,
                                      input,
                                    ),
                                  );
                                return (
                                  <Stack key={edge}>
                                    {!settings.editable ? (
                                      <Text>
                                        {t[
                                          "com.myoxus.database.temporal.projection-readonly"
                                        ]()}
                                      </Text>
                                    ) : null}
                                    {settings.allDay ? (
                                      <LocalizedDateInput
                                        locale={t.language}
                                        label={label}
                                        aria-label={label}
                                        value={value}
                                        disabled={
                                          saving ||
                                          !settings.editable ||
                                          !timeWritable(timeDraft)
                                        }
                                        popoverProps={{ withinPortal: false }}
                                        onChange={change}
                                      />
                                    ) : (
                                      <LocalizedDateTimeInput
                                        withSeconds
                                        valueFormat="L HH:mm:ss"
                                        locale={t.language}
                                        label={label}
                                        aria-label={label}
                                        value={value}
                                        disabled={
                                          saving ||
                                          !settings.editable ||
                                          !timeWritable(timeDraft)
                                        }
                                        popoverProps={{ withinPortal: false }}
                                        onChange={change}
                                      />
                                    )}
                                    {settings.field.fieldType ===
                                      DatabaseFieldKind.DateTime &&
                                    (edge === "start" || timeDraft.endField) ? (
                                      <>
                                        <Checkbox
                                          label={t[
                                            "com.myoxus.integration.calendar.all-day"
                                          ]()}
                                          checked={settings.allDay}
                                          disabled={
                                            saving ||
                                            !settings.editable ||
                                            !timeWritable(timeDraft) ||
                                            !timelineTimeInterval(timeDraft)
                                          }
                                          onChange={(_, allDay) =>
                                            setTimeDraft(
                                              timelineTimeSetMetadata(
                                                timeDraft,
                                                edge,
                                                { allDay },
                                              ),
                                            )
                                          }
                                        />
                                        <Select
                                          label={t[
                                            "com.myoxus.common.timezone"
                                          ]()}
                                          aria-label={t[
                                            "com.myoxus.common.timezone"
                                          ]()}
                                          value={settings.timeZone}
                                          searchable
                                          data={[
                                            ...new Set([
                                              settings.timeZone,
                                              "UTC",
                                              ...Intl.supportedValuesOf(
                                                "timeZone",
                                              ),
                                            ]),
                                          ].map((zone) => ({
                                            value: zone,
                                            label: zone,
                                          }))}
                                          disabled={
                                            saving ||
                                            !settings.editable ||
                                            !timeWritable(timeDraft) ||
                                            !timelineTimeInterval(timeDraft)
                                          }
                                          comboboxProps={{
                                            withinPortal: false,
                                          }}
                                          onChange={(timeZone) => {
                                            if (timeZone)
                                              setTimeDraft(
                                                timelineTimeSetMetadata(
                                                  timeDraft,
                                                  edge,
                                                  { timeZone },
                                                ),
                                              );
                                          }}
                                        />
                                      </>
                                    ) : null}
                                  </Stack>
                                );
                              })}
                            <Checkbox
                              label={t["com.myoxus.database.schedule.range"]()}
                              checked={
                                timelineTimeInterval(timeDraft)?.end !== null
                              }
                              disabled={
                                saving ||
                                !timelineTimeSettings(timeDraft, "end")
                                  .editable ||
                                !timelineTimeInterval(timeDraft)
                              }
                              onChange={(_, enabled) =>
                                setTimeDraft(
                                  timelineTimeSetRange(timeDraft, enabled),
                                )
                              }
                            />
                            {timeDraft.endField &&
                            timelineTimeInterval(timeDraft)?.end === null &&
                            timeDraft.item.end !== null ? (
                              <Alert>
                                {t[
                                  "com.myoxus.database.schedule.clear-end-cell"
                                ]()}
                              </Alert>
                            ) : null}
                            {!timelineTimeInterval(timeDraft) ||
                            !timeWritable(timeDraft) ? (
                              <Alert>
                                {t[
                                  !timeWritable(timeDraft)
                                    ? "com.myoxus.database.conflict.description"
                                    : timelineTimeError(timeDraft) ===
                                        "end-before-start"
                                      ? "com.myoxus.database.schedule.end-before-start"
                                      : "com.myoxus.database.schedule.invalid-local-time"
                                ]()}
                              </Alert>
                            ) : null}
                            {error ? <Alert>{error}</Alert> : null}
                            <Group>
                              <Button
                                disabled={
                                  saving ||
                                  !readyForIntent ||
                                  !timelineTimeInterval(timeDraft) ||
                                  !timeWritable(timeDraft)
                                }
                                onClick={() => void applyTime()}
                              >
                                {t["Apply"]()}
                              </Button>
                              <Button
                                variant="secondary"
                                disabled={saving}
                                onClick={closeTime}
                              >
                                {t["Cancel"]()}
                              </Button>
                            </Group>
                          </Stack>
                        ) : undefined,
                    }
                  : undefined,
              actions: (
                <Group>
                  {canEdit && !rename ? (
                    <Button
                      variant="plain"
                      disabled={!readyForIntent || saving}
                      onClick={() => beginRename(entry.id)}
                    >
                      {t["Rename"]()}
                    </Button>
                  ) : null}
                  <DatabaseRowActionMenu
                    record={record}
                    onChanged={onChanged}
                    canEdit={canEdit}
                    row={row}
                    onDelete={
                      canEdit && !rename ? () => requestDelete(row) : undefined
                    }
                  />
                </Group>
              ),
              content: (
                <DatabasePresenceTarget rowId={entry.id} viewId={view.id}>
                  <DatabaseViewFieldValues
                    databaseId={databaseId}
                    fields={fields}
                    onChanged={onChanged}
                    record={record}
                    row={row}
                    rows={rows}
                    readonly
                    compact
                  />
                </DatabasePresenceTarget>
              ),
            };
          }),
        }))}
        placement={
          createDraft
            ? {
                active: true,
                chosen: createDraft.chosen,
                start: Number.isFinite(createDraft.start)
                  ? createDraft.start
                  : projection.axis.start,
                end: createDraft.end,
                step: [createDraft.startField, createDraft.endField].some(
                  (field) => field?.fieldType === DatabaseFieldKind.Date,
                )
                  ? 86400000
                  : projection.axis.step,
                label: t["com.myoxus.database.row.add"](),
                onPreview: (start, end) =>
                  setCreateDraft((current) =>
                    current
                      ? {
                          ...current,
                          start,
                          end,
                          startInput: undefined,
                          endInput: undefined,
                        }
                      : null,
                  ),
                onChoose: () =>
                  setCreateDraft((current) =>
                    current ? { ...current, chosen: true } : null,
                  ),
                onCancel: cancelCreate,
                content: (
                  <Stack
                    data-testid="database-timeline-create-draft"
                    data-myoxus-editor-keyboard-owner="database-timeline"
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelCreate();
                      }
                    }}
                  >
                    <MyoxusTextInput
                      autoFocus
                      aria-label={t["Title"]()}
                      label={t["Title"]()}
                      value={createDraft.title}
                      disabled={saving || Boolean(createDraft.confirmedId)}
                      onChange={(title) =>
                        setCreateDraft({ ...createDraft, title })
                      }
                    />
                    {(["start", "end"] as const)
                      .filter(
                        (edge) => edge === "start" || createDraft.end !== null,
                      )
                      .map((edge) => {
                        const field =
                          edge === "start"
                            ? createDraft.startField
                            : (createDraft.endField ?? createDraft.startField);
                        const label =
                          edge === "start"
                            ? t["com.myoxus.database.view.timeline-start"]()
                            : t["com.myoxus.database.view.timeline-end"]();
                        const value = timelineCreateDisplay(createDraft, edge);
                        const change = (value: string | null) =>
                          setCreateDraft(
                            timelineCreateSetBoundary(createDraft, edge, value),
                          );
                        return field.fieldType === DatabaseFieldKind.Date ? (
                          <LocalizedDateInput
                            key={edge}
                            locale={t.language}
                            label={label}
                            aria-label={label}
                            value={value}
                            disabled={
                              saving || Boolean(createDraft.confirmedId)
                            }
                            popoverProps={{ withinPortal: false }}
                            onChange={change}
                          />
                        ) : (
                          <LocalizedDateTimeInput
                            key={edge}
                            withSeconds
                            valueFormat="L HH:mm:ss"
                            locale={t.language}
                            label={`${label} (${field.config.dateTime?.defaultTimeZone ?? "UTC"})`}
                            aria-label={label}
                            value={value}
                            disabled={
                              saving || Boolean(createDraft.confirmedId)
                            }
                            popoverProps={{ withinPortal: false }}
                            onChange={change}
                          />
                        );
                      })}
                    <Checkbox
                      checked={createDraft.end !== null}
                      disabled={saving || Boolean(createDraft.confirmedId)}
                      label={t["com.myoxus.database.schedule.range"]()}
                      onChange={(event) =>
                        setCreateDraft({
                          ...createDraft,
                          end: event.currentTarget.checked
                            ? createDraft.start
                            : null,
                          endInput: undefined,
                        })
                      }
                    />
                    {!createValid ? (
                      <Alert>
                        {t[
                          createDraft.end !== null &&
                          createDraft.end < createDraft.start
                            ? "com.myoxus.database.schedule.end-before-start"
                            : "com.myoxus.database.schedule.invalid-local-time"
                        ]()}
                      </Alert>
                    ) : null}
                    {!createWritable(createDraft) ? (
                      <Alert>
                        {t["com.myoxus.database.conflict.description"]()}
                      </Alert>
                    ) : null}
                    {createDraft.uncertain ? (
                      <Alert>
                        {t["com.myoxus.database.schedule.create-unknown"]()}
                      </Alert>
                    ) : null}
                    {error ? <Alert>{error}</Alert> : null}
                    <Group>
                      {createDraft.uncertain ? (
                        <Button
                          disabled={saving}
                          onClick={() =>
                            void onChanged().catch(() =>
                              setError(
                                t["com.myoxus.common.operation-failed"](),
                              ),
                            )
                          }
                        >
                          {t["Retry"]()}
                        </Button>
                      ) : (
                        <Button
                          disabled={
                            saving ||
                            !createValid ||
                            !createWritable(createDraft) ||
                            !createDraft.title.trim()
                          }
                          onClick={() => void applyCreate()}
                        >
                          {t[createDraft.confirmedId ? "Retry" : "Apply"]()}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        disabled={saving}
                        onClick={cancelCreate}
                      >
                        {t["Cancel"]()}
                      </Button>
                    </Group>
                  </Stack>
                ),
              }
            : undefined
        }
        empty={
          <EmptyState
            title={
              databaseEmpty
                ? t["com.myoxus.database.row.empty"]()
                : t["com.myoxus.database.schedule.window-empty"]()
            }
            description={
              databaseEmpty
                ? undefined
                : hasActiveQuery
                  ? t["com.myoxus.database.timeline.query-empty"]({
                      period: new Intl.DateTimeFormat(t.language, {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }).formatRange(
                        projection.axis.start,
                        projection.axis.end - 1,
                      ),
                    })
                  : new Intl.DateTimeFormat(t.language, {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    }).formatRange(
                      projection.axis.start,
                      projection.axis.end - 1,
                    )
            }
            cta={
              <Group>
                {databaseEmpty &&
                canEdit &&
                timelineCreateDraft(record, view, projection.axis.start) ? (
                  <Button
                    disabled={
                      !readyForIntent ||
                      Boolean(createDraft || rename || timeDraft) ||
                      saving
                    }
                    onClick={beginPlace}
                  >
                    {t["com.myoxus.database.row.add"]()}
                  </Button>
                ) : null}
                {search ? (
                  <Text>
                    {t["Quick search"]()}: {search}
                  </Text>
                ) : null}
                {activeFilterCount ? (
                  <Text>
                    {t["com.myoxus.database.view.filter-active"]({
                      count: String(activeFilterCount),
                    })}
                  </Text>
                ) : null}
                {hasActiveQuery && onClearQuery ? (
                  <Button onClick={onClearQuery}>
                    {t["com.myoxus.database.view.clear-search"]()}
                  </Button>
                ) : null}
                {onShowToday ? (
                  <Button onClick={onShowToday}>
                    {t["com.myoxus.today"]()}
                  </Button>
                ) : null}
                {onChooseDate ? (
                  <Button variant="secondary" onClick={onChooseDate}>
                    {t["Date"]()}
                  </Button>
                ) : null}
              </Group>
            }
          />
        }
        onSelect={(id: string) => {
          if (savingRef.current || rename || timeDraft || createDraft) return;
          setSelectedId(id);
          presence?.updateFocus({ rowId: id, viewId: view.id, fieldId: null });
        }}
        onOpen={open}
        onRename={beginRename}
      />
    </Stack>
  );
}
