/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test } from "vitest";

import { SystemPropertyTypes } from "../../components/system-property-types";
import { SYSTEM_LIST_METADATA_KEYS } from "./utils";

describe("canonical document metadata system properties", () => {
  test("exposes list metadata fields as first-class system properties", () => {
    for (const key of SYSTEM_LIST_METADATA_KEYS) {
      const property = SystemPropertyTypes[key];
      expect(property.allowInGroupBy, `${key} must be groupable`).toBe(true);
      expect(property.allowInOrderBy, `${key} must be orderable`).toBe(true);
      expect(property.filterMethod, `${key} must be filterable`).toBeTruthy();
      expect(property.docListProperty).toBeTypeOf("function");
    }
  });
});
