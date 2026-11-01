/**
 * @vitest-environment node
 */
import { describe, expect, test } from "vitest";

import deJson from "../../../../../../libs/i18n/src/resources/de.json";
import enJson from "../../../../../../libs/i18n/src/resources/en.json";
import type { PdfTemplateViewModel } from "./format-adapters";
import {
  pdfTemplateDisplayDescription,
  pdfTemplateDisplayName,
  pdfTemplateSearchText,
} from "./template-localization";

const en: Record<string, string> = enJson;
const de: Record<string, string> = deJson;

const t =
  (resource: Record<string, string>) =>
  (key: string): string =>
    resource[key] ?? key;

function template(
  patch: Partial<PdfTemplateViewModel> = {},
): PdfTemplateViewModel {
  return {
    id: "tpl-report",
    slug: "report",
    name: "Report",
    version: "1.0.0",
    schemaVersion: "2.0",
    description: "Raw report description",
    category: "report",
    source: "system",
    createdBy: null,
    createdAt: "2026-05-01T10:00:00Z",
    deletedAt: null,
    isDeleted: false,
    manifest: {},
    capabilities: {},
    provenance: null,
    ...patch,
  };
}

describe("PDF template localization", () => {
  test("localizes builtin display names and descriptions without changing imported templates", () => {
    const system = template();
    const imported = template({
      id: "tpl-custom",
      slug: "custom-report",
      name: "Custom Report",
      source: "admin",
      createdBy: "admin@example.com",
    });

    expect(pdfTemplateDisplayName(system, t(de))).toBe("Bericht");
    expect(pdfTemplateDisplayDescription(system, t(de))).toContain(
      "Berichtsvorlage",
    );
    expect(pdfTemplateDisplayName(imported, t(de))).toBe("Custom Report");
    expect(pdfTemplateDisplayDescription(imported, t(de))).toBe(
      "Raw report description",
    );
  });

  test("keeps builtin search functional for raw and localized names", () => {
    const system = template();

    expect(pdfTemplateSearchText(system, t(en))).toContain("report");
    expect(pdfTemplateSearchText(system, t(de))).toContain("bericht");
  });
});
