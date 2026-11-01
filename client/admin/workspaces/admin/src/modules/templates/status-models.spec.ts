/** @vitest-environment happy-dom */
import { describe, expect, test } from "vitest";

import {
  buildTemplateImportStatusModel,
  parseTemplateExportFilename,
  readTemplateExportError,
} from "./status-models";

describe("status-models", () => {
  test("buildTemplateImportStatusModel splits normalization and compatibility notes", () => {
    const status = buildTemplateImportStatusModel({
      entry: { id: "tpl-1", slug: "test", title: "Test" },
      revision: { id: "rev-1", version: "1.0.0", state: "VALIDATED" },
      detectedFormat: "upstream_snapshot_zip",
      normalized: true,
      ignoredEntriesCount: 3,
      errorCatalogVersion: "v1",
      warnings: [
        {
          code: "NORMALIZED_ASSET_PATH",
          message: "normalized path",
          severity: "WARNING",
        },
        {
          code: "LEGACY_FIELD_DROPPED",
          message: "legacy field dropped",
          severity: "WARNING",
        },
      ],
    });

    expect(status.detectedFormat).toBe("upstream_snapshot_zip");
    expect(status.normalized).toBe(true);
    expect(status.ignoredEntriesCount).toBe(3);
    expect(status.errorCatalogVersion).toBe("v1");
    expect(status.normalizationWarnings).toEqual([
      "NORMALIZED_ASSET_PATH: normalized path",
    ]);
    expect(status.compatibilityNotes).toEqual([
      "LEGACY_FIELD_DROPPED: legacy field dropped",
    ]);
  });

  test("parseTemplateExportFilename supports plain and utf8 filename headers", () => {
    expect(
      parseTemplateExportFilename('attachment; filename="template-a.zip"'),
    ).toBe("template-a.zip");
    expect(
      parseTemplateExportFilename(
        "attachment; filename*=UTF-8''template-weekly-1.0.0.zip",
      ),
    ).toBe("template-weekly-1.0.0.zip");
  });

  test("readTemplateExportError prefers json message when available", async () => {
    const response = {
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ message: "Export disabled" }),
      text: async () => "fallback",
    } as unknown as Response;

    await expect(readTemplateExportError(response)).resolves.toBe(
      "Export disabled",
    );
  });
});
