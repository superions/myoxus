import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mocks

let mockQueryData: Record<string, unknown> = {};
let mockQueryError: Error | undefined;
let mockQueryLoading = false;
const mutateQueryMock = vi.fn().mockResolvedValue(undefined);
const mutationMock = vi.fn().mockResolvedValue({});

vi.mock("../../use-query", () => ({
  useQuery: () => ({
    data: mockQueryData,
    error: mockQueryError,
    isLoading: mockQueryLoading,
    mutate: mutateQueryMock,
  }),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: () => ({
    trigger: mutationMock,
    isMutating: false,
  }),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () => "Close",
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "admin.workspaces.git-sync-filter.all": "Show All",
        "admin.workspaces.git-sync-filter.enabled": "Show Enabled",
        "admin.git-sync.profiles.title": "Workspace Sync Profiles",
        "admin.git-sync.profiles.description":
          "All workspaces and their Git Sync status. Click a workspace to see its full sync profile in the Workspaces page.",
        "admin.git-sync.profiles.no-workspaces": "No workspaces found.",
        "admin.git-sync.profiles.pagination-hint":
          "Showing first 100 workspaces. Some workspaces may not be listed.",
        "admin.git-sync.profiles.table.workspace": "Workspace",
        "admin.git-sync.profiles.table.git-sync": "Git Sync",
        "admin.git-sync.profiles.table.last-sync-status": "Last Sync Status",
        "admin.git-sync.profiles.status.no-sync": "No sync",
        "admin.git-sync.profiles.status.success": "Success",
        "admin.git-sync.profiles.status.running": "Running",
        "admin.git-sync.profiles.status.failed": "Failed",
        "admin.git-sync.profiles.status.enabled": "Enabled",
        "admin.git-sync.profiles.status.disabled": "Disabled",
        "admin.git-sync.rotation.state.completed": "Completed",
        "admin.git-sync.rotation.state.configured": "Configured",
        "admin.git-sync.rotation.state.failed": "Failed before request",
        "admin.git-sync.rotation.state.manual-intervention":
          "Manual intervention",
        "admin.git-sync.rotation.state.rotating": "Rotating",
        "admin.git-sync.profiles.filter.all-aria": "Show all workspaces",
        "admin.git-sync.profiles.filter.enabled-aria":
          "Show only enabled workspaces",
        "admin.git-sync.profiles.list-aria": "Workspace sync profiles",
        "admin.git-sync.profiles.no-workspaces.desc":
          "Adjust filters to broaden the list.",
        "admin.git-sync.profiles.workspace-picker.clear": "Clear workspace",
        "admin.git-sync.profiles.workspace-picker.label": "Narrow by workspace",
        "admin.git-sync.profiles.workspace-picker.placeholder":
          "Search workspace profile",
        "admin.git-sync.recovery.title": "Configuration needs attention",
        "admin.git-sync.recovery.description":
          "The query could not be loaded safely.",
        "admin.git-sync.recovery.diagnosis": "Diagnosis: {{diagnosisId}}",
        "admin.git-sync.recovery.reload": "Reload server values",
        "admin.common.loading": "Loading",
        "admin.common.status": "Status",
        "admin.actions.close": "Close profile",
        "admin.actions.cancel": "Cancel",
        "admin.common.cancel": "Cancel",
        "admin.actions.edit": "Edit",
        "admin.common.discard-changes": "Discard changes",
        "admin.unsaved.discard-title": "Discard draft?",
        "admin.unsaved.discard-description": "Changes will not be saved.",
        "com.myoxus.integration.git-sync.create-profile": "Create profile",
        "com.myoxus.integration.git-sync.field.repo-url": "Repository URL",
        "com.myoxus.integration.git-sync.field.branch": "Branch",
      };
      let text = map[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        });
      }
      return text;
    },
  }),
}));

vi.mock("@myoxus/graphql", () => ({
  adminWorkspacesQuery: "mock-query",
  createGitSyncProfileMutation: { id: "createGitSyncProfileMutation" },
  getGitSyncPoliciesQuery: { id: "getGitSyncPoliciesQuery" },
  getGitSyncProfileQuery: { id: "getGitSyncProfileQuery" },
  getGitSyncStatusQuery: { id: "getGitSyncStatusQuery" },
  gitSyncSchedulePreviewQuery: { id: "gitSyncSchedulePreviewQuery" },
  gitSyncTimezonesQuery: { id: "gitSyncTimezonesQuery" },
  testGitConnectionMutation: { id: "testGitConnectionMutation" },
  triggerGitSyncMutation: { id: "triggerGitSyncMutation" },
  updateGitSyncProfileMutation: { id: "updateGitSyncProfileMutation" },
  GitSyncAuthMethod: {
    HttpsToken: "HttpsToken",
    HttpsPassword: "HttpsPassword",
    SshKey: "SshKey",
  },
  GitSyncCronMisfirePolicy: {
    Skip: "Skip",
    RunOnce: "RunOnce",
  },
  GitSyncDirection: {
    Bidirectional: "Bidirectional",
    MyoxusToGit: "MyoxusToGit",
    GitToMyoxus: "GitToMyoxus",
  },
  GitSyncRunSource: {
    Manual: "Manual",
    Polling: "Polling",
    Webhook: "Webhook",
    Cron: "Cron",
  },
  GitSyncTriggerMode: {
    Manual: "Manual",
    Polling: "Polling",
    Webhook: "Webhook",
    Cron: "Cron",
  },
  GitTokenRotationProvider: {
    GitLab: "GitLab",
  },
  GitTokenRotationState: {
    Configured: "Configured",
    Rotating: "Rotating",
    Completed: "Completed",
    Failed: "Failed",
    ManualIntervention: "ManualIntervention",
  },
}));

vi.mock("../../components/domain-pickers", () => ({
  WorkspacePicker: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string | null;
    onChange: (id: string | null) => void;
    placeholder: string;
  }) => (
    <div data-testid="git-sync-workspace-picker">
      <span>{placeholder}</span>
      <button type="button" onClick={() => onChange("ws-2")}>
        pick ws-2
      </button>
      {value ? (
        <button type="button" onClick={() => onChange(null)}>
          clear mocked workspace
        </button>
      ) : null}
    </div>
  ),
}));

// Import after mocks

import { ProfilesTab } from "./profiles-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

// Helpers

function makeWorkspace(overrides: {
  id: string;
  name?: string | null;
  gitSyncEnabled?: boolean;
  gitSyncLastStatus?: string | null;
  gitSyncTokenRotationProvider?: string | null;
  gitSyncTokenRotationEnabled?: boolean | null;
  gitSyncTokenRotationState?: string | null;
}) {
  return {
    name: null,
    gitSyncEnabled: false,
    gitSyncProfileId: null,
    gitSyncLastStatus: null,
    gitSyncTokenRotationProvider: null,
    gitSyncTokenRotationEnabled: null,
    gitSyncTokenRotationState: null,
    ...overrides,
  };
}

// Tests

describe("ProfilesTab", () => {
  beforeEach(() => {
    mockQueryData = {};
    mockQueryError = undefined;
    mockQueryLoading = false;
    mutateQueryMock.mockClear();
    mutationMock.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  test("shows a scrubbed diagnosis and reloads the failed workspace query", async () => {
    mockQueryError = new Error("raw GraphQL response");
    renderWithProvider(<ProfilesTab />);

    expect(screen.getByText("Configuration needs attention")).toBeTruthy();
    expect(screen.queryByText("raw GraphQL response")).toBeNull();
    expect(screen.queryByText(/Diagnosis: GITSYNC-QUERY_FAILED-/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.common.technical-details",
      }),
    );
    expect(
      await screen.findByText(/Diagnosis: GITSYNC-QUERY_FAILED-/),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Reload server values" }),
    );
    await waitFor(() => expect(mutateQueryMock).toHaveBeenCalledOnce());
  });

  test("toggle back to Show All reveals disabled workspaces", () => {
    mockQueryData = {
      admin: {
        adminWorkspaces: [
          makeWorkspace({
            id: "ws-1",
            name: "Enabled WS",
            gitSyncEnabled: true,
          }),
          makeWorkspace({
            id: "ws-2",
            name: "Disabled WS",
            gitSyncEnabled: false,
          }),
        ],
      },
    };
    renderWithProvider(<ProfilesTab />);
    const status = screen.getByRole("combobox", { name: "Status" });
    fireEvent.click(status);
    fireEvent.click(screen.getByRole("option", { name: "Show Enabled" }));
    expect(screen.queryByText("Disabled WS")).toBeNull();
    // Click again to return to the full profile overview.
    fireEvent.click(status);
    fireEvent.click(screen.getByRole("option", { name: "Show All" }));
    expect(screen.getByText("Disabled WS")).toBeTruthy();
  });

  test("workspace picker narrows visible sync profiles without changing the adminWorkspaces source", () => {
    mockQueryData = {
      admin: {
        adminWorkspaces: [
          makeWorkspace({ id: "ws-1", name: "Alpha", gitSyncEnabled: true }),
          makeWorkspace({ id: "ws-2", name: "Beta", gitSyncEnabled: true }),
        ],
      },
    };
    renderWithProvider(<ProfilesTab />);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();

    fireEvent.click(screen.getByText("pick ws-2"));

    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByTestId("git-sync-profile-detail")).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
  });

  test("filters preserve the open draft; selection and close require explicit discard", async () => {
    mockQueryData = {
      admin: {
        adminWorkspaces: [
          makeWorkspace({ id: "ws-1", name: "Alpha" }),
          makeWorkspace({ id: "ws-2", name: "Beta" }),
        ],
      },
    };
    renderWithProvider(<ProfilesTab />);
    fireEvent.click(
      screen.getByRole("button", { name: "Alpha: Create profile" }),
    );
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://example.invalid/draft.git" },
    });
    fireEvent.click(screen.getByText("pick ws-2"));
    const detail = screen.getByTestId("git-sync-profile-detail");
    expect(within(detail).getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(
      (screen.getByLabelText("Repository URL") as HTMLInputElement).value,
    ).toBe("https://example.invalid/draft.git");
    fireEvent.click(
      screen.getByRole("button", { name: "Beta: Create profile" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(detail).getByRole("heading", { name: "Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close profile" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("git-sync-profile-detail")).toBeNull(),
    );
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
