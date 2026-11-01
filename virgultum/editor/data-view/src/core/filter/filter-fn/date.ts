import dayjs from "dayjs";

import { formatCalendarDate } from "../../utils/calendar-date.js";
import { t } from "../../logical/type-presets.js";
import { createFilter } from "./create.js";

export const dateFilter = [
  createFilter({
    name: "before",
    self: t.date.instance(),
    args: [t.date.instance()] as const,
    label: "Before",
    shortString: (v) =>
      v ? ` < ${formatCalendarDate(v.value, "YYYY/MM/DD")}` : undefined,
    impl: (self, value) => {
      if (self == null) {
        return false;
      }
      return self < value;
    },
    defaultValue: (args) => dayjs(args[0]).subtract(1, "day").valueOf(),
  }),
  createFilter({
    name: "after",
    self: t.date.instance(),
    args: [t.date.instance()] as const,
    label: "After",
    shortString: (v) =>
      v ? ` > ${formatCalendarDate(v.value, "YYYY/MM/DD")}` : undefined,
    impl: (self, value) => {
      if (self == null) {
        return false;
      }
      return self > value;
    },
    defaultValue: (args) => dayjs(args[0]).add(1, "day").valueOf(),
  }),
];
