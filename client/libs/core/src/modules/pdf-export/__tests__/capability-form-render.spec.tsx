/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  PdfCapabilityForm,
  validatePdfExportFormValue,
} from "../capability-form";
import type {
  DocumentBrandingProfile,
  PdfExportDialogFormValue,
  PdfExportSettings,
  PdfTemplateOption,
} from "../types";

const settings: PdfExportSettings = {
  workspaceId: "ws-1",
  defaultTemplateId: null,
  defaultLocale: "en",
  defaultPaperSize: "A4",
  defaultColorProfile: null,
  defaultImageQuality: "high",
  ligaturesEnabled: true,
};

const brandingProfile: DocumentBrandingProfile = {
  workspaceId: "ws-1",
  logoLargeBlob: null,
  logoSmallBlob: null,
  footerText: null,
  brandColorPrimary: null,
  brandColorAccent: null,
};

const minimalTemplate: PdfTemplateOption = {
  id: "tpl-min",
  slug: "minimal",
  name: "Minimal",
  version: "1.0.0",
  schemaVersion: "2.0",
  isDefault: true,
  capabilities: {
    language: { kind: "enum", values: ["en"], default: "en" },
  },
};

function renderForm(value: PdfExportDialogFormValue, onChange = vi.fn()) {
  return render(
    <MyoxusUIProvider>
      <PdfCapabilityForm
        template={minimalTemplate}
        settings={settings}
        brandingProfile={brandingProfile}
        value={value}
        onChange={onChange}
        validationErrors={validatePdfExportFormValue(minimalTemplate, value)}
      />
    </MyoxusUIProvider>,
  );
}

describe("PDF capability form rendering", () => {
  afterEach(cleanup);

  test("uses real facade form controls only for supported capabilities", () => {
    renderForm({ locale: "fr" });

    expect(screen.getByRole("combobox", { name: "Locale" }).tagName).toBe(
      "INPUT",
    );
    expect(screen.getByRole("combobox", { name: "PDF profile" }).tagName).toBe(
      "INPUT",
    );
    expect(screen.queryByText("Cover page")).toBeNull();
    expect(screen.queryByText("Confidentiality label")).toBeNull();
    expect(
      screen.getByText('Unsupported value "fr" for this template.').textContent,
    ).toBe('Unsupported value "fr" for this template.');
  });

  test("surfaces stale hidden history inputs instead of silently exporting them", () => {
    renderForm({
      locale: "en",
      coverPage: true,
      tocBehavior: "auto",
      confidentialityLabel: "Internal",
    });

    const notice = screen.getByRole("alert");
    expect(notice.textContent).toContain(
      "Table of contents is not supported by this template.",
    );
    expect(notice.textContent).toContain(
      "Cover page is not supported by this template.",
    );
  });

  test("keeps advanced typed inputs behind the native accordion", () => {
    renderForm({});

    expect(
      screen
        .getByRole("button", { name: "Advanced typed inputs" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen.queryByRole("textbox", { name: "Advanced typed inputs" }),
    ).toBeNull();
  });
});
