// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";

import {
  filterUnitTypesForAuthoring,
  getUnitTypeCatalogSelection,
  withUnitTypeCatalogSelection,
} from "./unit-type-catalog";

const types = [
  { id: "default", key: "team", isActive: true, isPreset: true },
  { id: "kvk", key: "kvk.fachbereich", isActive: true, isPreset: true },
  { id: "kvg", key: "kvg.amt", isActive: true, isPreset: true },
  { id: "custom", key: "custom-board", isActive: true, isPreset: false },
  { id: "inactive", key: "kvk.inactive", isActive: false, isPreset: true },
];

describe("unit-type catalog authoring filter", () => {
  test("defaults to all for backwards-compatible diagnostics", () => {
    expect(getUnitTypeCatalogSelection({}).id).toBe("all");
    expect(
      filterUnitTypesForAuthoring(types, { schema_version: 1, id: "all" }).map(
        (type) => type.id,
      ),
    ).toEqual(["default", "kvk", "kvg", "custom"]);
  });

  test("current type remains selectable for existing out-of-catalog units", () => {
    expect(
      filterUnitTypesForAuthoring(
        types,
        { schema_version: 1, id: "kvk" },
        "custom",
      ).map((type) => type.id),
    ).toEqual(["kvk", "custom"]);
  });

  test("writes schema-versioned metadata without dropping unrelated keys", () => {
    const metadata = withUnitTypeCatalogSelection({ owner: "ops" }, "kvk");
    expect(metadata.owner).toBe("ops");
    expect(metadata.unit_type_catalog).toMatchObject({
      schema_version: 1,
      id: "kvk",
    });
  });
});
