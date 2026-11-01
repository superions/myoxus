import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const tMock = vi.fn((key: string) => en[key] ?? key);
const updateConfig = vi.fn();
const saveGroup = vi.fn().mockResolvedValue(undefined);
const resetGroup = vi.fn();
const mutateSettings = vi.fn().mockResolvedValue(undefined);
const updatePdfExportSettings = vi.fn().mockResolvedValue({});
const setDefaultTemplate = vi.fn().mockResolvedValue({});
const updateDocumentVersioningWorkspaceSettings = vi.fn().mockResolvedValue({});
const initialSettings = {
  workspaceId: "ws-1",
  defaultPaperSize: "A4",
  defaultLocale: "en",
  defaultColorProfile: "sRGB",
  defaultImageQuality: "high",
  defaultTemplateId: "tpl-1",
  ligaturesEnabled: true,
};
let settingsData: typeof initialSettings | null = initialSettings;
let settingsError: Error | undefined;

const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("../../../use-query", () => ({
  useQuery: () => ({
    data: {
      admin: {
        adminWorkspaces: [{ id: "ws-1", name: "Editorial" }],
      },
    },
  }),
}));

vi.mock("../../settings/use-app-config", () => ({
  useAppConfig: () => ({
    appConfig: {
      i18n: {
        defaultLocale: "en",
      },
      pdf_export: {
        limits: {
          max_concurrent_per_workspace: 3,
          max_input_blocks: 10000,
          max_pages: 500,
          render_timeout_seconds: 120,
          max_memory_mb: 1024,
        },
        max_template_size_mb: 32,
        sync_threshold_blocks: 80,
        max_brand_asset_size_mb: 8,
        max_font_size_mb: 16,
        max_dpi: 600,
        default_paper_size: "A4",
        default_color_profile: "sRGB",
        default_image_quality: "high",
        heading_font_scale: 0.95,
        body_font_scale: 1.05,
        verapdf_validator_url: "",
        verapdf_timeout_seconds: 30,
        edgeless_snapshot: {
          max_dim_px: 8192,
          max_total_px: 16777216,
          max_size_mb: 32,
        },
      },
    },
    patchedAppConfig: {},
    update: updateConfig,
    saveGroup,
    resetGroup,
    isGroupDirty: () => true,
    isGroupSaving: () => false,
  }),
}));

vi.mock("../api", () => ({
  usePdfIccProfilesQuery: () => ({
    profiles: [
      { name: "sRGB v4 (system)", profileType: "sRGB" },
      { name: "Artifex CMYK SWOP (system)", profileType: "CMYK" },
    ],
  }),
  usePdfExportSettingsQuery: () => ({
    settings: settingsData,
    error: settingsError,
    mutate: mutateSettings,
  }),
  usePdfWorkspaceAssignmentsQuery: () => ({
    assignments: [
      { templateId: "tpl-1", isDefault: true },
      { templateId: "tpl-2", isDefault: false },
    ],
  }),
  usePdfTemplatesQuery: () => ({
    templates: [
      { id: "tpl-1", name: "Default", version: "1.0.0" },
      { id: "tpl-2", name: "Report", version: "1.0.0" },
    ],
  }),
  useSetWorkspaceDefaultPdfTemplateMutation: () => ({
    setWorkspaceDefaultPdfTemplate: setDefaultTemplate,
  }),
  useUpdatePdfExportSettingsMutation: () => ({
    updatePdfExportSettings,
  }),
  useDocumentVersioningAdminSettingsQuery: () => ({
    workspaceSettings: [
      {
        workspaceId: "ws-1",
        workspaceName: "Editorial",
        enabled: null,
        autoVersionOnPdfExport: null,
        retentionCount: null,
        effectiveEnabled: true,
        effectiveAutoVersionOnPdfExport: true,
        effectiveRetentionCount: 5,
      },
    ],
    mutate: vi.fn(),
  }),
  useUpdateDocumentVersioningWorkspaceSettingsMutation: () => ({
    trigger: updateDocumentVersioningWorkspaceSettings,
    isMutating: false,
  }),
}));

import { SettingsTab } from "./settings-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function chooseOption(combo: HTMLElement, optionName: string) {
  fireEvent.mouseDown(combo);
  fireEvent.click(combo);
  const option = await waitFor(() => {
    const candidate = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((element) => {
      const dropdown = element.closest<HTMLElement>(".mantine-Select-dropdown");
      return (
        element.textContent?.includes(optionName) === true &&
        !dropdown?.getAttribute("style")?.includes("display: none")
      );
    });
    if (!candidate) {
      throw new Error(`Option ${optionName} not found`);
    }
    return candidate;
  });
  fireEvent.click(option);
}

describe("SettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsData = initialSettings;
    settingsError = undefined;
    saveGroup.mockResolvedValue(undefined);
    updatePdfExportSettings.mockResolvedValue({});
    setDefaultTemplate.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  test("saves global limits through the existing config service", async () => {
    renderWithFacade(<SettingsTab />);

    fireEvent.change(screen.getByLabelText("Max pages"), {
      target: { value: "750" },
    });
    fireEvent.change(screen.getByLabelText("veraPDF validator URL"), {
      target: { value: "http://verapdf:8080" },
    });
    fireEvent.change(screen.getByLabelText("veraPDF timeout seconds"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Heading font scale"), {
      target: { value: "0.8" },
    });
    fireEvent.click(screen.getByText("Save global limits"));

    await waitFor(() => {
      expect(updateConfig).toHaveBeenCalledWith(
        "pdf_export/limits/max_pages",
        750,
      );
      expect(updateConfig).toHaveBeenCalledWith(
        "pdf_export/verapdf_validator_url",
        "http://verapdf:8080",
      );
      expect(updateConfig).toHaveBeenCalledWith(
        "pdf_export/verapdf_timeout_seconds",
        45,
      );
      expect(updateConfig).toHaveBeenCalledWith(
        "pdf_export/heading_font_scale",
        0.8,
      );
      expect(saveGroup).toHaveBeenCalledWith("pdf_export");
    });
  });

  test("saves workspace defaults via PDF export settings mutation", async () => {
    renderWithFacade(<SettingsTab />);

    await chooseOption(
      screen.getByRole("combobox", {
        name: en["admin.pdf-settings.workspace.select"],
      }),
      "Editorial",
    );
    fireEvent.change(screen.getAllByLabelText("Default locale")[0], {
      target: { value: "de" },
    });
    await chooseOption(
      screen.getByLabelText("Default template"),
      "Report (1.0.0)",
    );
    fireEvent.click(screen.getByText("Save workspace defaults"));

    await waitFor(() => {
      expect(updatePdfExportSettings).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        paperSize: "A4",
        locale: "de",
        colorProfile: "sRGB",
        imageQuality: "high",
        ligaturesEnabled: true,
      });
      expect(setDefaultTemplate).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-2",
      });
      expect(mutateSettings).toHaveBeenCalled();
    });
  });
});
