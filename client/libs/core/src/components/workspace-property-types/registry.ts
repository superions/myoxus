// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import type {
  WorkspacePropertyFilter,
  WorkspacePropertyType,
} from "@myoxus/core/modules/workspace-property";
import type { I18nString } from "@myoxus/i18n";
import {
  CheckBoxCheckLinearIcon,
  DateTimeIcon,
  EdgelessIcon,
  FileIcon,
  HistoryIcon,
  LongerIcon,
  MemberIcon,
  NumberIcon,
  PropertyIcon,
  TagIcon,
  TemplateIcon,
  TextIcon,
  TodayIcon,
} from "@myoxus/icons/react";
import type { FC, SVGProps } from "react";

import type { DocListPropertyProps, GroupHeaderProps } from "../explorer/types";
import type { PropertyValueProps } from "../properties/types";
import {
  CheckboxDocListProperty,
  CheckboxFilterValue,
  CheckboxGroupHeader,
  CheckboxValue,
  DateDocListProperty,
  DateFilterValue,
  DateGroupHeader,
  DateValue,
  NumberDocListProperty,
  NumberFilterValue,
  NumberGroupHeader,
  NumberValue,
  TextDocListProperty,
  TextFilterValue,
  TextGroupHeader,
  TextValue,
} from "./basic-properties";
import {
  CreateAtDocListProperty,
  CreateAtValue,
  CreatedAtFilterValue,
  CreatedAtGroupHeader,
  CreatedByDocListInlineProperty,
  CreatedByUpdatedByFilterValue,
  CreatedByValue,
  DocPrimaryModeDocListProperty,
  DocPrimaryModeFilterValue,
  DocPrimaryModeGroupHeader,
  DocPrimaryModeValue,
  EdgelessThemeDocListProperty,
  EdgelessThemeFilterValue,
  EdgelessThemeGroupHeader,
  EdgelessThemeValue,
  JournalDocListProperty,
  JournalFilterValue,
  JournalGroupHeader,
  JournalValue,
  ModifiedByGroupHeader,
  PageWidthDocListProperty,
  PageWidthFilterValue,
  PageWidthGroupHeader,
  PageWidthValue,
  TemplateDocListProperty,
  TemplateFilterValue,
  TemplateGroupHeader,
  TemplateValue,
  UpdatedAtDocListProperty,
  UpdatedAtFilterValue,
  UpdatedAtGroupHeader,
  UpdatedAtValue,
  UpdatedByDocListInlineProperty,
  UpdatedByValue,
} from "./doc-meta-properties";
import {
  TagsDocListProperty,
  TagsFilterValue,
  TagsGroupActions,
  TagsGroupHeader,
  TagsValue,
} from "./tags-property";

export const DateFilterMethod = {
  after: "com.myoxus.filter.after",
  before: "com.myoxus.filter.before",
  between: "com.myoxus.filter.between",
  "last-3-days": "com.myoxus.filter.last 3 days",
  "last-7-days": "com.myoxus.filter.last 7 days",
  "last-15-days": "com.myoxus.filter.last 15 days",
  "last-30-days": "com.myoxus.filter.last 30 days",
  "this-week": "com.myoxus.filter.this week",
  "this-month": "com.myoxus.filter.this month",
  "this-quarter": "com.myoxus.filter.this quarter",
  "this-year": "com.myoxus.filter.this year",
} as const;

const IS_OR_IS_NOT_FILTER = {
  is: "com.myoxus.editCollection.rules.include.is",
  "is-not": "com.myoxus.editCollection.rules.include.is-not",
} as const;

const EMPTINESS_FILTER = {
  "is-not-empty": "com.myoxus.filter.is not empty",
  "is-empty": "com.myoxus.filter.is empty",
} as const;

export type WorkspacePropertyTypeDescriptor<
  T extends WorkspacePropertyType = WorkspacePropertyType,
> = {
  icon: FC<SVGProps<SVGSVGElement>>;
  value?: FC<PropertyValueProps>;
  allowInOrderBy?: boolean;
  allowInGroupBy?: boolean;
  filterMethod?: { [K in WorkspacePropertyFilter<T>]: I18nString };
  filterValue?: FC<{
    filter: FilterParams;
    isDraft?: boolean;
    onChange?: (filter: FilterParams) => void;
  }>;
  defaultFilter?: Omit<FilterParams, "type" | "key">;
  uniqueId?: string;
  name: I18nString;
  renameable?: boolean;
  description?: I18nString;
  showInDocList?: "inline" | "stack";
  docListProperty?: FC<DocListPropertyProps>;
  groupHeader?: FC<GroupHeaderProps>;
  groupActions?: FC<{ groupId: string }>;
};

export const WorkspacePropertyTypes = {
  tags: {
    icon: TagIcon,
    value: TagsValue,
    name: "com.myoxus.page-properties.property.tags",
    uniqueId: "tags",
    renameable: false,
    description: "com.myoxus.page-properties.property.tags.tooltips",
    filterMethod: {
      "include-all": "com.myoxus.filter.contains all",
      "include-any-of": "com.myoxus.filter.contains one of",
      "not-include-all": "com.myoxus.filter.does not contains all",
      "not-include-any-of": "com.myoxus.filter.does not contains one of",
      ...EMPTINESS_FILTER,
    },
    allowInGroupBy: true,
    allowInOrderBy: true,
    defaultFilter: { method: "is-not-empty" },
    filterValue: TagsFilterValue,
    showInDocList: "inline",
    docListProperty: TagsDocListProperty,
    groupHeader: TagsGroupHeader,
    groupActions: TagsGroupActions,
  },
  text: {
    icon: TextIcon,
    value: TextValue,
    name: "com.myoxus.page-properties.property.text",
    description: "com.myoxus.page-properties.property.text.tooltips",
    filterMethod: {
      ...IS_OR_IS_NOT_FILTER,
      ...EMPTINESS_FILTER,
    },
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterValue: TextFilterValue,
    defaultFilter: { method: "is-not-empty" },
    showInDocList: "stack",
    docListProperty: TextDocListProperty,
    groupHeader: TextGroupHeader,
  },
  number: {
    icon: NumberIcon,
    value: NumberValue,
    name: "com.myoxus.page-properties.property.number",
    description: "com.myoxus.page-properties.property.number.tooltips",
    filterMethod: {
      "<": "<",
      "=": "=",
      "≠": "≠",
      "≥": "≥",
      "≤": "≤",
      ">": ">",
      ...EMPTINESS_FILTER,
    },
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterValue: NumberFilterValue,
    defaultFilter: { method: "is-not-empty" },
    showInDocList: "stack",
    docListProperty: NumberDocListProperty,
    groupHeader: NumberGroupHeader,
  },
  checkbox: {
    icon: CheckBoxCheckLinearIcon,
    value: CheckboxValue,
    name: "com.myoxus.page-properties.property.checkbox",
    description: "com.myoxus.page-properties.property.checkbox.tooltips",
    filterMethod: { ...IS_OR_IS_NOT_FILTER },
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterValue: CheckboxFilterValue,
    defaultFilter: { method: "is", value: "true" },
    showInDocList: "stack",
    docListProperty: CheckboxDocListProperty,
    groupHeader: CheckboxGroupHeader,
  },
  date: {
    icon: DateTimeIcon,
    value: DateValue,
    name: "com.myoxus.page-properties.property.date",
    description: "com.myoxus.page-properties.property.date.tooltips",
    filterMethod: {
      ...EMPTINESS_FILTER,
      ...DateFilterMethod,
    },
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterValue: DateFilterValue,
    defaultFilter: { method: "is-not-empty" },
    showInDocList: "stack",
    docListProperty: DateDocListProperty,
    groupHeader: DateGroupHeader,
  },
  createdBy: {
    icon: MemberIcon,
    value: CreatedByValue,
    name: "com.myoxus.page-properties.property.createdBy",
    uniqueId: "createdBy",
    description: "com.myoxus.page-properties.property.createdBy.tooltips",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: { include: "com.myoxus.filter.contains all" },
    filterValue: CreatedByUpdatedByFilterValue,
    defaultFilter: { method: "include", value: "" },
    showInDocList: "inline",
    docListProperty: CreatedByDocListInlineProperty,
    groupHeader: ModifiedByGroupHeader,
  },
  updatedBy: {
    icon: MemberIcon,
    value: UpdatedByValue,
    name: "com.myoxus.page-properties.property.updatedBy",
    uniqueId: "updatedBy",
    description: "com.myoxus.page-properties.property.updatedBy.tooltips",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: { include: "com.myoxus.filter.contains all" },
    filterValue: CreatedByUpdatedByFilterValue,
    defaultFilter: { method: "include", value: "" },
    showInDocList: "inline",
    docListProperty: UpdatedByDocListInlineProperty,
    groupHeader: ModifiedByGroupHeader,
  },
  updatedAt: {
    icon: DateTimeIcon,
    value: UpdatedAtValue,
    name: "com.myoxus.page-properties.property.updatedAt",
    uniqueId: "updatedAt",
    description: "com.myoxus.page-properties.property.updatedAt.tooltips",
    renameable: false,
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: { ...DateFilterMethod },
    filterValue: UpdatedAtFilterValue,
    defaultFilter: { method: "this-week" },
    showInDocList: "inline",
    docListProperty: UpdatedAtDocListProperty,
    groupHeader: UpdatedAtGroupHeader,
  },
  createdAt: {
    icon: HistoryIcon,
    value: CreateAtValue,
    name: "com.myoxus.page-properties.property.createdAt",
    uniqueId: "createdAt",
    description: "com.myoxus.page-properties.property.createdAt.tooltips",
    renameable: false,
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: { ...DateFilterMethod },
    filterValue: CreatedAtFilterValue,
    defaultFilter: { method: "this-week" },
    showInDocList: "inline",
    docListProperty: CreateAtDocListProperty,
    groupHeader: CreatedAtGroupHeader,
  },
  docPrimaryMode: {
    icon: FileIcon,
    value: DocPrimaryModeValue,
    name: "com.myoxus.page-properties.property.docPrimaryMode",
    uniqueId: "docPrimaryMode",
    description: "com.myoxus.page-properties.property.docPrimaryMode.tooltips",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: { ...IS_OR_IS_NOT_FILTER },
    filterValue: DocPrimaryModeFilterValue,
    defaultFilter: { method: "is", value: "page" },
    showInDocList: "stack",
    docListProperty: DocPrimaryModeDocListProperty,
    groupHeader: DocPrimaryModeGroupHeader,
  },
  journal: {
    icon: TodayIcon,
    value: JournalValue,
    name: "com.myoxus.page-properties.property.journal",
    uniqueId: "journal",
    description: "com.myoxus.page-properties.property.journal.tooltips",
    allowInGroupBy: true,
    allowInOrderBy: true,
    filterMethod: { ...IS_OR_IS_NOT_FILTER },
    filterValue: JournalFilterValue,
    defaultFilter: { method: "is", value: "true" },
    showInDocList: "stack",
    docListProperty: JournalDocListProperty,
    groupHeader: JournalGroupHeader,
  },
  edgelessTheme: {
    icon: EdgelessIcon,
    value: EdgelessThemeValue,
    name: "com.myoxus.page-properties.property.edgelessTheme",
    uniqueId: "edgelessTheme",
    description: "com.myoxus.page-properties.property.edgelessTheme.tooltips",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: EdgelessThemeDocListProperty,
    groupHeader: EdgelessThemeGroupHeader,
    filterMethod: { ...IS_OR_IS_NOT_FILTER },
    filterValue: EdgelessThemeFilterValue,
    defaultFilter: { method: "is", value: "system" },
  },
  pageWidth: {
    icon: LongerIcon,
    value: PageWidthValue,
    name: "com.myoxus.page-properties.property.pageWidth",
    uniqueId: "pageWidth",
    description: "com.myoxus.page-properties.property.pageWidth.tooltips",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: PageWidthDocListProperty,
    groupHeader: PageWidthGroupHeader,
    filterMethod: { ...IS_OR_IS_NOT_FILTER },
    filterValue: PageWidthFilterValue,
    defaultFilter: { method: "is", value: "fullWidth" },
  },
  template: {
    icon: TemplateIcon,
    value: TemplateValue,
    name: "com.myoxus.page-properties.property.template",
    uniqueId: "template",
    renameable: true,
    description: "com.myoxus.page-properties.property.template.tooltips",
    showInDocList: "stack",
    allowInGroupBy: true,
    allowInOrderBy: true,
    docListProperty: TemplateDocListProperty,
    groupHeader: TemplateGroupHeader,
    filterMethod: { ...IS_OR_IS_NOT_FILTER },
    filterValue: TemplateFilterValue,
    defaultFilter: { method: "is", value: "true" },
  },
  unknown: {
    icon: PropertyIcon,
    name: "Unknown",
    renameable: false,
  },
} as {
  [type in WorkspacePropertyType]: WorkspacePropertyTypeDescriptor<type>;
};

export const isSupportedWorkspacePropertyType = (
  type?: string,
): type is WorkspacePropertyType =>
  Boolean(type && type !== "unknown" && type in WorkspacePropertyTypes);
