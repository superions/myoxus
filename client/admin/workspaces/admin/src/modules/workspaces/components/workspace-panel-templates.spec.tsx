import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspacePanel } from "./workspace-panel";

const queryState = vi.hoisted(() => ({
  memberCount: 0,
  templateInstances: [] as unknown[],
  catalogEntries: [] as unknown[],
  calls: [] as Array<{ queryId: string; variables: unknown }>,
}));

vi.mock("../../../use-query", () => ({
  useQuery: (opts: { query: { id: string }; variables: unknown }) => {
    queryState.calls.push({
      queryId: opts.query.id,
      variables: opts.variables,
    });

    if (opts.query.id === "workspaceTemplateInstancesQuery") {
      return {
        data: {
          admin: {
            workspaceTemplateInstances: queryState.templateInstances,
          },
        },
        error: null,
        isLoading: false,
        isValidating: false,
      };
    }

    if (opts.query.id === "templateCatalogQuery") {
      return {
        data: {
          admin: {
            templateCatalog: queryState.catalogEntries,
            templateCatalogCount: queryState.catalogEntries.length,
          },
        },
        error: null,
        isLoading: false,
        isValidating: false,
      };
    }

    return {
      data: {
        admin: {
          adminWorkspace: {
            id: "ws-test",
            public: false,
            createdAt: "2026-01-01T00:00:00Z",
            name: "Test Workspace",
            avatarKey: null,
            enableAi: false,
            enableSharing: false,
            enableUrlPreview: false,
            enableDocEmbedding: false,
            features: [],
            memberCount: queryState.memberCount,
            publicPageCount: 0,
            snapshotCount: 1,
            snapshotSize: 512,
            blobCount: 0,
            blobSize: 0,
            storageQuotaBytes: null,
            storageQuotaUsed: 0,
            owner: {
              id: "u-1",
              name: "Owner",
              email: "o@test.com",
              avatarUrl: null,
            },
            sharedLinks: [],
            members: [],
          },
        },
      },
      error: null,
      isLoading: false,
      isValidating: false,
    };
  },
}));

vi.mock("../../../use-mutation", () => ({
  useMutation: () => ({ trigger: vi.fn(), isMutating: false }),
  useMutateQueryResource: () => vi.fn(),
}));

vi.mock("../../panel/context", () => ({
  useRightPanel: () => ({
    setHasDirtyChanges: vi.fn(),
    hasDirtyChanges: false,
  }),
}));

vi.mock("../../header", () => ({
  RightPanelHeader: ({ title }: { title: string }) => (
    <div data-testid="panel-header">{title}</div>
  ),
}));

vi.mock("../../common", () => ({
  useServerConfig: () => ({
    availableWorkspaceFeatures: [],
  }),
}));

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function setupMocks(
  memberCount: number,
  templateInstances: unknown[] = [],
  catalogEntries: unknown[] = [],
) {
  queryState.memberCount = memberCount;
  queryState.templateInstances = templateInstances;
  queryState.catalogEntries = catalogEntries;
  queryState.calls = [];
}

describe("WorkspacePanel — Templates section with GraphQL data", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows error message for instances in error state", async () => {
    setupMocks(
      2,
      [
        {
          id: "inst-err",
          templateId: "tpl-err",
          revisionId: "rev-err-abcdef99",
          state: "ERROR",
          lastSyncedAt: null,
          lastErrorMessage: "Bundle extraction failed",
        },
      ],
      [
        {
          id: "tpl-err",
          slug: "broken",
          title: "Broken Template",
          status: "ACTIVE",
        },
      ],
    );
    renderWithFacade(
      <WorkspacePanel workspaceId="ws-test" onClose={vi.fn()} />,
    );

    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("Bundle extraction failed")).toBeTruthy();
  });

  test("hides Templates section for personal workspace (memberCount = 1)", async () => {
    setupMocks(1);
    renderWithFacade(
      <WorkspacePanel workspaceId="ws-test" onClose={vi.fn()} />,
    );

    expect(screen.queryByText("Manage Templates")).toBeNull();
  });
});
