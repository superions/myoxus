/** @vitest-environment happy-dom */
import { describe, expect, test } from "vitest";

import {
  templateProvisioningModeKind,
  templateRevisionStateKind,
  templateSelectionModeKind,
  templateSourceKind,
  templateStatusKind,
} from "./badges";

describe("template badges", () => {
  test("normalizes current GraphQL PascalCase enum values", () => {
    expect(templateStatusKind("Active")).toBe("active");
    expect(templateStatusKind("Disabled")).toBe("disabled");
    expect(templateStatusKind("Archived")).toBe("archived");
    expect(templateSourceKind("Builtin")).toBe("builtin");
    expect(templateSourceKind("Bundle")).toBe("bundle");
    expect(templateRevisionStateKind("Published")).toBe("published");
    expect(templateRevisionStateKind("Validated")).toBe("validated");
    expect(templateSelectionModeKind("PinnedRevision")).toBe("pinnedRevision");
    expect(templateSelectionModeKind("Published")).toBe("published");
    expect(templateProvisioningModeKind("SeedOnce")).toBe("seedOnce");
    expect(templateProvisioningModeKind("ManagedUntilLocalEdit")).toBe(
      "managedUntilLocalEdit",
    );
    expect(templateProvisioningModeKind("ManualUpdate")).toBe("manualUpdate");
  });
});
