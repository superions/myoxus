import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const updateConfigMock = vi.fn();
const saveGroupMock = vi.fn().mockResolvedValue(undefined);
const resetGroupMock = vi.fn();
const mutateMock = vi.fn();
const updateWorkspaceSettingsMock = vi.fn().mockResolvedValue({});

vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => en[key] ?? key,
    }),
  };
});

vi.mock("../../../use-query", () => ({
  useQuery: () => ({
    data: {
      admin: {
        adminWorkspaces: [{ id: "ws-1", name: "Alpha Workspace" }],
      },
    },
  }),
}));

vi.mock("../../settings/use-app-config", () => ({
  useAppConfig: () => ({
    appConfig: {
      document_versioning: {
        default_enabled: true,
        default_auto_version_on_pdf_export: false,
        default_retention_count: 10,
      },
      pdf_export: {},
    },
    patchedAppConfig: {
      document_versioning: {
        default_enabled: true,
        default_auto_version_on_pdf_export: false,
        default_retention_count: 10,
      },
      pdf_export: {},
    },
    update: updateConfigMock,
    saveGroup: saveGroupMock,
    resetGroup: resetGroupMock,
    isGroupDirty: () => true,
    isGroupSaving: () => false,
  }),
}));

vi.mock("../logging", () => ({
  logPdfExportUiEvent: vi.fn(),
}));

vi.mock("../api", () => ({
  useDocumentVersioningAdminSettingsQuery: () => ({
    defaults: {
      defaultEnabled: true,
      defaultAutoVersionOnPdfExport: false,
      defaultRetentionCount: 10,
    },
    workspaceSettings: [
      {
        workspaceId: "ws-1",
        workspaceName: "Alpha Workspace",
        enabled: false,
        autoVersionOnPdfExport: true,
        retentionCount: 12,
        effectiveEnabled: false,
        effectiveAutoVersionOnPdfExport: true,
        effectiveRetentionCount: 12,
        updatedAt: "2026-05-01T10:00:00Z",
      },
    ],
    mutate: mutateMock,
  }),
  useUpdateDocumentVersioningWorkspaceSettingsMutation: () => ({
    trigger: updateWorkspaceSettingsMock,
    isMutating: false,
  }),
  usePdfExportSettingsQuery: () => ({ settings: null, mutate: vi.fn() }),
  usePdfWorkspaceAssignmentsQuery: () => ({ assignments: [] }),
  usePdfTemplatesQuery: () => ({ templates: [] }),
  useSetWorkspaceDefaultPdfTemplateMutation: () => ({ trigger: vi.fn() }),
  useUpdatePdfExportSettingsMutation: () => ({ trigger: vi.fn() }),
}));

import { SettingsTab } from "./settings-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("PDF export settings document-versioning admin controls", () => {
  beforeEach(() => {
    updateConfigMock.mockClear();
    saveGroupMock.mockClear();
    resetGroupMock.mockClear();
    mutateMock.mockClear();
    updateWorkspaceSettingsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("saves workspace overrides through the admin GraphQL contract", () => {
    renderWithFacade(<SettingsTab />);

    fireEvent.click(
      screen.getAllByText(
        en["admin.pdf-settings.doc-versioning.workspace.save"],
      )[0],
    );

    expect(updateWorkspaceSettingsMock).toHaveBeenCalledWith({
      input: {
        workspaceId: "ws-1",
        enabled: false,
        autoVersionOnPdfExport: true,
        retentionCount: 12,
      },
    });
  });

  test("updates global document-versioning defaults via appConfig", () => {
    renderWithFacade(<SettingsTab />);

    fireEvent.click(
      screen.getByLabelText(
        en["admin.pdf-settings.doc-versioning.default-pdf"],
      ),
    );

    expect(updateConfigMock).toHaveBeenCalledWith(
      "document_versioning/default_auto_version_on_pdf_export",
      true,
    );
  });
});
