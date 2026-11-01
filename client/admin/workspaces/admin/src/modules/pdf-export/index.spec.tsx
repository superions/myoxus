import type { ReactElement } from "react";
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const tMock = vi.fn((key: string) => en[key] ?? key);

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("../header", () => ({
  Header: ({ title }: { title: string }) => (
    <div data-testid="header">{title}</div>
  ),
}));

vi.mock("./components/templates-tab", () => ({
  TemplatesTab: () => <div data-testid="templates-tab">Templates</div>,
}));

vi.mock("./components/workspaces-tab", () => ({
  WorkspacesTab: () => <div data-testid="workspaces-tab">Workspaces</div>,
}));

vi.mock("./components/brand-assets-tab", () => ({
  BrandAssetsTab: () => <div data-testid="brand-tab">Brand</div>,
}));

vi.mock("./components/icc-profiles-tab", () => ({
  IccProfilesTab: () => <div data-testid="icc-tab">ICC</div>,
}));

vi.mock("./components/jobs-tab", () => ({
  JobsTab: () => <div data-testid="jobs-tab">Jobs</div>,
}));

vi.mock("./components/settings-tab", () => ({
  SettingsTab: () => <div data-testid="settings-tab">Settings</div>,
}));

import { PdfExportPage } from "./index";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("PdfExportPage", () => {
  beforeEach(() => {
    tMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("Templates tab is active by default and every visible tab remains reachable", () => {
    renderWithFacade(<PdfExportPage />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("templates-tab")).toBeTruthy();

    for (const tab of tabs) {
      fireEvent.click(tab);
      expect(tab.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByTestId("header").textContent).toBe(
        en["admin.pdf-export.title"],
      );
    }
  });
});
