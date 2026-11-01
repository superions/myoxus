import {
  formatCalendarDate,
  parseCalendarDate,
} from "../../core/utils/calendar-date.js";
import zod from "zod";

import { t } from "../../core/logical/type-presets.js";
import { propertyType } from "../../core/property/property-config.js";
export const datePropertyType = propertyType("date");
export const datePropertyModelConfig = datePropertyType.modelConfig({
  name: "Date",
  propertyData: {
    schema: zod.object({}),
    default: () => ({}),
  },
  jsonValue: {
    schema: zod.number().nullable(),
    isEmpty: () => false,
    type: () => t.date.instance(),
  },
  rawValue: {
    schema: zod.number().nullable(),
    default: () => null,
    toString: ({ value }) =>
      value != null ? formatCalendarDate(value, "YYYY-MM-DD") : "",
    fromString: ({ value }) => {
      const date = parseCalendarDate(value);
      return { value: +date };
    },
    toJson: ({ value }) => value,
    fromJson: ({ value }) => value,
  },
});
