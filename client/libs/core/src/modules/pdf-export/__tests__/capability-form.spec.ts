import { describe, expect, test } from "vitest";

import { createDefaultPdfExportFormValue } from "../capability-form";
import type {
  DocumentBrandingProfile,
  PdfExportSettings,
  PdfTemplateOption,
} from "../types";

const template: PdfTemplateOption = {
  id: "tpl-1",
  slug: "report",
  name: "Report",
  version: "1.0.0",
  schemaVersion: "2.0",
  isDefault: true,
  capabilities: {
    language: { kind: "enum", values: ["en", "de"], default: "en" },
    tocBehavior: {
      kind: "enum",
      values: ["off", "auto", "force"],
      default: "auto",
    },
    coverPage: { kind: "boolean", default: true },
    confidentialityLabels: {
      kind: "array<string>",
      min_items: 0,
      max_items: 3,
      default: ["Internal"],
    },
  },
  inputsSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
    },
  },
};

const emptySettings: PdfExportSettings = {
  workspaceId: "ws-1",
  defaultTemplateId: null,
  defaultLocale: null,
  defaultPaperSize: null,
  defaultColorProfile: null,
  defaultImageQuality: null,
  ligaturesEnabled: true,
};

const emptyBrandingProfile: DocumentBrandingProfile = {
  workspaceId: "ws-1",
  logoLargeBlob: null,
  logoSmallBlob: null,
  footerText: null,
  brandColorPrimary: null,
  brandColorAccent: null,
};

describe("PDF export capability form defaults", () => {
  test("uses PDF export settings before manifest defaults", () => {
    const value = createDefaultPdfExportFormValue(
      template,
      {
        ...emptySettings,
        defaultLocale: "de",
        defaultPaperSize: "Letter",
        defaultImageQuality: "lossless",
      },
      emptyBrandingProfile,
    );

    expect(value).toMatchObject({
      locale: "de",
      paperSize: "Letter",
      orientation: "portrait",
      complianceProfile: "pdfa-2u",
      imageQuality: "lossless",
      coverPage: true,
      tocBehavior: "auto",
      confidentialityLabel: "Internal",
    });
    expect(value.typedInputs).toEqual({ title: "Report" });
  });

  test("does not use document branding as a render-default fallback", () => {
    const value = createDefaultPdfExportFormValue(template, emptySettings, {
      ...emptyBrandingProfile,
      brandColorPrimary: "#112233",
      brandColorAccent: "#445566",
      footerText: "Confidential",
    });

    expect(value.locale).toBe("en");
    expect(value.paperSize).toBe("A4");
    expect(value.imageQuality).toBe("high");
    expect(value.orientation).toBe("portrait");
    expect(value.tocBehavior).toBe("auto");
  });

  test("uses the main web language when no workspace locale override exists", () => {
    const value = createDefaultPdfExportFormValue(
      template,
      emptySettings,
      emptyBrandingProfile,
      undefined,
      "de-DE",
    );

    expect(value.locale).toBe("de");
  });

  test("does not synthesize defaults for undeclared optional capabilities", () => {
    const value = createDefaultPdfExportFormValue(
      {
        ...template,
        capabilities: {
          language: template.capabilities.language,
        },
      },
      emptySettings,
      emptyBrandingProfile,
    );

    expect(value.locale).toBe("en");
    expect(value.paperSize).toBe("A4");
    expect(value.imageQuality).toBe("high");
    expect(value.coverPage).toBeUndefined();
    expect(value.tocBehavior).toBeUndefined();
    expect(value.confidentialityLabel).toBeUndefined();
  });

  test("prefills required typed inputs from the document title", () => {
    const value = createDefaultPdfExportFormValue(
      {
        ...template,
        inputsSchema: {
          type: "object",
          required: [
            "title",
            "recipient_address",
            "reviewed",
            "revision",
            "metadata",
          ],
          properties: {
            title: { type: "string" },
            recipient_address: {
              type: "array",
              items: { type: "string" },
            },
            reviewed: { type: "boolean" },
            revision: { type: "integer" },
            metadata: { type: "object" },
          },
        },
      },
      emptySettings,
      emptyBrandingProfile,
      "Quarterly Review",
    );

    expect(value.typedInputs).toEqual({
      title: "Quarterly Review",
      recipient_address: ["Quarterly Review"],
      reviewed: true,
      revision: 1,
      metadata: {},
    });
  });
});
