// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseCalendarDateMode,
  DatabaseCalendarInitialRange,
  DatabaseCardDensity,
  DatabaseDurationDisplayUnit,
  DatabaseFieldKind,
  DatabaseFileMimeCategory,
  DatabaseFilesPreviewPolicy,
  DatabaseFilterConjunction,
  DatabaseFilterOperator,
  DatabaseFormulaResultType,
  DatabaseFormulaStalePolicy,
  DatabaseFormulaStaleState,
  DatabaseGalleryCardDensity,
  DatabaseListDensity,
  DatabaseProfileKind,
  DatabaseRollupAggregate,
  DatabaseRollupStalePolicy,
  DatabaseRollupStaleState,
  DatabaseRowContentDocumentState,
  DatabaseSortDirection,
  DatabaseStatusGroup,
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
  DatabaseViewKind,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import {
  createCalendarViewConfigInput,
  createCellValueInput,
  createGalleryViewConfigInput,
  createListViewConfigInput,
  createProgressViewConfigInput,
  createTimelineViewConfigInput,
  createViewConfigInputForKind,
  createViewConfigInputFromEdits,
  databaseDateSourceValue,
  databaseRowDropPosition,
  databaseViewKindIsAvailable,
  fieldConfigInputFromField,
  formatCellValue,
  getPrimaryViewOrNull,
  getViewByRole,
  getVisibleFieldIds,
  isDatabaseDateSourceField,
  selectOptionInputsFromText,
  sortDatabaseRowsByPosition,
  viewConfigInputFromView,
} from "./model";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseView,
} from "./types";

const TIMESTAMP = "2026-07-01T00:00:00Z";

function field(
  id: string,
  fieldType: DatabaseFieldKind,
  position: number,
  config: Omit<
    DatabaseField["config"],
    | "currency"
    | "duration"
    | "formula"
    | "files"
    | "richText"
    | "uniqueId"
    | "percent"
    | "relation"
    | "rollup"
    | "status"
    | "tags"
    | "users"
  > & {
    currency?: DatabaseField["config"]["currency"];
    duration?: DatabaseField["config"]["duration"];
    files?: DatabaseField["config"]["files"];
    richText?: DatabaseField["config"]["richText"];
    uniqueId?: DatabaseField["config"]["uniqueId"];
    formula?: DatabaseField["config"]["formula"];
    percent?: DatabaseField["config"]["percent"];
    relation?: DatabaseField["config"]["relation"];
    rollup?: DatabaseField["config"]["rollup"];
    status?: DatabaseField["config"]["status"];
    tags?: DatabaseField["config"]["tags"];
    users?: DatabaseField["config"]["users"];
  },
): DatabaseField {
  return {
    config: {
      currency: null,
      duration: null,
      files: null,
      richText: null,
      uniqueId: null,
      formula: null,
      percent: null,
      relation: null,
      rollup: null,
      status: null,
      tags: null,
      users: null,
      ...config,
    },
    createdAt: TIMESTAMP,
    databaseId: "database-1",
    editRevision: 1,
    fieldType,
    id,
    name: id,
    position,
    required: fieldType === DatabaseFieldKind.Title,
    updatedAt: TIMESTAMP,
  };
}

const titleField = field("title", DatabaseFieldKind.Title, 0, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Title,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
});

const statusField = field("status", DatabaseFieldKind.Select, 1, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Select,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: {
    options: [
      { colorRole: "blue", id: "todo", name: "To do", position: 0 },
      { colorRole: "green", id: "done", name: "Done", position: 1 },
    ],
  },
  text: null,
});

const workflowStatusField = field(
  "workflow-status",
  DatabaseFieldKind.Status,
  2,
  {
    date: null,
    dateTime: null,
    files: null,
    richText: null,
    uniqueId: null,
    kind: DatabaseFieldKind.Status,
    multiSelect: null,
    tags: null,
    number: null,
    percent: null,
    currency: null,
    duration: null,
    select: null,
    status: {
      defaultOptionId: "todo",
      options: [
        {
          colorRole: "database.status.todo",
          group: DatabaseStatusGroup.NotStarted,
          id: "todo",
          name: "Todo",
          position: 0,
        },
        {
          colorRole: "database.status.inProgress",
          group: DatabaseStatusGroup.Active,
          id: "doing",
          name: "Doing",
          position: 1,
        },
        {
          colorRole: "database.status.done",
          group: DatabaseStatusGroup.Complete,
          id: "done",
          name: "Done",
          position: 2,
        },
      ],
    },
    text: null,
  },
);

const scoreField = field("score", DatabaseFieldKind.Number, 2, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Number,
  multiSelect: null,
  tags: null,
  status: null,
  number: { format: null },
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
});

const progressField = field("progress", DatabaseFieldKind.Percent, 3, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Percent,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: { minValue: 0, maxValue: 100 },
  currency: null,
  duration: null,
  select: null,
  text: null,
});

const budgetField = field("budget", DatabaseFieldKind.Currency, 4, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Currency,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: {
    defaultCurrency: "EUR",
    allowCurrencyOverride: false,
    minValue: 0,
    maxValue: 1000,
  },
  duration: null,
  select: null,
  text: null,
});

const effortField = field("effort", DatabaseFieldKind.Duration, 5, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Duration,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: {
    displayUnit: DatabaseDurationDisplayUnit.Hours,
    minMinutes: 0,
    maxMinutes: 8 * 60,
  },
  select: null,
  text: null,
});

const assigneesField = field("assignees", DatabaseFieldKind.Users, 6, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Users,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
  users: { minCount: 1, maxCount: 3 },
});

const textField = field("notes", DatabaseFieldKind.Text, 3, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Text,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: { multiline: false },
});

const dueField = field("due", DatabaseFieldKind.Date, 4, {
  date: { includeTime: false },
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Date,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
});

const startsAtField = field("starts-at", DatabaseFieldKind.DateTime, 5, {
  date: null,
  dateTime: { defaultTimeZone: "Europe/Berlin", allowReminders: true },
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.DateTime,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
});

const filesField = field("attachments", DatabaseFieldKind.Files, 6, {
  date: null,
  dateTime: null,
  files: {
    allowedMimeCategories: [DatabaseFileMimeCategory.Image],
    maxItemCount: 3,
    maxItemSize: 1024,
    previewPolicy: DatabaseFilesPreviewPolicy.Auto,
  },
  uniqueId: null,
  kind: DatabaseFieldKind.Files,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
});

const uniqueIdField = field("public-id", DatabaseFieldKind.UniqueId, 7, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: { prefix: "TASK-", startNumber: 7, padding: 3 },
  kind: DatabaseFieldKind.UniqueId,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  select: null,
  text: null,
});

function payloadlessField(
  id: string,
  fieldType: DatabaseFieldKind,
  position: number,
): DatabaseField {
  return field(id, fieldType, position, {
    date: null,
    dateTime: null,
    files: null,
    richText: null,
    uniqueId: null,
    kind: fieldType,
    multiSelect: null,
    tags: null,
    status: null,
    number: null,
    percent: null,
    currency: null,
    duration: null,
    select: null,
    text: null,
  });
}

const urlField = payloadlessField("website", DatabaseFieldKind.Url, 8);
const emailField = payloadlessField("email", DatabaseFieldKind.Email, 9);
const phoneField = payloadlessField("phone", DatabaseFieldKind.Phone, 10);
const createdTimeField = payloadlessField(
  "created-time",
  DatabaseFieldKind.CreatedTime,
  11,
);
const createdByField = payloadlessField(
  "created-by",
  DatabaseFieldKind.CreatedBy,
  12,
);
const updatedTimeField = payloadlessField(
  "updated-time",
  DatabaseFieldKind.UpdatedTime,
  13,
);
const updatedByField = payloadlessField(
  "updated-by",
  DatabaseFieldKind.UpdatedBy,
  14,
);

const relationField = field("blocks", DatabaseFieldKind.Relation, 5, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Relation,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  relation: {
    allowMultiple: true,
    maxTargets: 5,
    reciprocalFieldId: null,
    targetDatabaseId: "database-1",
  },
  select: null,
  text: null,
});

const rollupField = field("blocked-score", DatabaseFieldKind.Rollup, 6, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  kind: DatabaseFieldKind.Rollup,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  relation: null,
  rollup: {
    aggregate: DatabaseRollupAggregate.Sum,
    emptyValue: {
      checkbox: null,
      currency: null,
      duration: null,
      date: null,
      kind: DatabaseFieldKind.Number,
      number: 0,
      text: null,
    },
    sourceRelationFieldId: relationField.id,
    stalePolicy: DatabaseRollupStalePolicy.Async,
    targetFieldId: scoreField.id,
  },
  select: null,
  text: null,
});

const formulaField = field("formula-due-label", DatabaseFieldKind.Formula, 7, {
  date: null,
  dateTime: null,
  files: null,
  richText: null,
  uniqueId: null,
  formula: {
    dependencyFieldIds: [textField.id, scoreField.id],
    expression: 'concat([notes], " ", [score])',
    format: null,
    resultType: DatabaseFormulaResultType.Text,
    stalePolicy: DatabaseFormulaStalePolicy.Async,
  },
  kind: DatabaseFieldKind.Formula,
  multiSelect: null,
  tags: null,
  status: null,
  number: null,
  percent: null,
  currency: null,
  duration: null,
  relation: null,
  rollup: null,
  select: null,
  text: null,
});

const tableView: DatabaseView = {
  config: {
    calendar: null,
    gallery: null,
    gantt: null,
    kanban: null,
    kind: DatabaseViewKind.Table,
    list: null,
    progress: null,
    table: {
      fieldWidths: [],
      searchFieldIds: [],
      filter: [],
      filterTree: null,
      group: null,
      sort: [],
      subgroup: null,
      titleFieldId: titleField.id,
      visibleFieldIds: [statusField.id],
    },
    timeline: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-table",
  name: "Table",
  position: 0,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Table,
};

const kanbanView: DatabaseView = {
  config: {
    calendar: null,
    gallery: null,
    gantt: null,
    kanban: {
      cardDensity: DatabaseCardDensity.Default,
      coverFieldId: null,
      filter: [],
      filterTree: null,
      groupFieldId: statusField.id,
      sort: [],
      titleFieldId: titleField.id,
      visibleFieldIds: [titleField.id, statusField.id],
    },
    kind: DatabaseViewKind.Kanban,
    list: null,
    progress: null,
    table: null,
    timeline: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-kanban",
  name: "Kanban",
  position: 1,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Kanban,
};

const record: DatabaseRecord = {
  managedSchema: null,
  database: {
    createdAt: TIMESTAMP,
    createdBy: "user-1",
    deletedAt: null,
    deletedBy: null,
    description: null,
    editRevision: 1,
    id: "database-1",
    profileConfig: {},
    systemRole: null,
    profileKind: DatabaseProfileKind.Generic,
    profileStructurePreset: null,
    title: "Roadmap",
    updatedAt: TIMESTAMP,
    updatedBy: "user-1",
    workspaceId: "workspace-1",
  },
  fields: [
    scoreField,
    statusField,
    titleField,
    textField,
    dueField,
    relationField,
    rollupField,
    uniqueIdField,
    formulaField,
  ],
  fieldRoles: [],
  viewRoles: [],
  rowCount: 2,
  views: [tableView, kanbanView],
};

function row(
  id: string,
  title: string,
  score: number,
  relationTargetTitles: Array<{ rowId: string; title: string }> = [],
): DatabaseRowRecord {
  return {
    cells: [
      {
        editRevision: 1,
        fieldId: scoreField.id,
        fieldType: DatabaseFieldKind.Number,
        rowId: id,
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.Number,
          multiSelect: null,
          tags: null,
          status: null,
          number: score,
          percent: null,
          currency: null,
          duration: null,
          select: null,
          text: null,
          relation: null,
          relationTargets: null,
          rollup: null,
          formula: null,
          user: null,
          users: null,
          documentLink: null,
          url: null,
          email: null,
          phone: null,
          createdTime: null,
          createdBy: null,
          updatedTime: null,
          updatedBy: null,
        },
      },
      {
        editRevision: 1,
        fieldId: relationField.id,
        fieldType: DatabaseFieldKind.Relation,
        rowId: id,
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.Relation,
          multiSelect: null,
          tags: null,
          status: null,
          number: null,
          percent: null,
          currency: null,
          duration: null,
          relation: relationTargetTitles.map((target) => target.rowId),
          relationTargets: relationTargetTitles.map((target) => ({
            deleted: false,
            contentDocument: {
              documentId: `doc-${target.rowId}`,
              externalId: `doc-${target.rowId}`,
              workspaceId: null,
              state: DatabaseRowContentDocumentState.Available,
              title: `${target.title} content`,
            },
            redacted: false,
            rowId: target.rowId,
            title: target.title,
          })),
          rollup: null,
          formula: null,
          select: null,
          text: null,
          user: null,
          users: null,
          documentLink: null,
          url: null,
          email: null,
          phone: null,
          createdTime: null,
          createdBy: null,
          updatedTime: null,
          updatedBy: null,
        },
      },
    ],
    cellRevisions: [],
    groupKeys: [],
    redacted: false,
    row: {
      createdAt: TIMESTAMP,
      createdBy: "user-1",
      databaseId: "database-1",
      editRevision: 1,
      deletedAt: null,
      contentDocument: {
        documentId: `doc-${id}`,
        externalId: `doc-${id}`,
        workspaceId: null,
        state: DatabaseRowContentDocumentState.Available,
        title: `${title} content`,
      },
      id,
      position: score,
      rowKind: "record",
      title,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
    },
  };
}

describe("database model helpers", () => {
  test("visible field IDs always retain the server title field", () => {
    expect(getVisibleFieldIds(record, tableView)).toEqual([
      titleField.id,
      statusField.id,
    ]);
  });

  test("primary view lookup has a nullable variant for route-state rendering", () => {
    expect(getPrimaryViewOrNull(record, kanbanView.id)?.id).toBe(kanbanView.id);
    expect(getPrimaryViewOrNull({ ...record, views: [] })).toBeNull();
  });

  test("resolves the Project default from its server-owned view role", () => {
    const projectRecord: DatabaseRecord = {
      ...record,
      database: {
        ...record.database,
        profileKind: DatabaseProfileKind.Project,
      },
      viewRoles: [
        {
          createdAt: TIMESTAMP,
          databaseId: record.database.id,
          profileKind: DatabaseProfileKind.Project,
          required: true,
          roleKey: "project.kanban",
          updatedAt: TIMESTAMP,
          viewId: kanbanView.id,
        },
      ],
      views: [tableView, kanbanView],
    };

    expect(getPrimaryViewOrNull(projectRecord)?.id).toBe(kanbanView.id);
    expect(getViewByRole(projectRecord, "project.kanban")?.id).toBe(
      kanbanView.id,
    );
    expect(getViewByRole(projectRecord, "project.progress")).toBeNull();
    expect(getPrimaryViewOrNull(projectRecord, tableView.id)?.id).toBe(
      tableView.id,
    );
  });

  test("view config edits persist visible fields, sort rules and kanban group field", () => {
    expect(
      createViewConfigInputFromEdits(record, kanbanView, {
        groupFieldId: statusField.id,
        sort: [
          { direction: DatabaseSortDirection.Desc, fieldId: scoreField.id },
        ],
        visibleFieldIds: [scoreField.id],
      }),
    ).toEqual({
      kanban: {
        cardDensity: DatabaseCardDensity.Default,
        coverFieldId: null,
        filter: [],
        filterTree: null,
        groupFieldId: statusField.id,
        sort: [
          { direction: DatabaseSortDirection.Desc, fieldId: scoreField.id },
        ],
        titleFieldId: titleField.id,
        visibleFieldIds: [titleField.id, scoreField.id],
      },
    });
  });

  test("view-kind conversion preserves shared query state and rejects missing schema dependencies", () => {
    const source: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          filter: [
            {
              fieldId: textField.id,
              operator: DatabaseFilterOperator.Contains,
              value: { kind: "text", value: "launch" },
            },
          ],
          sort: [
            {
              direction: DatabaseSortDirection.Desc,
              fieldId: scoreField.id,
            },
          ],
        },
      },
    };

    expect(databaseViewKindIsAvailable(record, DatabaseViewKind.Calendar)).toBe(
      true,
    );
    expect(databaseViewKindIsAvailable(record, DatabaseViewKind.Kanban)).toBe(
      true,
    );
    expect(databaseViewKindIsAvailable(record, DatabaseViewKind.Progress)).toBe(
      false,
    );

    expect(
      createViewConfigInputForKind(record, source, DatabaseViewKind.Calendar, {
        visibleFieldIds: [scoreField.id],
      }),
    ).toEqual({
      calendar: expect.objectContaining({
        dateFieldId: dueField.id,
        filter: [
          {
            fieldId: textField.id,
            operator: DatabaseFilterOperator.Contains,
            value: { text: "launch" },
          },
        ],
        sort: source.config.table!.sort,
        titleFieldId: titleField.id,
        visibleFieldIds: [titleField.id, scoreField.id],
      }),
    });
    expect(() =>
      createViewConfigInputForKind(record, source, DatabaseViewKind.Progress),
    ).toThrow("has no compatible Field");
  });

  test("Progress view helpers preserve the server-owned metric, filters and grouping", () => {
    const progressRecord: DatabaseRecord = {
      ...record,
      fields: [...record.fields, progressField],
    };
    const progressView: DatabaseView = {
      ...tableView,
      config: {
        calendar: null,
        gallery: null,
        gantt: null,
        kanban: null,
        kind: DatabaseViewKind.Progress,
        list: null,
        progress: {
          filter: [],
          filterTree: null,
          groupFieldId: statusField.id,
          progressFieldId: progressField.id,
          sort: [],
          titleFieldId: titleField.id,
          visibleFieldIds: [titleField.id, progressField.id],
        },
        table: null,
        timeline: null,
      },
      id: "view-progress",
      viewKind: DatabaseViewKind.Progress,
    };

    expect(
      createProgressViewConfigInput(
        progressRecord,
        progressField.id,
        statusField.id,
      ),
    ).toEqual({
      progress: {
        groupFieldId: statusField.id,
        progressFieldId: progressField.id,
        titleFieldId: titleField.id,
        visibleFieldIds: [
          titleField.id,
          statusField.id,
          scoreField.id,
          textField.id,
          progressField.id,
          dueField.id,
          relationField.id,
          rollupField.id,
          uniqueIdField.id,
          formulaField.id,
        ],
      },
    });

    const edited = createViewConfigInputFromEdits(
      progressRecord,
      progressView,
      {
        filter: [
          {
            fieldId: statusField.id,
            operator: DatabaseFilterOperator.Is,
            value: { optionId: "todo" },
          },
        ],
        sort: [
          {
            direction: DatabaseSortDirection.Desc,
            fieldId: progressField.id,
          },
        ],
      },
    );
    expect(edited).toEqual({
      progress: {
        filter: [
          {
            fieldId: statusField.id,
            operator: DatabaseFilterOperator.Is,
            value: { optionId: "todo" },
          },
        ],
        filterTree: null,
        groupFieldId: statusField.id,
        progressFieldId: progressField.id,
        sort: [
          {
            direction: DatabaseSortDirection.Desc,
            fieldId: progressField.id,
          },
        ],
        titleFieldId: titleField.id,
        visibleFieldIds: [titleField.id, progressField.id],
      },
    });
    expect(viewConfigInputFromView(progressView)).toEqual({
      progress: progressView.config.progress,
    });
  });

  test("P9G view config builders and edits preserve extended view contracts", () => {
    expect(createListViewConfigInput(record)).toEqual({
      list: {
        density: DatabaseListDensity.Default,
        showFieldLabels: true,
        titleFieldId: titleField.id,
        visibleFieldIds: [
          titleField.id,
          statusField.id,
          scoreField.id,
          textField.id,
          dueField.id,
          relationField.id,
          rollupField.id,
          uniqueIdField.id,
          formulaField.id,
        ],
      },
    });
    expect(createGalleryViewConfigInput(record)).toEqual({
      gallery: {
        cardDensity: DatabaseGalleryCardDensity.Default,
        coverFieldId: null,
        showEmptyCover: true,
        titleFieldId: titleField.id,
        visibleFieldIds: [
          titleField.id,
          statusField.id,
          scoreField.id,
          textField.id,
          dueField.id,
          relationField.id,
          rollupField.id,
          uniqueIdField.id,
          formulaField.id,
        ],
      },
    });
    expect(createCalendarViewConfigInput(record, dueField.id)).toEqual({
      calendar: {
        dateFieldId: dueField.id,
        dateMode: DatabaseCalendarDateMode.Month,
        initialRange: DatabaseCalendarInitialRange.CurrentMonth,
        titleFieldId: titleField.id,
        visibleFieldIds: [
          titleField.id,
          statusField.id,
          scoreField.id,
          textField.id,
          dueField.id,
          relationField.id,
          rollupField.id,
          uniqueIdField.id,
          formulaField.id,
        ],
      },
    });
    expect(createTimelineViewConfigInput(record, dueField.id)).toEqual({
      timeline: {
        endFieldId: null,
        groupBy: DatabaseTimelineGroupBy.Month,
        order: DatabaseTimelineOrder.Asc,
        startFieldId: dueField.id,
        titleFieldId: titleField.id,
        visibleFieldIds: [
          titleField.id,
          statusField.id,
          scoreField.id,
          textField.id,
          dueField.id,
          relationField.id,
          rollupField.id,
          uniqueIdField.id,
          formulaField.id,
        ],
        zoom: DatabaseTimelineZoom.Month,
      },
    });

    const calendarView: DatabaseView = {
      ...tableView,
      config: {
        calendar: {
          dateFieldId: dueField.id,
          dateMode: DatabaseCalendarDateMode.Week,
          filter: [],
          filterTree: {
            conjunction: DatabaseFilterConjunction.Or,
            groups: [],
            rules: [
              {
                fieldId: statusField.id,
                operator: DatabaseFilterOperator.Is,
                value: { kind: "option_id", value: "todo" },
              },
            ],
          },
          group: {
            descending: false,
            fieldId: statusField.id,
            showEmptyGroups: true,
          },
          initialRange: DatabaseCalendarInitialRange.CurrentWeek,
          sort: [],
          subgroup: {
            descending: true,
            fieldId: dueField.id,
            showEmptyGroups: false,
          },
          titleFieldId: titleField.id,
          visibleFieldIds: [titleField.id, dueField.id],
        },
        gallery: null,
        gantt: null,
        kanban: null,
        kind: DatabaseViewKind.Calendar,
        list: null,
        progress: null,
        table: null,
        timeline: null,
      },
      id: "view-calendar",
      viewKind: DatabaseViewKind.Calendar,
    };

    expect(
      createViewConfigInputFromEdits(record, calendarView, {
        sort: [{ direction: DatabaseSortDirection.Asc, fieldId: dueField.id }],
        visibleFieldIds: [dueField.id],
      }),
    ).toEqual({
      calendar: {
        dateFieldId: dueField.id,
        dateMode: DatabaseCalendarDateMode.Week,
        filter: [],
        filterTree: {
          conjunction: DatabaseFilterConjunction.Or,
          groups: [],
          rules: [
            {
              fieldId: statusField.id,
              operator: DatabaseFilterOperator.Is,
              value: { optionId: "todo" },
            },
          ],
        },
        group: {
          descending: false,
          fieldId: statusField.id,
          showEmptyGroups: true,
        },
        initialRange: DatabaseCalendarInitialRange.CurrentWeek,
        sort: [{ direction: DatabaseSortDirection.Asc, fieldId: dueField.id }],
        subgroup: {
          descending: true,
          fieldId: dueField.id,
          showEmptyGroups: false,
        },
        titleFieldId: titleField.id,
        visibleFieldIds: [titleField.id, dueField.id],
      },
    });
  });

  test("row-position helpers keep visual database views ordered without a score field", () => {
    const high = row("high", "High", 9);
    const low = row("low", "Low", 1);
    const middle = row("middle", "Middle", 4);
    const unsortedRows = [high, low, middle];

    expect(
      sortDatabaseRowsByPosition(unsortedRows).map(({ row }) => row.id),
    ).toEqual(["low", "middle", "high"]);
    expect(databaseRowDropPosition(unsortedRows, "high", "middle", "top")).toBe(
      1,
    );
    expect(databaseRowDropPosition(unsortedRows, "low", "high", "bottom")).toBe(
      2,
    );
    expect(databaseRowDropPosition(unsortedRows, "middle", null)).toBe(2);
  });

  test("field config input keeps typed edits in the existing server config envelope", () => {
    expect(fieldConfigInputFromField(textField, { multiline: true })).toEqual({
      text: { multiline: true },
    });
  });

  test("status cells keep semantic status envelope and configured option order", () => {
    const databaseRow = row("workflow-row", "Workflow row", 4);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: workflowStatusField.id,
      fieldType: DatabaseFieldKind.Status,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Status,
        multiSelect: null,
        tags: null,
        status: "doing",
        number: null,
        percent: null,
        currency: null,
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(createCellValueInput(workflowStatusField, "done")).toEqual({
      status: "done",
    });
    expect(fieldConfigInputFromField(workflowStatusField)).toEqual({
      status: {
        defaultOptionId: "todo",
        options: workflowStatusField.config.status?.options,
      },
    });
    expect(formatCellValue(databaseRow, workflowStatusField, "en-US")).toBe(
      "Doing",
    );
  });

  test("date-time cells keep personal reminders outside shared Cell values", () => {
    const databaseRow = row("date-time-row", "DateTime row", 4);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: startsAtField.id,
      fieldType: DatabaseFieldKind.DateTime,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: {
          allDay: false,
          end: "2026-07-06T10:00:00Z",
          start: "2026-07-06T09:00:00Z",
          timeZone: "Europe/Berlin",
        },
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.DateTime,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    const typedDateTime = databaseRow.cells.at(-1)!.value.dateTime!;
    typedDateTime.allDay = true;
    typedDateTime.start = "2026-07-05T22:00:00Z";
    expect(formatCellValue(databaseRow, startsAtField, "en-US")).toBe(
      "Jul 6, 2026",
    );
    expect(
      formatCellValue(databaseRow, startsAtField, "en-US", undefined, {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        dateFormat: "locale",
        timeFormat: "locale",
      }),
    ).toBe("Jul 6, 2026");
    typedDateTime.allDay = false;
    typedDateTime.start = "2026-07-06T09:00:00Z";
    expect(isDatabaseDateSourceField(startsAtField.fieldType)).toBe(true);
    expect(createCellValueInput(startsAtField, "2026-07-06T09:00:00Z")).toEqual(
      {
        dateTime: {
          allDay: false,
          end: null,
          start: "2026-07-06T09:00:00Z",
          timeZone: "Europe/Berlin",
        },
      },
    );
    expect(createCellValueInput(startsAtField, "")).toEqual({
      dateTime: {
        allDay: false,
        end: null,
        start: "",
        timeZone: "Europe/Berlin",
      },
    });
    expect(
      createCellValueInput(startsAtField, {
        allDay: true,
        end: "2026-07-08T22:00:00Z",
        start: "2026-07-05T22:00:00Z",
        timeZone: "Europe/Berlin",
      }),
    ).toEqual({
      dateTime: {
        allDay: true,
        end: "2026-07-08T22:00:00Z",
        start: "2026-07-05T22:00:00Z",
        timeZone: "Europe/Berlin",
      },
    });
    expect(fieldConfigInputFromField(startsAtField)).toEqual({
      dateTime: {
        allowReminders: true,
        defaultTimeZone: "Europe/Berlin",
      },
    });
    expect(formatCellValue(databaseRow, startsAtField, "en-US")).toContain(
      "Jul 6, 2026",
    );
  });

  test("files cells use server blob references without local binary payloads", () => {
    const databaseRow = row("files-row", "Files row", 4);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: filesField.id,
      fieldType: DatabaseFieldKind.Files,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: {
          files: [
            {
              blobKey: "workspace/image-1",
              caption: "Cover",
              cover: true,
              mime: "image/png",
              name: "cover.png",
              size: 512,
            },
            {
              blobKey: "workspace/raw-1",
              caption: null,
              cover: false,
              mime: null,
              name: null,
              size: null,
            },
          ],
        },
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Files,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(
      createCellValueInput(filesField, "workspace/image-1\nworkspace/raw-1"),
    ).toEqual({
      files: {
        files: [
          {
            blobKey: "workspace/image-1",
            caption: null,
            cover: false,
            mime: null,
            name: null,
            size: null,
          },
          {
            blobKey: "workspace/raw-1",
            caption: null,
            cover: false,
            mime: null,
            name: null,
            size: null,
          },
        ],
      },
    });
    expect(fieldConfigInputFromField(filesField)).toEqual({
      files: {
        allowedMimeCategories: [DatabaseFileMimeCategory.Image],
        maxItemCount: 3,
        maxItemSize: 1024,
        previewPolicy: DatabaseFilesPreviewPolicy.Auto,
      },
    });
    expect(formatCellValue(databaseRow, filesField, "en-US")).toBe(
      "cover.png, workspace/raw-1",
    );
  });

  test("unique id cells display server-generated values and stay read-only", () => {
    const databaseRow = row("unique-id-row", "Unique row", 4);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: uniqueIdField.id,
      fieldType: DatabaseFieldKind.UniqueId,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: { display: "TASK-007", prefix: "TASK-", sequence: 7 },
        kind: DatabaseFieldKind.UniqueId,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(formatCellValue(databaseRow, uniqueIdField, "en-US")).toBe(
      "TASK-007",
    );
    expect(() => createCellValueInput(uniqueIdField, "TASK-999")).toThrow(
      "UniqueId fields are server-generated and read-only",
    );
    expect(fieldConfigInputFromField(uniqueIdField)).toEqual({
      uniqueId: { prefix: "TASK-", startNumber: 7, padding: 3 },
    });
  });

  test("percent cells use a first-class percent envelope and localized display", () => {
    const databaseRow = row("progress-row", "Progress row", 4);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: progressField.id,
      fieldType: DatabaseFieldKind.Percent,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Percent,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: 42.5,
        currency: null,
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(createCellValueInput(progressField, "42.5")).toEqual({
      percent: 42.5,
    });
    expect(fieldConfigInputFromField(progressField)).toEqual({
      percent: { minValue: 0, maxValue: 100 },
    });
    expect(formatCellValue(databaseRow, progressField, "en-US")).toBe("42.5%");
  });

  test("currency cells keep amount and ISO code and render via locale currency formatting", () => {
    const databaseRow = row("budget-row", "Budget row", 5);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: budgetField.id,
      fieldType: DatabaseFieldKind.Currency,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Currency,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: { amount: 42.5, currencyCode: "EUR" },
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(createCellValueInput(budgetField, "42.5")).toEqual({
      currency: { amount: 42.5, currencyCode: "EUR" },
    });
    expect(
      createCellValueInput(budgetField, {
        amount: 99,
        currencyCode: "EUR",
      }),
    ).toEqual({
      currency: { amount: 99, currencyCode: "EUR" },
    });
    expect(fieldConfigInputFromField(budgetField)).toEqual({
      currency: {
        defaultCurrency: "EUR",
        allowCurrencyOverride: false,
        minValue: 0,
        maxValue: 1000,
      },
    });
    expect(formatCellValue(databaseRow, budgetField, "en-US")).toBe("€42.50");
  });

  test("duration cells keep canonical minutes and render with the configured display unit", () => {
    const databaseRow = row("effort-row", "Effort row", 6);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: effortField.id,
      fieldType: DatabaseFieldKind.Duration,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Duration,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: { minutes: 90 },
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(createCellValueInput(effortField, "90")).toEqual({
      duration: { minutes: 90 },
    });
    expect(fieldConfigInputFromField(effortField)).toEqual({
      duration: {
        displayUnit: DatabaseDurationDisplayUnit.Hours,
        minMinutes: 0,
        maxMinutes: 480,
      },
    });
    expect(formatCellValue(databaseRow, effortField, "en-US")).toBe("1.5 h");
  });

  test("users cells keep ordered user ids and expose min/max config", () => {
    const databaseRow = row("assignees-row", "Assignees row", 7);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: assigneesField.id,
      fieldType: DatabaseFieldKind.Users,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Users,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: null,
        select: null,
        text: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        formula: null,
        user: null,
        users: ["user-1", "user-2"],
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(createCellValueInput(assigneesField, ["user-1", "user-2"])).toEqual({
      users: ["user-1", "user-2"],
    });
    expect(fieldConfigInputFromField(assigneesField)).toEqual({
      users: { minCount: 1, maxCount: 3 },
    });
    expect(formatCellValue(databaseRow, assigneesField, "en-US")).toBe(
      "user-1, user-2",
    );
  });

  test("relation field config input keeps the server-owned relation envelope", () => {
    expect(fieldConfigInputFromField(relationField)).toEqual({
      relation: {
        allowMultiple: true,
        maxTargets: 5,
        reciprocalFieldId: null,
        targetDatabaseId: "database-1",
      },
    });
  });

  test("relation cell values roundtrip as row IDs and render readable target labels", () => {
    const databaseRow = row("blocked", "Blocked", 4, [
      { rowId: "dependency", title: "Dependency" },
    ]);

    expect(createCellValueInput(relationField, ["dependency"])).toEqual({
      relation: ["dependency"],
    });
    expect(formatCellValue(databaseRow, relationField, "en")).toBe(
      "Dependency",
    );
  });

  test("P9I editable property fields roundtrip through cell-value inputs and formatting", () => {
    const databaseRow = row("property", "Property", 4);
    databaseRow.cells.push(
      {
        editRevision: 1,
        fieldId: urlField.id,
        fieldType: DatabaseFieldKind.Url,
        rowId: databaseRow.row.id,
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.Url,
          multiSelect: null,
          tags: null,
          status: null,
          number: null,
          percent: null,
          currency: null,
          duration: null,
          relation: null,
          relationTargets: null,
          rollup: null,
          formula: null,
          select: null,
          text: null,
          user: null,
          users: null,
          documentLink: null,
          url: "https://example.test/",
          email: null,
          phone: null,
          createdTime: null,
          createdBy: null,
          updatedTime: null,
          updatedBy: null,
        },
      },
      {
        editRevision: 1,
        fieldId: emailField.id,
        fieldType: DatabaseFieldKind.Email,
        rowId: databaseRow.row.id,
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.Email,
          multiSelect: null,
          tags: null,
          status: null,
          number: null,
          percent: null,
          currency: null,
          duration: null,
          relation: null,
          relationTargets: null,
          rollup: null,
          formula: null,
          select: null,
          text: null,
          user: null,
          users: null,
          documentLink: null,
          url: null,
          email: "Owner@example.test",
          phone: null,
          createdTime: null,
          createdBy: null,
          updatedTime: null,
          updatedBy: null,
        },
      },
      {
        editRevision: 1,
        fieldId: phoneField.id,
        fieldType: DatabaseFieldKind.Phone,
        rowId: databaseRow.row.id,
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.Phone,
          multiSelect: null,
          tags: null,
          status: null,
          number: null,
          percent: null,
          currency: null,
          duration: null,
          relation: null,
          relationTargets: null,
          rollup: null,
          formula: null,
          select: null,
          text: null,
          user: null,
          users: null,
          documentLink: null,
          url: null,
          email: null,
          phone: "+49 30 12345678",
          createdTime: null,
          createdBy: null,
          updatedTime: null,
          updatedBy: null,
        },
      },
    );

    expect(createCellValueInput(urlField, "example.test")).toEqual({
      url: "example.test",
    });
    expect(createCellValueInput(emailField, "Owner@example.test")).toEqual({
      email: "Owner@example.test",
    });
    expect(createCellValueInput(phoneField, "+49 30 12345678")).toEqual({
      phone: "+49 30 12345678",
    });
    expect(formatCellValue(databaseRow, urlField, "en")).toBe(
      "https://example.test/",
    );
    expect(formatCellValue(databaseRow, emailField, "en")).toBe(
      "Owner@example.test",
    );
    expect(formatCellValue(databaseRow, phoneField, "en")).toBe(
      "+49 30 12345678",
    );
  });

  test("P9I projection fields format metadata, stay read-only and work as date sources", () => {
    const databaseRow = row("projection", "Projection", 4);
    databaseRow.cells.push(
      {
        editRevision: 1,
        fieldId: createdTimeField.id,
        fieldType: DatabaseFieldKind.CreatedTime,
        rowId: databaseRow.row.id,
        updatedAt: TIMESTAMP,
        updatedBy: null,
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.CreatedTime,
          multiSelect: null,
          tags: null,
          status: null,
          number: null,
          percent: null,
          currency: null,
          duration: null,
          relation: null,
          relationTargets: null,
          rollup: null,
          formula: null,
          select: null,
          text: null,
          user: null,
          users: null,
          documentLink: null,
          url: null,
          email: null,
          phone: null,
          createdTime: "2026-07-01T12:30:00Z",
          createdBy: null,
          updatedTime: null,
          updatedBy: null,
        },
      },
      {
        editRevision: 1,
        fieldId: createdByField.id,
        fieldType: DatabaseFieldKind.CreatedBy,
        rowId: databaseRow.row.id,
        updatedAt: TIMESTAMP,
        updatedBy: null,
        value: {
          checkbox: null,
          date: null,
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          kind: DatabaseFieldKind.CreatedBy,
          multiSelect: null,
          tags: null,
          status: null,
          number: null,
          percent: null,
          currency: null,
          duration: null,
          relation: null,
          relationTargets: null,
          rollup: null,
          formula: null,
          select: null,
          text: null,
          user: null,
          users: null,
          documentLink: null,
          url: null,
          email: null,
          phone: null,
          createdTime: null,
          createdBy: "user-1",
          updatedTime: null,
          updatedBy: null,
        },
      },
    );

    expect(isDatabaseDateSourceField(createdTimeField.fieldType)).toBe(true);
    expect(isDatabaseDateSourceField(updatedTimeField.fieldType)).toBe(true);
    expect(databaseDateSourceValue("2026-07-01T12:30:00Z")).toBe("2026-07-01");
    expect(formatCellValue(databaseRow, createdTimeField, "en-US")).toContain(
      "Jul 1, 2026",
    );
    expect(formatCellValue(databaseRow, createdByField, "en-US")).toBe(
      "user-1",
    );
    for (const projectionField of [
      createdTimeField,
      createdByField,
      updatedTimeField,
      updatedByField,
    ]) {
      expect(() => createCellValueInput(projectionField, "value")).toThrow(
        "Projection fields are read-only computed values.",
      );
      expect(fieldConfigInputFromField(projectionField)).toBeNull();
    }
  });

  test("computed rollup and formula cells render server values and stay read-only", () => {
    const databaseRow = row("computed", "Computed", 4);
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: rollupField.id,
      fieldType: DatabaseFieldKind.Rollup,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        kind: DatabaseFieldKind.Rollup,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: null,
        relation: null,
        relationTargets: null,
        rollup: {
          computedAt: TIMESTAMP,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          staleState: DatabaseRollupStaleState.Current,
          value: {
            checkbox: null,
            currency: null,
            duration: null,
            date: null,
            kind: DatabaseFieldKind.Number,
            number: 12,
            text: null,
          },
        },
        formula: null,
        select: null,
        text: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });
    databaseRow.cells.push({
      editRevision: 1,
      fieldId: formulaField.id,
      fieldType: DatabaseFieldKind.Formula,
      rowId: databaseRow.row.id,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      value: {
        checkbox: null,
        date: null,
        dateTime: null,
        files: null,
        richText: null,
        uniqueId: null,
        formula: {
          computedAt: TIMESTAMP,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          staleState: DatabaseFormulaStaleState.Current,
          value: {
            checkbox: null,
            date: { end: null, start: "2026-07-02" },
            kind: DatabaseFieldKind.Date,
            number: null,
            text: null,
          },
        },
        kind: DatabaseFieldKind.Formula,
        multiSelect: null,
        tags: null,
        status: null,
        number: null,
        percent: null,
        currency: null,
        duration: null,
        relation: null,
        relationTargets: null,
        rollup: null,
        select: null,
        text: null,
        user: null,
        users: null,
        documentLink: null,
        url: null,
        email: null,
        phone: null,
        createdTime: null,
        createdBy: null,
        updatedTime: null,
        updatedBy: null,
      },
    });

    expect(formatCellValue(databaseRow, rollupField, "en")).toBe("12");
    expect(() => createCellValueInput(rollupField, 12)).toThrow(
      "Rollup fields are read-only computed values.",
    );
    expect(fieldConfigInputFromField(rollupField)).toEqual({
      rollup: {
        aggregate: DatabaseRollupAggregate.Sum,
        emptyValue: {
          checkbox: null,
          currency: null,
          duration: null,
          date: null,
          number: 0,
          text: null,
        },
        sourceRelationFieldId: relationField.id,
        stalePolicy: DatabaseRollupStalePolicy.Async,
        targetFieldId: scoreField.id,
      },
    });

    expect(formatCellValue(databaseRow, formulaField, "en-US")).toBe(
      "Jul 2, 2026",
    );
    expect(() => createCellValueInput(formulaField, "value")).toThrow(
      "Formula fields are read-only computed values.",
    );
    expect(fieldConfigInputFromField(formulaField)).toEqual({
      formula: {
        dependencyFieldIds: [textField.id, scoreField.id],
        expression: 'concat([notes], " ", [score])',
        format: null,
        resultType: DatabaseFormulaResultType.Text,
        stalePolicy: DatabaseFormulaStalePolicy.Async,
      },
    });
  });

  test("select option text edits preserve existing option IDs by position", () => {
    expect(
      selectOptionInputsFromText(
        [
          { colorRole: "blue", id: "todo", name: "To do", position: 0 },
          { colorRole: "green", id: "done", name: "Done", position: 1 },
        ],
        "Open\nClosed",
      ),
    ).toEqual([
      { colorRole: "blue", id: "todo", name: "Open", position: 0 },
      { colorRole: "green", id: "done", name: "Closed", position: 1 },
    ]);
  });
});
