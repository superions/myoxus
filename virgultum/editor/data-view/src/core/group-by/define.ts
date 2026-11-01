import { stableClassHash } from "@virgultum/shared/styles";
import dayjs from "dayjs";

import {
  formatCalendarDate as fmt,
  startOfCalendarWeek,
} from "../utils/calendar-date.js";
import type { TypeInstance } from "../logical/type.js";
import { t } from "../logical/type-presets.js";
import { createUniComponentFromWebComponent } from "../utils/uni-component/uni-component.js";
import { BooleanGroupView } from "./renderer/boolean-group.js";
import { DateGroupView } from "./renderer/date-group.js";
import { NumberGroupView } from "./renderer/number-group.js";
import { SelectGroupView } from "./renderer/select-group.js";
import { StringGroupView } from "./renderer/string-group.js";
import type { GroupByConfig } from "./types.js";

export const createGroupByConfig = <
  Data extends Record<string, unknown>,
  MatchType extends TypeInstance,
  GroupValue = unknown,
>(
  config: GroupByConfig<Data, MatchType, GroupValue>,
): GroupByConfig => config as never;

export const ungroups = {
  key: "Ungroups",
  value: null,
};

const rangeLabel = (a: Date, b: Date) =>
  `${fmt(a, "MMM D YYYY")} – ${fmt(b, "MMM D YYYY")}`;

function buildDateCfg(
  name: string,
  grouper: (ms: number | null) => { key: string; value: number | null }[],
  groupName: (v: number | null) => string,
): GroupByConfig {
  return createGroupByConfig({
    name,
    matchType: t.date.instance(),
    groupName: (_t, v) => groupName(v),
    defaultKeys: (_t) => [ungroups],
    valuesGroup: (v: number | null, _t) => grouper(v),
    addToGroup: (grp: number | null, _old: number | null) => grp,
    view: createUniComponentFromWebComponent(DateGroupView),
  });
}

const dateRelativeCfg = buildDateCfg(
  "date-relative",
  (v) => {
    if (v == null) return [ungroups];
    const d = dayjs(v).startOf("day").toDate();
    const today = dayjs().startOf("day").toDate();
    const daysDiff = dayjs(d).diff(today, "day");

    // Handle specific days
    if (daysDiff === 0) return [{ key: "today", value: +d }];
    if (daysDiff === 1) return [{ key: "tomorrow", value: +d }];
    if (daysDiff === -1) return [{ key: "yesterday", value: +d }];

    // Handle future dates
    if (daysDiff > 0) {
      if (daysDiff <= 7) return [{ key: "next7", value: +d }];
      if (daysDiff <= 30) return [{ key: "next30", value: +d }];
      // Group by month for future dates beyond 30 days
      const m = dayjs(d).startOf("month").toDate();
      return [{ key: `${+m}`, value: +m }];
    }

    // Handle past dates
    const daysAgo = -daysDiff;
    if (daysAgo <= 7) return [{ key: "last7", value: +d }];
    if (daysAgo <= 30) return [{ key: "last30", value: +d }];
    // Group by month for past dates beyond 30 days
    const m = dayjs(d).startOf("month").toDate();
    return [{ key: `${+m}`, value: +m }];
  },
  (v) => {
    if (v == null) return "";
    const d = dayjs(v).startOf("day").toDate();
    const today = dayjs().startOf("day").toDate();
    const daysDiff = dayjs(d).diff(today, "day");

    // Handle specific days
    if (daysDiff === 0) return "Today";
    if (daysDiff === 1) return "Tomorrow";
    if (daysDiff === -1) return "Yesterday";

    // Handle future dates
    if (daysDiff > 0) {
      if (daysDiff <= 7) return "Next 7 days";
      if (daysDiff <= 30) return "Next 30 days";
      // Show month/year for future dates beyond 30 days
      return fmt(new Date(v), "MMM YYYY");
    }

    // Handle past dates
    const daysAgo = -daysDiff;
    if (daysAgo <= 7) return "Last 7 days";
    if (daysAgo <= 30) return "Last 30 days";
    // Show month/year for past dates beyond 30 days
    return fmt(new Date(v), "MMM YYYY");
  },
);

const dateDayCfg = buildDateCfg(
  "date-day",
  (v) => {
    if (v == null) return [ungroups];
    const d = dayjs(v).startOf("day").toDate();
    return [{ key: `${+d}`, value: +d }];
  },
  (v) => (v != null ? fmt(new Date(v), "MMM D YYYY") : ""),
);

const dateWeekSunCfg = buildDateCfg(
  "date-week-sun",
  (v) => {
    if (v == null) return [ungroups];
    const w = startOfCalendarWeek(new Date(v), 0);
    return [{ key: `${+w}`, value: +w }];
  },
  (v) =>
    v != null ? rangeLabel(new Date(v), dayjs(v).add(6, "day").toDate()) : "",
);

const dateWeekMonCfg = buildDateCfg(
  "date-week-mon",
  (v) => {
    if (v == null) return [ungroups];
    const w = startOfCalendarWeek(new Date(v), 1);
    return [{ key: `${+w}`, value: +w }];
  },
  (v) =>
    v != null ? rangeLabel(new Date(v), dayjs(v).add(6, "day").toDate()) : "",
);

const dateMonthCfg = buildDateCfg(
  "date-month",
  (v) => {
    if (v == null) return [ungroups];
    const m = dayjs(v).startOf("month").toDate();
    return [{ key: `${+m}`, value: +m }];
  },
  (v) => (v != null ? fmt(new Date(v), "MMM YYYY") : ""),
);

const dateYearCfg = buildDateCfg(
  "date-year",
  (v) => {
    if (v == null) return [ungroups];
    const y = dayjs(v).startOf("year").toDate();
    return [{ key: `${+y}`, value: +y }];
  },
  (v) => (v != null ? fmt(new Date(v), "YYYY") : ""),
);

export const groupByMatchers: GroupByConfig[] = [
  createGroupByConfig({
    name: "select",
    matchType: t.tag.instance(),
    groupName: (type, value: string | null) => {
      if (t.tag.is(type) && type.data)
        return type.data.find((v) => v.id === value)?.value ?? "";
      return "";
    },
    defaultKeys: (type) =>
      t.tag.is(type) && type.data
        ? [ungroups, ...type.data.map((v) => ({ key: v.id, value: v.id }))]
        : [ungroups],
    valuesGroup: (value, _t) =>
      value == null ? [ungroups] : [{ key: `${value}`, value }],
    addToGroup: (v: string | null, _old: string | null) => v,
    view: createUniComponentFromWebComponent(SelectGroupView),
  }),

  createGroupByConfig({
    name: "multi-select",
    matchType: t.array.instance(t.tag.instance()),
    groupName: (type, value: string | null) => {
      if (t.array.is(type) && t.tag.is(type.element) && type.element.data)
        return type.element.data.find((v) => v.id === value)?.value ?? "";
      return "";
    },
    defaultKeys: (type) =>
      t.array.is(type) && t.tag.is(type.element) && type.element.data
        ? [
            ungroups,
            ...type.element.data.map((v) => ({ key: v.id, value: v.id })),
          ]
        : [ungroups],
    valuesGroup: (value, _t) => {
      if (value == null) return [ungroups];
      if (Array.isArray(value) && value.length)
        return value.map((id) => ({ key: `${id}`, value: id }));
      return [ungroups];
    },
    addToGroup: (
      value: string | null,
      old: string[] | null,
    ): string[] | null => {
      if (value == null) return old;
      return Array.isArray(old) ? [...old, value] : [value];
    },
    removeFromGroup: (value, old) =>
      Array.isArray(old) ? old.filter((v) => v !== value) : old,
    view: createUniComponentFromWebComponent(SelectGroupView),
  }),

  createGroupByConfig({
    name: "text",
    matchType: t.string.instance(),
    groupName: (_t, v) => `${v ?? ""}`,
    defaultKeys: (_t) => [ungroups],
    valuesGroup: (v, _t) =>
      typeof v !== "string" || !v
        ? [ungroups]
        : [{ key: stableClassHash(v), value: v }],
    addToGroup: (v: string | null, _old: string | null) => v,
    view: createUniComponentFromWebComponent(StringGroupView),
  }),

  createGroupByConfig({
    name: "number",
    matchType: t.number.instance(),
    groupName: (_t, v) => `${v ?? ""}`,
    defaultKeys: (_t) => [ungroups],
    valuesGroup: (v, _t) =>
      typeof v !== "number"
        ? [ungroups]
        : [{ key: `g:${Math.floor(v / 10)}`, value: Math.floor(v / 10) }],
    addToGroup: (v: number | null, _old: number | null) =>
      typeof v === "number" ? v * 10 : null,
    view: createUniComponentFromWebComponent(NumberGroupView),
  }),

  createGroupByConfig({
    name: "boolean",
    matchType: t.boolean.instance(),
    groupName: (_t, v) => `${v?.toString() ?? ""}`,
    defaultKeys: (_t) => [
      { key: "true", value: true },
      { key: "false", value: false },
    ],
    valuesGroup: (v, _t) =>
      typeof v !== "boolean"
        ? [{ key: "false", value: false }]
        : [{ key: v.toString(), value: v }],
    addToGroup: (v: boolean | null, _old: boolean | null) => v,
    view: createUniComponentFromWebComponent(BooleanGroupView),
  }),

  dateRelativeCfg,
  dateDayCfg,
  dateWeekSunCfg,
  dateWeekMonCfg,
  dateMonthCfg,
  dateYearCfg,
];
