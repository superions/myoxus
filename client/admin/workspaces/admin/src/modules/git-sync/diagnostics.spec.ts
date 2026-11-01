import { describe, expect, test } from "vitest";

import { createGitSyncDiagnosis } from "./diagnostics";

describe("Git Sync diagnostics", () => {
  test("retains structural context without leaking component file paths or raw values", () => {
    const diagnosis = createGitSyncDiagnosis({
      code: "VALUE_TYPE",
      tab: "policy",
      fieldPath: "gitSync.enabled raw-secret-like-value",
      expectedType: "Boolean",
      actualType: "String",
      schemaRevision: "schema-revision-with-extra-data",
      configRevision: "config-revision-with-extra-data",
      componentStack:
        "\n at PolicyTab (/srv/private/admin/policy-tab.tsx:12:4)\n at SecretValue (/tmp/raw-secret-like-value.tsx:1:1)",
    });

    expect(diagnosis).toMatchObject({
      code: "VALUE_TYPE",
      tab: "policy",
      expectedType: "Boolean",
      actualType: "String",
      schemaRevision: "schema-revision-",
      configRevision: "config-revision-",
      componentStack: "PolicyTab>SecretValue",
    });
    expect(diagnosis.id).toMatch(/^GITSYNC-VALUE_TYPE-[0-9a-f]{8}$/);
    expect(JSON.stringify(diagnosis)).not.toContain("/srv/private");
    expect(JSON.stringify(diagnosis)).not.toContain("/tmp/");
    expect(JSON.stringify(diagnosis)).not.toContain("raw-secret-like-value");
  });
});
