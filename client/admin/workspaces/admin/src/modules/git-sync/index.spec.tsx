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

// Mocks

const useAppConfigMock = vi.fn();

vi.mock("../settings/use-app-config", () => ({
  useAppConfig: () => useAppConfigMock(),
}));

vi.mock("../common", () => ({
  useRevalidateServerConfig: () => vi.fn(),
}));

vi.mock("../header", () => ({
  Header: ({ title }: { title: string }) => (
    <div data-testid="header">{title}</div>
  ),
}));

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
const en: Record<string, string> = enJson;

const tMock = vi.fn((key: string, options?: Record<string, any>): string => {
  let text = en[key];
  if (!text) return key;
  if (options) {
    Object.entries(options).forEach(([k, v]) => {
      text = text!.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
    });
  }
  return text;
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("../settings/config", () => ({
  ALL_CONFIG_DESCRIPTORS: {
    git_sync: {
      enabled: { desc: "Enable Git Sync", type: "Boolean" },
    },
    serverTuning: {},
  },
}));

vi.mock("../settings/config-form-fields", () => {
  const field =
    (type: string) =>
    ({ field }: { field: string }) => (
      <div data-testid={`field-${field}`} data-type={type}>
        {field}
      </div>
    );
  return {
    ConfigTextField: field("String"),
    ConfigNumberField: field("Number"),
    ConfigBooleanField: field("Boolean"),
    ConfigSelectField: field("Enum"),
    ConfigMultiSelectField: field("Array"),
    ConfigArrayField: field("Array"),
    ConfigJsonField: field("JSON"),
    ConfigCheckboxGroupField: field("CheckboxGroup"),
    ConfigRadioSelectField: field("RadioSelect"),
    ConfigColorField: field("Color"),
    YamlOnlyBanner: () => null,
  };
});

vi.mock("../settings/sensitive", () => ({
  isSensitiveConfigField: () => false,
}));

// Mock all sub-tab components to verify they render in the right tab
vi.mock("./policy-tab", () => ({
  PolicyTab: () => (
    <div data-testid="policy-tab-content">PolicyTab Content</div>
  ),
}));

vi.mock("./activity-tab", () => ({
  ActivityTab: () => (
    <div data-testid="activity-tab-content">ActivityTab Content</div>
  ),
}));

vi.mock("./operations-tab", () => ({
  OperationsTab: () => (
    <div data-testid="operations-tab-content">OperationsTab Content</div>
  ),
}));

vi.mock("./storage-tab", () => ({
  StorageTab: () => (
    <div data-testid="storage-tab-content">StorageTab Content</div>
  ),
}));

vi.mock("./profiles-tab", () => ({
  ProfilesTab: () => (
    <div data-testid="profiles-tab-content">ProfilesTab Content</div>
  ),
}));

// Import after mocks

import { GitSyncPage } from "./index";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

// Mock data

const MOCK_GIT_SYNC_CONFIG = {
  git_sync: {
    enabled: true,
    defaultDirection: "bidirectional",
  },
  serverTuning: {
    cacheTtlGitStatusSeconds: 60,
  },
};

describe("GitSyncPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/adminfrontend/git-sync");
    tMock.mockClear();
    useAppConfigMock.mockReset();
    useAppConfigMock.mockReturnValue({
      appConfig: MOCK_GIT_SYNC_CONFIG,
      patchedAppConfig: MOCK_GIT_SYNC_CONFIG,
      update: vi.fn(),
      saveGroup: vi.fn().mockResolvedValue(undefined),
      resetGroup: vi.fn(),
      isGroupDirty: vi.fn().mockReturnValue(false),
      isGroupSaving: vi.fn().mockReturnValue(false),
      getGroupVersion: vi.fn().mockReturnValue(0),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("keeps all tabs reachable and offers real recovery when config query fails", async () => {
    const reloadServerState = vi.fn().mockResolvedValue(undefined);
    const discardLocalChanges = vi.fn();
    useAppConfigMock.mockReturnValue({
      appConfig: MOCK_GIT_SYNC_CONFIG,
      patchedAppConfig: MOCK_GIT_SYNC_CONFIG,
      update: vi.fn(),
      saveGroup: vi.fn().mockResolvedValue(undefined),
      resetGroup: vi.fn(),
      isGroupDirty: vi.fn().mockReturnValue(false),
      isGroupSaving: vi.fn().mockReturnValue(false),
      getGroupVersion: vi.fn().mockReturnValue(0),
      fieldErrorsByPath: {},
      configFieldStates: {},
      normalizationIssues: [],
      schemaError: new Error("raw query payload must not render"),
      valuesError: undefined,
      isLoading: false,
      schemaRevision: "schema-revision",
      configRevision: "config-revision",
      reloadServerState,
      discardLocalChanges,
    });

    renderWithProvider(<GitSyncPage />);

    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(
      screen.getAllByText("Configuration needs attention").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("raw query payload must not render")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(
      await screen.findByText(/Diagnosis: GITSYNC-CONFIG_QUERY-/),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Reload server values" }),
    );
    await waitFor(() => expect(reloadServerState).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardLocalChanges).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    expect(discardLocalChanges).toHaveBeenCalledOnce();
  });
});
