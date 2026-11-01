/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { selectMantineOption } from "../../../__tests__/test-utils";

const WS_ID = "ws-drawer-001";
const WORKSPACE = {
  id: WS_ID,
  public: false,
  createdAt: "2026-01-01T00:00:00Z",
  name: "Drawer Workspace",
  avatarKey: null,
  workspaceType: "Shared",
  enableAi: false,
  enableSharing: false,
  enableUrlPreview: false,
  enableDocEmbedding: false,
  features: [],
  memberCount: 1,
  publicPageCount: 0,
  snapshotCount: 2,
  snapshotSize: 1024,
  blobCount: 3,
  blobSize: 2048,
  storageQuotaBytes: null,
  storageQuotaUsed: 3072,
  owner: {
    id: "owner-1",
    name: "Owner",
    email: "owner@example.test",
    avatarUrl: null,
  },
  sharedLinks: [],
  members: [],
};
const FONT_FAMILIES = [
  {
    slug: "inter",
    displayName: "Inter",
    cssFamily: "Inter",
    genericClass: "sans",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: [
      {
        usage: "web",
        format: "woff2",
        style: "normal",
        weightMin: 100,
        weightMax: 900,
        weightDefault: 400,
        assetKey: "inter.woff2",
        sha256: "web",
        mime: "font/woff2",
        unicodeRanges: [],
        subsetTags: [],
      },
      {
        usage: "pdf",
        format: "variable_ttf",
        style: "normal",
        weightMin: 100,
        weightMax: 900,
        weightDefault: 400,
        assetKey: "inter.ttf",
        sha256: "pdf",
        mime: "font/ttf",
        unicodeRanges: [],
        subsetTags: [],
      },
    ],
  },
];
const THEME = {
  slug: "stuttgart",
  name: "Stuttgart",
  origin: "system",
  locked: true,
  isDefault: true,
  colorSchemaSlug: "stuttgart",
  typographySlug: "stuttgart",
  colors: {
    light: {
      paper: "#ffffff",
      "paper-deep": "#f6f1e8",
      rule: "#ddd5c7",
      ink: "#111111",
      "ink-soft": "#333333",
      "ink-mute": "#777777",
      "accent-primary": "#7d2841",
      "link-default": "#7d2841",
      "accent-secondary": "#2b5d6e",
    },
    dark: {
      paper: "#111111",
      "paper-deep": "#1f1f1f",
      rule: "#333333",
      ink: "#ffffff",
      "ink-soft": "#dddddd",
      "ink-mute": "#999999",
      "accent-primary": "#d88aa0",
      "link-default": "#d88aa0",
      "accent-secondary": "#7db4c4",
    },
  },
  typographyStyles: [
    {
      styleKey: "heading.h1",
      fontFamilySlug: "inter",
      fontFamily: "Inter",
      cssFamily: "Inter",
      fontWeight: 700,
      fontStyle: "normal",
      sizePx: 34,
      lineHeight: 1.2,
      letterSpacingEm: -0.01,
      textTransform: null,
      decoration: null,
      hoverDecoration: null,
      fontFeatures: {},
      fontVariations: {},
      pdfRole: "heading",
    },
    {
      styleKey: "body.default",
      fontFamilySlug: "inter",
      fontFamily: "Inter",
      cssFamily: "Inter",
      fontWeight: 400,
      fontStyle: "normal",
      sizePx: 15,
      lineHeight: 1.5,
      letterSpacingEm: 0,
      textTransform: null,
      decoration: null,
      hoverDecoration: null,
      fontFeatures: {},
      fontVariations: {},
      pdfRole: "body",
    },
  ],
};

const queryCalls: Array<{ op?: string; variables?: unknown }> = [];
const mutationCalls: Array<{ op?: string; input?: unknown }> = [];
const effectiveProfileCalls: Array<string | null | undefined> = [];
let setTypographyStylesMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryCalls.length = 0;
  mutationCalls.length = 0;
  effectiveProfileCalls.length = 0;
  setTypographyStylesMock = vi.fn(async () => ({
    scope: "workspace",
    workspaceId: WS_ID,
    themeMode: "system",
    theme: THEME,
  }));
  vi.resetModules();

  vi.doMock("../../../use-query", () => ({
    useQuery: (request: { query?: { op?: string }; variables?: any }) => {
      const op = request?.query?.op;
      queryCalls.push({ op, variables: request?.variables });
      if (op === "adminWorkspace") {
        return {
          data: { admin: { adminWorkspace: WORKSPACE } },
          isLoading: false,
          error: null,
        };
      }
      if (op === "adminWorkspaceOrganizationUnitWorkspaces") {
        return {
          data: {
            admin: {
              workspaceOrganizationUnitWorkspaces: [
                {
                  unitId: "ou-alpha",
                  unitName: "Alpha Unit",
                  unitSlug: "alpha",
                  workspaceId: WS_ID,
                  workspaceName: WORKSPACE.name,
                  ownerUserId: "owner-1",
                  ownerEmail: "owner@example.test",
                  relationship: "LINKED",
                  storageUsedBytes: 3072,
                  effectiveQuotaBytes: null,
                  createdAt: "2026-01-02T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
                {
                  unitId: "ou-owner",
                  unitName: "Owner Unit",
                  unitSlug: "owner",
                  workspaceId: WS_ID,
                  workspaceName: WORKSPACE.name,
                  ownerUserId: "owner-1",
                  ownerEmail: "owner@example.test",
                  relationship: "Owner",
                  storageUsedBytes: 2048,
                  effectiveQuotaBytes: null,
                  createdAt: "2026-01-02T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                },
              ],
            },
          },
          isLoading: false,
          error: null,
        };
      }
      if (op === "adminAuditLog") {
        return {
          data: {
            admin: {
              adminAuditLog: [
                {
                  id: "audit-1",
                  eventKey: "workspace.update",
                  category: "workspace",
                  target: {
                    id: WS_ID,
                    type: "workspace",
                    label: WORKSPACE.name,
                  },
                  actor: { id: "admin-1", label: "Admin" },
                  createdAt: "2026-01-02T00:00:00Z",
                  oldValue: null,
                  newValue: null,
                  metadata: null,
                  targetUnitId: null,
                },
              ],
              adminAuditLogCount: 1,
            },
          },
          isLoading: false,
          error: null,
        };
      }
      if (op === "adminWorkspaceQuotaDetails") {
        return {
          data: {
            admin: {
              adminWorkspaceQuotaDetails: {
                source: "Unlimited",
                workspaceOverrideBytes: null,
                configDefaultMb: 0,
                effectiveBytes: 0,
                usedBytes: 3072,
              },
            },
          },
          isLoading: false,
          error: null,
        };
      }
      return { data: {}, isLoading: false, error: null };
    },
  }));

  vi.doMock("../../../use-mutation", () => ({
    useMutation: (request: { mutation?: { op?: string } }) => ({
      trigger: vi.fn(async (input?: unknown) => {
        mutationCalls.push({ op: request?.mutation?.op, input });
      }),
      isMutating: false,
    }),
    useMutateQueryResource: () => vi.fn(),
  }));

  vi.doMock("../../panel/context", () => ({
    useRightPanel: () => ({ setHasDirtyChanges: vi.fn() }),
  }));

  vi.doMock("../../header", () => ({
    RightPanelHeader: ({ title }: { title: string }) => (
      <div data-testid="drawer-header">{title}</div>
    ),
  }));

  vi.doMock("../../common", () => ({
    useServerConfig: () => ({ availableWorkspaceFeatures: [] }),
  }));

  vi.doMock("./workspace-panel-members", () => ({
    WorkspaceMembersSection: ({ workspaceId }: { workspaceId: string }) => (
      <div data-testid="members-section">members:{workspaceId}</div>
    ),
  }));

  vi.doMock("./workspace-quota-inspector", () => ({
    WorkspaceQuotaInspector: ({ workspaceId }: { workspaceId: string }) => (
      <div data-testid="quota-inspector">quota:{workspaceId}</div>
    ),
  }));

  vi.doMock("./workspace-template-drawer", () => ({
    WorkspaceTemplateDrawer: () => null,
  }));

  vi.doMock("../../theme/theme-api", () => ({
    useThemeCatalogQuery: () => ({
      catalog: { themes: [THEME], fontFamilies: FONT_FAMILIES },
      themes: [THEME],
      fontFamilies: FONT_FAMILIES,
      isLoading: false,
      mutate: vi.fn().mockResolvedValue(undefined),
    }),
    useEffectiveThemeProfileQuery: (workspaceId?: string | null) => {
      effectiveProfileCalls.push(workspaceId);
      return {
        isLoading: false,
        mutate: vi.fn().mockResolvedValue(undefined),
        profile: {
          scope: workspaceId ? "workspace" : "global",
          workspaceId: workspaceId ?? null,
          themeMode: "system",
          theme: THEME,
          assets: [],
        },
      };
    },
    useSetThemeProfileMutation: () => ({
      setThemeProfile: vi.fn(),
      isMutating: false,
    }),
    useSetColorSchemaValuesMutation: () => ({
      setColorSchemaValues: vi.fn(),
      isMutating: false,
    }),
    useSetTypographyStylesMutation: () => ({
      setTypographyStyles: setTypographyStylesMock,
      isMutating: false,
    }),
    useResetWorkspaceThemeProfileMutation: () => ({
      resetWorkspaceThemeProfile: vi.fn(),
      isMutating: false,
    }),
  }));

  vi.doMock("@myoxus/i18n", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      useI18n: () => ({
        "com.myoxus.peek-view-controls.close": () => "Close",
        t: (key: string, opts?: Record<string, unknown>) => {
          if (key === "admin.workspaces.drawer.tab.basics")
            return "Master data";
          if (key === "admin.workspaces.drawer.tab.members") return "Members";
          if (key === "admin.workspaces.drawer.tab.branding") return "Branding";
          if (key === "admin.workspaces.drawer.tab.ou-link")
            return "Organization";
          if (key === "admin.workspaces.drawer.tab.quota") return "Quota";
          if (key === "admin.workspaces.drawer.tab.audit") return "Audit";
          if (key === "admin.workspaces.drawer.ou-link.relationship-linked")
            return "Linked";
          if (key === "admin.workspaces.drawer.ou-link.relationship-managed")
            return "Managed";
          if (key === "admin.workspaces.drawer.ou-link.relationship-owner")
            return "Owner";
          if (key === "admin.workspaces.drawer.audit.system-actor")
            return "System";
          if (key === "admin.audit-log.event-key.workspace__update")
            return "Workspace changed";
          if (opts) return `${key}:${JSON.stringify(opts)}`;
          return key;
        },
      }),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function renderPanel(initialTab?: string) {
  const { WorkspacePanel } = await import("./workspace-panel");
  return renderWithFacade(
    <WorkspacePanel
      workspaceId={WS_ID}
      onClose={vi.fn()}
      initialTab={initialTab as never}
    />,
  );
}

describe("WorkspacePanel drawer tabs", () => {
  test("renders the drawer navigation and non-branding tab panels in one session", async () => {
    await renderPanel();
    expect(screen.getByTestId("workspace-drawer-tab-basics")).not.toBeNull();
    expect(screen.getByTestId("workspace-drawer-panel-basics")).not.toBeNull();
    expect(screen.getByDisplayValue("Drawer Workspace")).not.toBeNull();
    expect(screen.getByText("owner@example.test")).not.toBeNull();

    fireEvent.click(screen.getByTestId("workspace-drawer-tab-members"));
    await waitFor(() => {
      expect(screen.getByTestId("members-section").textContent).toContain(
        WS_ID,
      );
    });

    fireEvent.click(screen.getByTestId("workspace-drawer-tab-ou-link"));
    await waitFor(() => {
      expect(screen.getByText("Alpha Unit")).not.toBeNull();
      expect(screen.getByText("alpha")).not.toBeNull();
      expect(screen.getByText("Owner Unit")).not.toBeNull();
      expect(screen.getByText("owner")).not.toBeNull();
      expect(screen.getAllByText("Linked").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Owner").length).toBeGreaterThanOrEqual(1);
      expect(queryCalls).toContainEqual({
        op: "adminWorkspaceOrganizationUnitWorkspaces",
        variables: { workspaceId: WS_ID },
      });
    });

    fireEvent.click(screen.getByTestId("workspace-drawer-tab-quota"));
    await waitFor(() => {
      expect(screen.getByTestId("quota-inspector").textContent).toContain(
        WS_ID,
      );
    });

    fireEvent.click(screen.getByTestId("workspace-drawer-tab-audit"));
    await waitFor(() => {
      expect(screen.getByText("Workspace changed")).not.toBeNull();
      expect(screen.queryByText("workspace.update")).toBeNull();
      expect(queryCalls).toContainEqual({
        op: "adminAuditLog",
        variables: {
          filter: { targetType: "workspace", targetId: WS_ID },
          limit: 12,
          offset: 0,
        },
      });
    });
  }, 15_000);

  test("changes an existing OU relationship through the assign mutation", async () => {
    await renderPanel("ou-link");

    const relationshipSelect = await screen.findByTestId(
      "workspace-ou-link-relationship-ou-alpha",
    );
    selectMantineOption(relationshipSelect, "Owner");

    await waitFor(() => {
      expect(mutationCalls).toContainEqual({
        op: "adminAssignOrganizationUnitWorkspace",
        input: {
          input: {
            unitId: "ou-alpha",
            workspaceId: WS_ID,
            relationship: "Owner",
          },
        },
      });
    });
  }, 15_000);

  test("renders the branding tab and saves workspace typography variants through scoped Theme DB mutations", async () => {
    await renderPanel("branding");
    await waitFor(() => {
      expect(screen.getByTestId("workspace-branding-tab")).not.toBeNull();
      expect(
        screen.getByTestId("workspace-drawer-panel-branding"),
      ).not.toBeNull();
      expect(screen.getAllByText("Stuttgart").length).toBeGreaterThan(0);
      expect(screen.getByTestId("workspace-typography-editor")).not.toBeNull();
      expect(effectiveProfileCalls).toContain(WS_ID);
      expect(effectiveProfileCalls).toContain(null);
    });

    fireEvent.change(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByTestId("typography-save"));

    await waitFor(() => {
      expect(setTypographyStylesMock).toHaveBeenCalledWith({
        workspaceId: WS_ID,
        styles: [
          expect.objectContaining({
            styleKey: "heading.h1",
            fontFamilySlug: "inter",
            sizePx: 42,
          }),
        ],
      });
    });

    setTypographyStylesMock.mockClear();
    const stylesTab = screen.getByTestId("typography-tab-styles");
    fireEvent.mouseDown(stylesTab, { button: 0, ctrlKey: false });
    fireEvent.click(stylesTab);
    await waitFor(() => {
      expect(
        screen.getByTestId("typography-style-editor-heading.h1"),
      ).not.toBeNull();
    });
    fireEvent.change(screen.getByTestId("heading.h1-features"), {
      target: { value: '{ "liga": false }' },
    });
    fireEvent.click(screen.getByTestId("typography-styles-save"));

    await waitFor(() => {
      expect(setTypographyStylesMock).toHaveBeenCalledWith({
        workspaceId: WS_ID,
        styles: [
          expect.objectContaining({
            styleKey: "heading.h1",
            fontFamilySlug: "inter",
            pdfRole: "heading",
            fontFeatures: { liga: false },
          }),
        ],
      });
    });
  }, 15_000);
});
