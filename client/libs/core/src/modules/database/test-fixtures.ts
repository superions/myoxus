// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseCalendarDateMode,
  DatabaseCalendarInitialRange,
  DatabaseCardDensity,
  DatabaseFieldKind,
  DatabaseFormulaResultType,
  DatabaseFormulaStalePolicy,
  DatabaseGalleryCardDensity,
  DatabaseListDensity,
  DatabaseProfileKind,
  DatabaseManagedSchemaReadiness,
  ProjectOptionPreset,
  ProjectStructurePreset,
  DatabaseRollupAggregate,
  DatabaseRollupStalePolicy,
  DatabaseRowContentDocumentState,
  DatabaseSortDirection,
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
  DatabaseViewKind,
} from "@myoxus/graphql";

import {
  type DatabaseField,
  type DatabaseRecord,
  type DatabaseRowRecord,
  type DatabaseRowTemplateBinding,
  type DatabaseView,
} from "./types";

export const TIMESTAMP = "2026-07-01T00:00:00Z";

export function field(
  id: string,
  fieldType: DatabaseFieldKind,
  name: string,
  position: number,
): DatabaseField {
  return {
    config: {
      currency: null,
      duration: null,
      date:
        fieldType === DatabaseFieldKind.Date ? { includeTime: false } : null,
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
      relation: null,
      rollup: null,
      formula: null,
      select: null,
      text: fieldType === DatabaseFieldKind.Text ? { multiline: false } : null,
      users:
        fieldType === DatabaseFieldKind.Users
          ? { minCount: null, maxCount: null }
          : null,
    },
    createdAt: TIMESTAMP,
    databaseId: "database-1",
    editRevision: 1,
    fieldType,
    id,
    name,
    position,
    required: fieldType === DatabaseFieldKind.Title,
    updatedAt: TIMESTAMP,
  };
}

export const titleField = field(
  "field-title",
  DatabaseFieldKind.Title,
  "Name",
  0,
);

export const notesField = field(
  "field-notes",
  DatabaseFieldKind.Text,
  "Notes",
  1,
);

export const dueField = field("field-due", DatabaseFieldKind.Date, "Due", 2);

export const plannedField = field(
  "field-planned",
  DatabaseFieldKind.Date,
  "Planned",
  3,
);

export const filesField = field(
  "field-files",
  DatabaseFieldKind.Files,
  "Files",
  8,
);

export const statusField: DatabaseField = {
  ...field("field-status", DatabaseFieldKind.Select, "Status", 3),
  config: {
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
    relation: null,
    rollup: null,
    formula: null,
    users: null,
    select: {
      options: [
        { colorRole: "blue", id: "todo", name: "Todo", position: 0 },
        { colorRole: "orange", id: "doing", name: "Doing", position: 1 },
        { colorRole: "green", id: "done", name: "Done", position: 2 },
      ],
    },
    text: null,
  },
};

export const scoreField: DatabaseField = {
  ...field("field-score", DatabaseFieldKind.Number, "Score", 4),
  config: {
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
    relation: null,
    rollup: null,
    formula: null,
    users: null,
    select: null,
    text: null,
  },
};

export const progressField: DatabaseField = {
  ...field("field-progress", DatabaseFieldKind.Percent, "Progress", 5),
  config: {
    ...field("field-progress", DatabaseFieldKind.Percent, "Progress", 5).config,
    percent: { minValue: 0, maxValue: 100 },
  },
};

export const confidenceField: DatabaseField = {
  ...field("field-confidence", DatabaseFieldKind.Percent, "Confidence", 9),
  config: {
    ...field("field-confidence", DatabaseFieldKind.Percent, "Confidence", 9)
      .config,
    percent: { minValue: 0, maxValue: 100 },
  },
};

export const ownerField = field(
  "field-owner",
  DatabaseFieldKind.Text,
  "Owner",
  5,
);

export const phaseField = field(
  "field-phase",
  DatabaseFieldKind.Text,
  "Phase",
  6,
);

export const impactField = field(
  "field-impact",
  DatabaseFieldKind.Text,
  "Impact",
  7,
);

export const relationField: DatabaseField = {
  config: {
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
      maxTargets: 8,
      reciprocalFieldId: null,
      targetDatabaseId: "database-1",
    },
    rollup: null,
    formula: null,
    users: null,
    select: null,
    text: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  fieldType: DatabaseFieldKind.Relation,
  id: "field-related",
  name: "Related",
  position: 2,
  required: false,
  updatedAt: TIMESTAMP,
};

export const rollupField: DatabaseField = {
  config: {
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
      aggregate: DatabaseRollupAggregate.Count,
      emptyValue: null,
      sourceRelationFieldId: relationField.id,
      stalePolicy: DatabaseRollupStalePolicy.Async,
      targetFieldId: notesField.id,
    },
    formula: null,
    users: null,
    select: null,
    text: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  fieldType: DatabaseFieldKind.Rollup,
  id: "field-rollup",
  name: "Related count",
  position: 3,
  required: false,
  updatedAt: TIMESTAMP,
};

export const formulaField: DatabaseField = {
  config: {
    date: null,
    dateTime: null,
    files: null,
    richText: null,
    uniqueId: null,
    formula: {
      dependencyFieldIds: [notesField.id],
      expression: 'concat([Notes], " ready")',
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
    users: null,
    relation: null,
    rollup: null,
    select: null,
    text: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  fieldType: DatabaseFieldKind.Formula,
  id: "field-formula",
  name: "Formula label",
  position: 4,
  required: false,
  updatedAt: TIMESTAMP,
};

export const tableView: DatabaseView = {
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
      visibleFieldIds: [titleField.id, notesField.id],
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

export const listView: DatabaseView = {
  config: {
    calendar: null,
    gallery: null,
    gantt: null,
    kanban: null,
    kind: DatabaseViewKind.List,
    list: {
      density: DatabaseListDensity.Default,
      filter: [],
      filterTree: null,
      group: null,
      showFieldLabels: true,
      sort: [],
      subgroup: null,
      titleFieldId: titleField.id,
      visibleFieldIds: [titleField.id, notesField.id, dueField.id],
    },
    progress: null,
    table: null,
    timeline: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-list",
  name: "List",
  position: 1,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.List,
};

export const galleryView: DatabaseView = {
  config: {
    calendar: null,
    gallery: {
      cardDensity: DatabaseGalleryCardDensity.Default,
      coverFieldId: null,
      filter: [],
      filterTree: null,
      group: null,
      showEmptyCover: true,
      sort: [],
      subgroup: null,
      titleFieldId: titleField.id,
      visibleFieldIds: [titleField.id, notesField.id, dueField.id],
    },
    gantt: null,
    kanban: null,
    kind: DatabaseViewKind.Gallery,
    list: null,
    progress: null,
    table: null,
    timeline: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-gallery",
  name: "Gallery",
  position: 2,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Gallery,
};

export const calendarView: DatabaseView = {
  config: {
    calendar: {
      dateFieldId: dueField.id,
      dateMode: DatabaseCalendarDateMode.Month,
      filter: [],
      filterTree: null,
      group: null,
      initialRange: DatabaseCalendarInitialRange.CurrentMonth,
      sort: [],
      subgroup: null,
      titleFieldId: titleField.id,
      visibleFieldIds: [titleField.id, notesField.id, dueField.id],
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
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-calendar",
  name: "Calendar",
  position: 3,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Calendar,
};

export const timelineView: DatabaseView = {
  config: {
    calendar: null,
    gallery: null,
    gantt: null,
    kanban: null,
    kind: DatabaseViewKind.Timeline,
    list: null,
    progress: null,
    table: null,
    timeline: {
      endFieldId: null,
      filter: [],
      filterTree: null,
      groupBy: DatabaseTimelineGroupBy.Month,
      order: DatabaseTimelineOrder.Asc,
      startFieldId: dueField.id,
      sort: [],
      titleFieldId: titleField.id,
      visibleFieldIds: [titleField.id, notesField.id, dueField.id],
      zoom: DatabaseTimelineZoom.Month,
    },
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-timeline",
  name: "Timeline",
  position: 4,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Timeline,
};

export const ganttView: DatabaseView = {
  config: {
    calendar: null,
    gallery: null,
    gantt: {
      dependencyFieldId: relationField.id,
      endFieldId: plannedField.id,
      filter: [],
      filterTree: null,
      group: {
        descending: false,
        fieldId: statusField.id,
        showEmptyGroups: true,
      },
      sort: [],
      startFieldId: dueField.id,
      titleFieldId: titleField.id,
      visibleFieldIds: [
        titleField.id,
        dueField.id,
        plannedField.id,
        statusField.id,
        relationField.id,
      ],
      zoom: DatabaseTimelineZoom.Month,
    },
    kanban: null,
    kind: DatabaseViewKind.Gantt,
    list: null,
    progress: null,
    table: null,
    timeline: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-gantt",
  name: "Gantt",
  position: 5,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Gantt,
};

export const kanbanView: DatabaseView = {
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
      visibleFieldIds: [
        titleField.id,
        statusField.id,
        dueField.id,
        scoreField.id,
        notesField.id,
      ],
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
  position: 5,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Kanban,
};

export const progressView: DatabaseView = {
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
      visibleFieldIds: [titleField.id, progressField.id, statusField.id],
    },
    table: null,
    timeline: null,
  },
  createdAt: TIMESTAMP,
  databaseId: "database-1",
  editRevision: 1,
  icon: null,
  id: "view-progress",
  name: "Progress",
  position: 6,
  updatedAt: TIMESTAMP,
  viewKind: DatabaseViewKind.Progress,
};

export const record: DatabaseRecord = {
  managedSchema: null,
  database: {
    createdAt: TIMESTAMP,
    createdBy: "user-1",
    deletedAt: null,
    deletedBy: null,
    description: "Server-owned database",
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
  fields: [titleField, notesField],
  fieldRoles: [],
  viewRoles: [],
  rowCount: 1,
  views: [tableView],
};

export const p9gRecord: DatabaseRecord = {
  ...record,
  fields: [titleField, notesField, dueField],
  views: [tableView, listView, galleryView, calendarView, timelineView],
};

export const ganttRecord: DatabaseRecord = {
  ...record,
  fields: [
    titleField,
    notesField,
    dueField,
    plannedField,
    statusField,
    relationField,
  ],
  views: [ganttView],
};

export const kanbanRecord: DatabaseRecord = {
  ...record,
  fields: [titleField, notesField, dueField, statusField, scoreField],
  rowCount: 9,
  views: [kanbanView],
};

export const progressRecord: DatabaseRecord = {
  ...record,
  fields: [titleField, notesField, statusField, progressField],
  views: [progressView],
};

export const kanbanRichView: DatabaseView = {
  ...kanbanView,
  config: {
    ...kanbanView.config,
    kanban: {
      ...kanbanView.config.kanban!,
      sort: [{ direction: DatabaseSortDirection.Asc, fieldId: dueField.id }],
      visibleFieldIds: [
        titleField.id,
        statusField.id,
        dueField.id,
        notesField.id,
        ownerField.id,
        phaseField.id,
        impactField.id,
      ],
    },
  },
  id: "view-kanban-rich",
};

export const kanbanRichRecord: DatabaseRecord = {
  ...kanbanRecord,
  fields: [
    titleField,
    notesField,
    dueField,
    statusField,
    scoreField,
    ownerField,
    phaseField,
    impactField,
  ],
  rowCount: 24,
  views: [kanbanRichView],
};

export const rows: DatabaseRowRecord[] = [
  {
    cells: [
      {
        editRevision: 1,
        fieldId: notesField.id,
        fieldType: DatabaseFieldKind.Text,
        rowId: "row-1",
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
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
          text: "Initial note",
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
    ],
    cellRevisions: [
      {
        editRevision: 1,
        fieldId: notesField.id,
        hasValue: true,
        rowId: "row-1",
      },
    ],
    groupKeys: [],
    redacted: false,
    row: {
      createdAt: TIMESTAMP,
      createdBy: "user-1",
      databaseId: "database-1",
      editRevision: 1,
      deletedAt: null,
      contentDocument: {
        documentId: "doc-1",
        externalId: "doc-1",
        workspaceId: null,
        state: DatabaseRowContentDocumentState.Available,
        title: "Initial task content",
      },
      id: "row-1",
      position: 0,
      rowKind: "record",
      title: "Initial task",
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
    },
  },
];

export const progressRows: DatabaseRowRecord[] = [
  {
    ...rows[0]!,
    cells: [
      ...rows[0]!.cells,
      {
        ...rows[0]!.cells[0]!,
        fieldId: progressField.id,
        fieldType: DatabaseFieldKind.Percent,
        value: {
          ...rows[0]!.cells[0]!.value,
          kind: DatabaseFieldKind.Percent,
          percent: 65,
          text: null,
        },
      },
      {
        ...rows[0]!.cells[0]!,
        fieldId: statusField.id,
        fieldType: DatabaseFieldKind.Select,
        value: {
          ...rows[0]!.cells[0]!.value,
          kind: DatabaseFieldKind.Select,
          select: "doing",
          text: null,
        },
      },
    ],
  },
];

export const p9gRows: DatabaseRowRecord[] = [
  {
    ...rows[0]!,
    cells: [
      ...rows[0]!.cells,
      {
        editRevision: 1,
        fieldId: dueField.id,
        fieldType: DatabaseFieldKind.Date,
        rowId: "row-1",
        updatedAt: TIMESTAMP,
        updatedBy: "user-1",
        value: {
          checkbox: null,
          date: { end: null, start: "2026-07-15" },
          dateTime: null,
          files: null,
          richText: null,
          uniqueId: null,
          formula: null,
          kind: DatabaseFieldKind.Date,
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
      },
    ],
  },
  {
    cells: [],
    cellRevisions: [],
    groupKeys: [],
    redacted: true,
    row: {
      createdAt: TIMESTAMP,
      createdBy: "user-1",
      databaseId: "database-1",
      editRevision: 1,
      deletedAt: TIMESTAMP,
      contentDocument: {
        documentId: "doc-redacted",
        externalId: null,
        workspaceId: null,
        state: DatabaseRowContentDocumentState.Redacted,
        title: null,
      },
      id: "row-redacted",
      position: 1,
      rowKind: "record",
      title: "Restricted task",
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
    },
  },
];

export function kanbanStatusCell(rowId: string, status: string) {
  return {
    editRevision: 1,
    fieldId: statusField.id,
    fieldType: DatabaseFieldKind.Select,
    rowId,
    updatedAt: TIMESTAMP,
    updatedBy: "user-1",
    value: {
      checkbox: null,
      date: null,
      dateTime: null,
      files: null,
      richText: null,
      uniqueId: null,
      formula: null,
      kind: DatabaseFieldKind.Select,
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
      select: status,
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
  };
}

export function kanbanScoreCell(rowId: string, score: number) {
  return {
    editRevision: 1,
    fieldId: scoreField.id,
    fieldType: DatabaseFieldKind.Number,
    rowId,
    updatedAt: TIMESTAMP,
    updatedBy: "user-1",
    value: {
      checkbox: null,
      date: null,
      dateTime: null,
      files: null,
      richText: null,
      uniqueId: null,
      formula: null,
      kind: DatabaseFieldKind.Number,
      multiSelect: null,
      tags: null,
      status: null,
      number: score,
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
  };
}

export function kanbanDueCell(rowId: string, day: number) {
  return {
    editRevision: 1,
    fieldId: dueField.id,
    fieldType: DatabaseFieldKind.Date,
    rowId,
    updatedAt: TIMESTAMP,
    updatedBy: "user-1",
    value: {
      checkbox: null,
      date: { end: null, start: `2026-07-${String(day).padStart(2, "0")}` },
      dateTime: null,
      files: null,
      richText: null,
      uniqueId: null,
      formula: null,
      kind: DatabaseFieldKind.Date,
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
  };
}

export function kanbanNotesCell(rowId: string, title: string) {
  return kanbanTextCell(notesField, rowId, `Kanban note ${title}`);
}

export function kanbanTextCell(
  field: DatabaseField,
  rowId: string,
  text: string,
) {
  return {
    editRevision: 1,
    fieldId: field.id,
    fieldType: DatabaseFieldKind.Text,
    rowId,
    updatedAt: TIMESTAMP,
    updatedBy: "user-1",
    value: {
      checkbox: null,
      date: null,
      dateTime: null,
      files: null,
      richText: null,
      uniqueId: null,
      formula: null,
      kind: DatabaseFieldKind.Text,
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
      text,
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
  };
}

export function kanbanRow(
  id: string,
  title: string,
  status: string,
  position: number,
  score: number,
): DatabaseRowRecord {
  const cells = [
    kanbanStatusCell(id, status),
    kanbanDueCell(id, position + 1),
    kanbanNotesCell(id, title),
    kanbanScoreCell(id, score),
  ];
  return {
    cells,
    cellRevisions: cells.map((cell) => ({
      editRevision: cell.editRevision,
      fieldId: cell.fieldId,
      hasValue: true,
      rowId: id,
    })),
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
      position,
      rowKind: "record",
      title,
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
    },
  };
}

export const kanbanRows: DatabaseRowRecord[] = [
  kanbanRow("todo-2", "Todo second", "todo", 3, 30),
  kanbanRow("done-3", "Done third", "done", 8, 90),
  kanbanRow("doing-1", "Doing first", "doing", 1, 20),
  kanbanRow("todo-1", "Todo first", "todo", 0, 10),
  kanbanRow("doing-3", "Doing third", "doing", 7, 80),
  kanbanRow("done-1", "Done first", "done", 2, 40),
  kanbanRow("todo-3", "Todo third", "todo", 6, 70),
  kanbanRow("done-2", "Done second", "done", 5, 60),
  kanbanRow("doing-2", "Doing second", "doing", 4, 50),
];

export const kanbanRowsWithUnassigned: DatabaseRowRecord[] = [
  ...kanbanRows,
  kanbanRow("unassigned-1", "Unassigned first", "unassigned", 9, 100),
];

export const largeKanbanRows: DatabaseRowRecord[] = Array.from(
  { length: 24 },
  (_, index) => {
    const groups = ["todo", "doing", "done"] as const;
    const group = groups[index % groups.length]!;
    const row = kanbanRow(
      `large-${index + 1}`,
      `Large task ${index + 1}`,
      group,
      index,
      index + 1,
    );
    return {
      ...row,
      cells: [
        ...row.cells,
        kanbanTextCell(ownerField, row.row.id, `Owner ${index + 1}`),
        kanbanTextCell(phaseField, row.row.id, `Phase ${group}`),
        kanbanTextCell(impactField, row.row.id, `Impact ${index + 1}`),
      ],
    };
  },
);

export const rowTemplates: DatabaseRowTemplateBinding[] = [
  {
    archived: false,
    detached: false,
    disabled: false,
    reconcileRequired: false,
    templateAvailable: true,
    rowTemplate: {
      editRevision: 1,
      createdAt: TIMESTAMP,
      createdBy: "user-1",
      databaseId: "database-1",
      description: null,
      enabled: true,
      id: "row-template-default",
      initialCellValues: [
        {
          fieldId: notesField.id,
          fieldType: DatabaseFieldKind.Text,
          value: {
            checkbox: null,
            date: null,
            dateTime: null,
            files: null,
            richText: null,
            uniqueId: null,
            formula: null,
            kind: DatabaseFieldKind.Text,
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
            text: "Seed note",
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
      isDefault: true,
      name: "Task template",
      position: 0,
      rowKind: "record",
      templateId: "template-entry-1",
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      workspaceId: "workspace-1",
    },
  },
  {
    archived: false,
    detached: false,
    disabled: false,
    reconcileRequired: true,
    templateAvailable: false,
    rowTemplate: {
      editRevision: 1,
      createdAt: TIMESTAMP,
      createdBy: "user-1",
      databaseId: "database-1",
      description: null,
      enabled: true,
      id: "row-template-reconcile",
      initialCellValues: [],
      isDefault: false,
      name: "Needs reconcile",
      position: 1,
      rowKind: "record",
      templateId: "template-entry-2",
      updatedAt: TIMESTAMP,
      updatedBy: "user-1",
      workspaceId: "workspace-1",
    },
  },
];

/** Admit the explicitly authored fixture roles through the managed projection.
 * Production consumers must receive this projection from the server. */
export function readyManagedRecord(source: DatabaseRecord): DatabaseRecord {
  return {
    ...source,
    managedSchema: {
      readiness: DatabaseManagedSchemaReadiness.Ready,
      reasonCode: null,
      templateId: "simple_project",
      templateVersion: "1.0.0",
      templateDigest: "fixture",
      variant: {
        priority: ProjectOptionPreset.ThreeStep,
        complexity: ProjectOptionPreset.ThreeStep,
        structure: ProjectStructurePreset.TasksOnly,
        currency: "EUR",
      },
      schemaRevision: 1,
      canEditStructure: false,
      canEditMetadata: true,
      canManageLifecycle: true,
      taskBindings: [
        { roleKey: "task.title", fieldId: titleField.id },
        ...source.fieldRoles
          .filter(
            (role) =>
              role.rowKindScope === "task" && role.roleKey !== "task.title",
          )
          .map(({ roleKey, fieldId }) => ({ roleKey, fieldId })),
      ],
    },
  };
}
