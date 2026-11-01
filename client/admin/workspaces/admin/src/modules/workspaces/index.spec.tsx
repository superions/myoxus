import type { ReactElement } from "react";
import type { ReactNode } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

const mutationTriggers = vi.hoisted(() => ({
  userOwned: vi.fn(async () => ({ createWorkspace: { id: "user-owned-1" } })),
  shared: vi.fn(async () => ({
    createWorkspaceInOrganizationUnit: { id: "shared-1" },
  })),
}));

// Mock useQuery — called by useWorkspaceList (two queries: adminWorkspaces + adminWorkspacesCount)
// and by useServerConfig (data.serverConfig) via the toolbar.
vi.mock("@myoxus/admin/use-query", () => ({
  useQuery: (options?: { variables?: { filter?: { keyword?: string } } }) => ({
    data: {
      admin: {
        adminWorkspaces:
          options?.variables?.filter?.keyword === "no-match"
            ? []
            : [
                {
                  id: "01234567-89ab-cdef-0123-456789abcdef",
                  public: false,
                  createdAt: "2026-01-01T00:00:00Z",
                  name: "Test Workspace",
                  avatarKey: null,
                  enableAi: false,
                  enableSharing: false,
                  enableUrlPreview: false,
                  enableDocEmbedding: false,
                  features: [],
                  workspaceType: "UserOwned",
                  isPersonal: false,
                  ownerPrincipalType: "user",
                  ownerPrincipalId: "owner-1",
                  ownerPrincipalName: null,
                  memberCount: 1,
                  publicPageCount: 0,
                  snapshotCount: 2,
                  snapshotSize: 1024,
                  blobCount: 1,
                  blobSize: 512,
                  owner: {
                    id: "owner-1",
                    name: "Owner",
                    email: "owner@example.com",
                    avatarUrl: null,
                  },
                },
              ],
        adminWorkspace: {
          id: "01234567-89ab-cdef-0123-456789abcdef",
          name: "Test Workspace",
          public: false,
          createdAt: "2026-01-01T00:00:00Z",
          enableAi: false,
          enableSharing: false,
          enableUrlPreview: false,
          enableDocEmbedding: false,
          features: [],
          memberCount: 1,
          publicPageCount: 0,
          snapshotCount: 2,
          snapshotSize: 1024,
          blobCount: 1,
          blobSize: 512,
          members: [],
          sharedLinks: [],
          owner: { id: "owner-1", email: "owner@example.com" },
        },
        adminWorkspacesCount: 1,
        organizationUnits: [
          {
            id: "unit-1",
            name: "Engineering",
            unitTypeId: "type-owner",
          },
          {
            id: "unit-root",
            name: "Myoxus Organisation",
            unitTypeId: "type-root",
          },
        ],
        organizationUnitTypes: [
          {
            id: "type-owner",
            canOwnWorkspaces: true,
          },
          {
            id: "type-root",
            canOwnWorkspaces: false,
          },
        ],
        serverInfo: {
          version: "0.1.0",
          baseUrl: "http://localhost:3001",
          name: "Myoxus",
          features: [],
          type: "Standalone",
          initialized: true,
          i18n: {
            defaultLocale: "de",
            availableLocales: ["en", "de"],
          },
          availableUserFeatures: [],
          availableWorkspaceFeatures: [],
          credentialsRequirement: {
            password: { minLength: 8, maxLength: 32 },
          },
          availableUpgrade: null,
        },
      },
    },
    error: null,
    isLoading: false,
    isValidating: false,
  }),
}));

vi.mock("@myoxus/admin/use-mutation", () => ({
  useMutation: ({ mutation }: { mutation?: { id?: string } }) => ({
    trigger: mutation?.id?.includes("createWorkspaceInOrganizationUnit")
      ? mutationTriggers.shared
      : mutationTriggers.userOwned,
    isMutating: false,
  }),
  useMutateQueryResource: () => vi.fn(),
}));

vi.mock("../panel/context", () => ({
  usePanelContext: () => ({
    setPanelContent: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    isOpen: false,
    hasDirtyChanges: false,
    setHasDirtyChanges: vi.fn(),
  }),
  useRightPanel: () => ({
    setPanelContent: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    isOpen: false,
    hasDirtyChanges: false,
    setHasDirtyChanges: vi.fn(),
  }),
  useLeftPanel: () => ({
    togglePanel: vi.fn(),
    isOpen: true,
  }),
}));

vi.mock("../header", () => ({
  Header: ({ title, endFix }: { title: string; endFix?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {endFix}
    </div>
  ),
  RightPanelHeader: ({ title }: { title: string }) => (
    <div data-testid="workspace-panel-header">{title}</div>
  ),
}));

import { WorkspacePage } from "./index";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("WorkspacePage", () => {
  afterEach(() => {
    cleanup();
    mutationTriggers.userOwned.mockClear();
    mutationTriggers.shared.mockClear();
  });

  test("chooses user-owned or shared before creating a workspace", async () => {
    renderWithFacade(<WorkspacePage />);

    fireEvent.click(screen.getByTestId("workspace-create-button"));
    expect(await screen.findByTestId("workspace-create-dialog")).not.toBeNull();
    expect(
      screen
        .getByTestId("workspace-create-type-user-owned")
        .getAttribute("data-active"),
    ).toBe("true");
    expect(screen.queryByTestId("workspace-create-owner-unit")).toBeNull();

    fireEvent.click(screen.getByTestId("workspace-create-type-shared"));
    expect(
      await screen.findByTestId("workspace-create-owner-unit"),
    ).not.toBeNull();
    expect(
      (screen.getByTestId("workspace-create-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("workspace-create-owner-unit"));
    const engineeringOption = await screen.findByText("Engineering");
    expect(screen.queryByText("Myoxus Organisation")).toBeNull();
    fireEvent.click(engineeringOption);
    const submit = screen.getByTestId(
      "workspace-create-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(mutationTriggers.shared).toHaveBeenCalledWith({
        input: { unitId: "unit-1" },
      });
    });
  });

  test("creates the default user-owned workspace without a second personal marker choice", async () => {
    renderWithFacade(<WorkspacePage />);

    fireEvent.click(screen.getByTestId("workspace-create-button"));
    fireEvent.click(await screen.findByTestId("workspace-create-submit"));

    await waitFor(() => {
      expect(mutationTriggers.userOwned).toHaveBeenCalledWith({});
    });
    expect(screen.queryByText("Personal")).toBeNull();
  });

  test("keeps a filtered-out draft open and confirms before closing it", async () => {
    renderWithFacade(<WorkspacePage />);
    const detail = await screen.findByTestId("workspace-detail-content");
    const name = (await within(detail).findByRole("textbox", {
      name: "Name",
    })) as HTMLInputElement;
    const close = within(detail).getByRole("button", {
      name: /^(Close|Schließen)$/,
    });
    fireEvent.change(name, { target: { value: "Unsaved workspace name" } });
    fireEvent.change(screen.getByTestId("workspace-search-input"), {
      target: { value: "no-match" },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("workspace-soft-list")).toBeNull(),
    );
    expect(name.isConnected).toBe(true);
    expect(name.value).toBe("Unsaved workspace name");
    fireEvent.click(close);
    const confirmation = await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("admin-confirm-modal-cancel"));
    await waitFor(() => expect(confirmation.isConnected).toBe(false));
    expect(name.isConnected).toBe(true);
    expect(name.value).toBe("Unsaved workspace name");
    expect(close.isConnected).toBe(true);
    fireEvent.click(close);
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    await waitFor(() => expect(detail.isConnected).toBe(false));
  });
});
