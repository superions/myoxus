/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { notify } from "@myoxus/ui-facade";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
import {
  openMantineSelectListbox,
  selectMantineOption,
} from "../../__tests__/test-utils";
const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  I18n: new Proxy(
    {},
    { get: (_target, key) => () => en[String(key)] ?? String(key) },
  ),
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>): string => {
      let text = en[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        });
      }
      return text;
    },
    language: "en",
  }),
}));

vi.mock("../../components/domain-pickers", () => ({
  OuPicker: ({
    value,
    onChange,
    "data-testid": dataTestId,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
    "data-testid"?: string;
  }) => (
    <input
      data-testid={dataTestId}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value || null)}
    />
  ),
  UserPicker: ({
    value,
    onChange,
    excludeUnitId,
    "data-testid": dataTestId,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
    excludeUnitId?: string;
    "data-testid"?: string;
  }) => (
    <input
      data-testid={dataTestId}
      data-exclude-unit-id={excludeUnitId}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value || null)}
    />
  ),
  WorkspacePicker: ({
    value,
    onChange,
    excludeUnitId,
    "data-testid": dataTestId,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
    excludeUnitId?: string;
    "data-testid"?: string;
  }) => (
    <input
      data-testid={dataTestId}
      data-exclude-unit-id={excludeUnitId}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value || null)}
    />
  ),
}));

vi.mock("../../components/shared/admin-confirm-modal", () => ({
  AdminConfirmModal: ({
    open,
    onConfirm,
    title,
    onCancel,
  }: {
    open: boolean;
    onConfirm: () => void;
    title: string;
    onCancel?: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <button
          type="button"
          data-testid="admin-confirm-modal-confirm"
          onClick={onConfirm}
        >
          {title}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock("../../components/shared/admin-type-confirm-modal", () => ({
  AdminTypeConfirmModal: ({
    open,
    targetText,
    onConfirm,
  }: {
    open: boolean;
    targetText: string;
    onConfirm: () => void;
  }) => {
    const [value, setValue] = React.useState("");
    return open ? (
      <div role="dialog">
        <input
          data-testid="unit-delete-confirm-input"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <button
          type="button"
          data-testid="unit-delete-confirm-button"
          disabled={value !== targetText}
          onClick={onConfirm}
        >
          Delete
        </button>
      </div>
    ) : null;
  },
}));

const root = {
  id: "u-root",
  organizationId: "o-1",
  parentUnitId: null,
  unitTypeId: "t-1",
  name: "Marketing",
  slug: "marketing",
  description: null,
  status: "Active",
  maxMembers: 25,
  metadata: {},
  childUnitCount: 1,
  memberCount: 1,
  workspaceCount: 1,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const child = {
  ...root,
  id: "u-child",
  parentUnitId: "u-root",
  name: "Brand Team",
  slug: "brand",
};
const disabled = {
  ...root,
  id: "u-disabled",
  name: "Old Squad",
  slug: "old-squad",
  status: "Disabled",
};

const type = {
  id: "t-1",
  key: "team",
  label: "Team",
  isActive: true,
  isPreset: true,
};
const kvkType = {
  ...type,
  id: "t-kvk",
  key: "kvk.fachbereich",
  label: "Fachbereich",
};
const kvgType = {
  ...type,
  id: "t-kvg",
  key: "kvg.amt",
  label: "Amt",
};
const customType = {
  ...type,
  id: "t-custom",
  key: "custom-board",
  label: "Custom Board",
  isPreset: false,
};

const apiMocks = vi.hoisted(() => ({
  mutate: vi.fn(async () => undefined),
  trigger: vi.fn(async () => undefined),
  auditUnitIds: [] as string[],
  unitQueryStatuses: [] as Array<string | null | undefined>,
  organizationMetadata: {} as Record<string, unknown>,
  deletionPreview: {
    id: "u-root",
    name: "Marketing",
    status: "Active",
    updatedAt: "2026-01-01T00:00:00Z",
    deletable: false,
    blockers: [{ code: "MEMBERS", count: 1 }],
  } as {
    id: string;
    name: string;
    status: string;
    updatedAt: string;
    deletable: boolean;
    blockers: Array<{ code: string; count: number }>;
  },
}));

const member = {
  unitId: "u-root",
  userId: "user-member",
  userEmail: "alina@example.com",
  userName: "Alina Example",
  userAvatarUrl: null,
  role: "Member",
  source: "MANUAL",
  metadata: {},
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const workspaceLink = {
  unitId: "u-root",
  workspaceId: "ws-reporting",
  workspaceName: "Reporting Workspace",
  ownerUserId: "owner-1",
  ownerEmail: "owner@example.com",
  relationship: "Managed",
  storageUsedBytes: 536870912,
  effectiveQuotaBytes: 2147483648,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const auditEntry = {
  id: "audit-1",
  eventKey: "organization.unit.upsert",
  category: "organization",
  target: { id: "u-root", type: "organization_unit", label: "Marketing" },
  actor: { id: "admin-1", label: "Admin User" },
  createdAt: "2026-01-02T00:00:00Z",
  oldValue: { name: "Old Marketing" },
  newValue: { name: "Marketing" },
  metadata: { target_unit_id: "u-root" },
  targetUnitId: "u-root",
};

vi.mock("./api", () => {
  const empty = { isLoading: false, mutate: apiMocks.mutate };
  const mut = { trigger: apiMocks.trigger, isMutating: false };
  return {
    useOrganizationQuery: () => ({
      ...empty,
      organization: {
        id: "o-1",
        key: "myoxus",
        name: "Myoxus",
        slug: "myoxus",
        metadata: apiMocks.organizationMetadata,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }),
    useOrganizationUnitsQuery: (status?: string | null) => {
      apiMocks.unitQueryStatuses.push(status);
      return {
        ...empty,
        units:
          status === null
            ? [root, child, disabled]
            : status === "Disabled"
              ? [disabled]
              : status === "Archived"
                ? []
                : [root, child],
      };
    },
    useOrganizationUnitTypesQuery: () => ({
      ...empty,
      types: [type, kvkType, kvgType, customType],
    }),
    useOrganizationUnitMembersQuery: (unitId: string) => ({
      ...empty,
      members: unitId === "u-root" ? [member] : [],
    }),
    useOrganizationUnitAuditLogQuery: (unitId: string) => {
      apiMocks.auditUnitIds.push(unitId);
      return {
        ...empty,
        entries: unitId === "u-root" ? [auditEntry] : [],
        totalCount: unitId === "u-root" ? 1 : 0,
      };
    },
    useOrganizationUnitWorkspacesQuery: () => ({
      ...empty,
      links: [workspaceLink],
    }),
    useOrganizationUnitDeletionPreviewQuery: (
      _unitId: string,
      enabled: boolean,
    ) => ({
      ...empty,
      preview: enabled ? apiMocks.deletionPreview : undefined,
    }),
    useUpsertOrganizationUnitMutation: () => mut,
    useDeactivateOrganizationUnitMutation: () => mut,
    useSetOrganizationUnitParentMutation: () => mut,
    useAssignOrganizationManagerMutation: () => mut,
    useUnassignOrganizationManagerMutation: () => mut,
    useAssignOrganizationUnitWorkspaceMutation: () => mut,
    useUnassignOrganizationUnitWorkspaceMutation: () => mut,
    useDeleteOrganizationUnitPermanentlyMutation: () => mut,
  };
});

import { UnitsTab } from "./units-tab";

function renderWithProvider(node: React.ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

async function selectFacadeOption(
  target: HTMLElement | string,
  option: string | RegExp,
): Promise<void> {
  const combobox =
    typeof target === "string" ? await screen.findByTestId(target) : target;
  selectMantineOption(combobox, option);
}

afterEach(() => {
  cleanup();
  apiMocks.mutate.mockClear();
  apiMocks.trigger.mockClear();
  apiMocks.auditUnitIds.length = 0;
  apiMocks.unitQueryStatuses.length = 0;
  apiMocks.organizationMetadata = {};
  apiMocks.deletionPreview = {
    id: "u-root",
    name: "Marketing",
    status: "Active",
    updatedAt: "2026-01-01T00:00:00Z",
    deletable: false,
    blockers: [{ code: "MEMBERS", count: 1 }],
  };
});

function triggerArgAt(index: number) {
  return (apiMocks.trigger.mock.calls as unknown as unknown[][])[index]?.[0];
}

function mutateCalls() {
  return apiMocks.mutate.mock.calls as unknown as unknown[][];
}

describe("UnitsTab", () => {
  test("explicit status filter loads inactive units", async () => {
    renderWithProvider(<UnitsTab />);
    await selectFacadeOption("organization-unit-status-filter", "Disabled");
    expect(screen.getByTestId("organization-unit-row-u-disabled")).toBeTruthy();
    expect(screen.queryByTestId("organization-unit-row-u-root")).toBeNull();
    expect(apiMocks.unitQueryStatuses).toContain("Disabled");
  });

  test("deep links select an inactive unit from the complete OU projection", async () => {
    renderWithProvider(<UnitsTab focusUnitId="u-disabled" />);

    const detail = await screen.findByTestId("unit-detail");
    expect(
      within(detail).getByRole("heading", { name: "Old Squad" }).textContent,
    ).toBe("Old Squad");
    expect(
      screen.getByTestId("organization-unit-row-u-disabled").dataset.active,
    ).toBe("true");
    expect(apiMocks.unitQueryStatuses).toContain(null);
  });

  test("unknown deep links do not silently select a different unit", async () => {
    renderWithProvider(<UnitsTab focusUnitId="missing-unit" />);

    await screen.findByTestId("unit-detail-empty");
    expect(
      document.querySelector(
        '[data-testid^="organization-unit-row-"][data-active="true"]',
      ),
    ).toBeNull();
  });

  test("search narrows the inventory without replacing the selected unit", () => {
    renderWithProvider(<UnitsTab />);
    const searchInput = screen.getByPlaceholderText(/filter by name or slug/i);
    fireEvent.change(searchInput, { target: { value: "brand" } });
    expect(screen.getByTestId("organization-unit-row-u-child")).toBeTruthy();
    expect(screen.queryByTestId("organization-unit-row-u-root")).toBeNull();
    expect(
      within(screen.getByTestId("unit-detail")).getByRole("heading", {
        name: "Marketing",
      }),
    ).toBeTruthy();
  });

  test("an unmatched search does not claim that no units exist", () => {
    renderWithProvider(<UnitsTab />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), {
      target: { value: "not-a-unit" },
    });
    expect(
      screen.getByText(en["admin.common.no-results-found"]).textContent,
    ).toBe(en["admin.common.no-results-found"]);
    expect(
      screen.queryByText(en["admin.organization.units.empty-title"]),
    ).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), {
      target: { value: "" },
    });
    expect(
      screen.getByTestId("organization-unit-row-u-root").textContent,
    ).toContain("Marketing");
  });

  test("ORG-F-T06 filters create-unit types by active kvk catalog", async () => {
    apiMocks.organizationMetadata = {
      unit_type_catalog: { schema_version: 1, id: "kvk" },
    };
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("organization-create-unit-button"));

    const typeSelect = await screen.findByTestId(
      "organization-create-unit-type-select",
    );
    const typeListbox = openMantineSelectListbox(typeSelect);
    await waitFor(() => {
      expect(
        within(typeListbox).getByRole("option", {
          name: /Fachbereich/i,
          hidden: true,
        }),
      ).toBeTruthy();
      expect(
        within(typeListbox).queryByRole("option", {
          name: /Amt/i,
          hidden: true,
        }),
      ).toBeNull();
      expect(
        within(typeListbox).queryByRole("option", {
          name: /Custom Board/i,
          hidden: true,
        }),
      ).toBeNull();
    });
  });

  test("UnitDetail master data saves through audited OU upsert", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.change(screen.getByTestId("unit-detail-name-input"), {
      target: { value: "Growth Marketing" },
    });
    fireEvent.click(screen.getByTestId("unit-detail-save-button"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toMatchObject({
      input: {
        id: "u-root",
        name: "Growth Marketing",
        slug: "marketing",
        unitTypeId: "t-1",
        parentUnitId: null,
        status: "Active",
        maxMembers: 25,
        metadata: root.metadata,
      },
    });
    expect(apiMocks.mutate).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.getByTestId("unit-detail-save-button")).toHaveProperty(
        "disabled",
        true,
      ),
    );
  });

  test("unit drafts survive tab changes and filtering, and owner changes require discard", async () => {
    renderWithProvider(<UnitsTab />);
    fireEvent.change(screen.getByTestId("unit-detail-name-input"), {
      target: { value: "Draft name" },
    });
    fireEvent.click(screen.getByTestId("unit-detail-tab-members"));
    fireEvent.click(screen.getByTestId("unit-detail-tab-master-data"));
    expect(screen.getByTestId("unit-detail-name-input")).toHaveProperty(
      "value",
      "Draft name",
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: en["admin.actions.search"] }),
      { target: { value: "Brand" } },
    );
    expect(screen.getByTestId("unit-detail-name-input")).toHaveProperty(
      "value",
      "Draft name",
    );
    fireEvent.click(
      screen
        .getByTestId("organization-unit-row-u-child")
        .querySelector("button")!,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("unit-detail-name-input")).toHaveProperty(
      "value",
      "Draft name",
    );
    fireEvent.click(
      screen
        .getByTestId("organization-unit-row-u-child")
        .querySelector("button")!,
    );
    fireEvent.click(screen.getByTestId("admin-confirm-modal-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("unit-detail-name-input")).toHaveProperty(
        "value",
        "Brand Team",
      ),
    );
    expect(apiMocks.trigger).not.toHaveBeenCalled();
  });

  test("failed unit persistence keeps the editable draft", async () => {
    const notifyError = vi
      .spyOn(notify, "error")
      .mockImplementation(() => "test-notification");
    apiMocks.trigger.mockRejectedValueOnce(new Error("save failed"));
    renderWithProvider(<UnitsTab />);
    fireEvent.change(screen.getByTestId("unit-detail-name-input"), {
      target: { value: "Retained draft" },
    });
    fireEvent.click(screen.getByTestId("unit-detail-save-button"));
    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(screen.getByTestId("unit-detail-name-input")).toHaveProperty(
      "value",
      "Retained draft",
    );
    expect(screen.getByTestId("unit-detail-save-button")).toHaveProperty(
      "disabled",
      false,
    );
    notifyError.mockRestore();
  });

  test("P-AR-2-03 inline role changes persist through assign mutation", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-members"));
    const row = screen.getByTestId("unit-detail-member-row-user-member");
    await selectFacadeOption(within(row).getByRole("combobox"), /manager/i);

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      input: {
        unitId: "u-root",
        userId: "user-member",
        role: "Manager",
      },
    });
    const optimisticCall = mutateCalls().find(
      ([updater, options]) =>
        typeof updater === "function" &&
        (options as { revalidate?: boolean } | undefined)?.revalidate === false,
    );
    expect(optimisticCall).toBeTruthy();
    if (!optimisticCall) throw new Error("expected optimistic mutate call");
    const optimisticData = (
      optimisticCall[0] as unknown as (current: {
        admin: { organizationUnitMembers: Array<typeof member> };
      }) => { admin: { organizationUnitMembers: Array<typeof member> } }
    )({ admin: { organizationUnitMembers: [member] } });
    expect(optimisticData.admin.organizationUnitMembers[0].role).toBe(
      "Manager",
    );
  });

  test("P-AR-2-03 add-member flow uses admin picker selection and selected role", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-members"));
    fireEvent.change(screen.getByTestId("unit-detail-add-member-picker"), {
      target: { value: "user-new" },
    });
    await selectFacadeOption("unit-detail-add-member-role", /reader/i);
    fireEvent.click(screen.getByTestId("unit-detail-add-member-button"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      input: {
        unitId: "u-root",
        userId: "user-new",
        role: "Reader",
      },
    });
  });

  test("P-AR-2-03 remove-member flow confirms before unassign mutation", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-members"));
    fireEvent.click(
      screen.getByTestId("unit-detail-member-remove-user-member"),
    );
    fireEvent.click(screen.getByTestId("admin-confirm-modal-confirm"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      unitId: "u-root",
      userId: "user-member",
    });
    expect(apiMocks.mutate).toHaveBeenCalled();
  });

  test("P-AR-2-04 add-workspace flow uses server-filtered picker and selected relationship", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-workspaces"));
    fireEvent.change(screen.getByTestId("unit-detail-add-workspace-picker"), {
      target: { value: "ws-new" },
    });
    fireEvent.click(screen.getByTestId("unit-detail-add-workspace-button"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      input: {
        unitId: "u-root",
        workspaceId: "ws-new",
        relationship: "Managed",
      },
    });
    expect(apiMocks.mutate).toHaveBeenCalled();
  });

  test("P-AR-2-04 existing workspace relationship can be changed to owner", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-workspaces"));
    await selectFacadeOption(
      "unit-detail-workspace-relationship-ws-reporting",
      /owner/i,
    );

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      input: {
        unitId: "u-root",
        workspaceId: "ws-reporting",
        relationship: "Owner",
      },
    });
    const optimisticCall = mutateCalls().find(
      ([updater, options]) =>
        typeof updater === "function" &&
        (options as { revalidate?: boolean } | undefined)?.revalidate === false,
    );
    expect(optimisticCall).toBeDefined();
    if (!optimisticCall) throw new Error("expected optimistic mutate call");
    const optimisticData = (
      optimisticCall[0] as unknown as (current: {
        admin: { organizationUnitWorkspaces: Array<typeof workspaceLink> };
      }) => {
        admin: { organizationUnitWorkspaces: Array<typeof workspaceLink> };
      }
    )({ admin: { organizationUnitWorkspaces: [workspaceLink] } });
    expect(optimisticData.admin.organizationUnitWorkspaces).toHaveLength(1);
    expect(
      optimisticData.admin.organizationUnitWorkspaces[0].relationship,
    ).toBe("Owner");
  });

  test("P-AR-2-04 remove-workspace flow confirms before unassign mutation", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-workspaces"));
    fireEvent.click(
      screen.getByTestId("unit-detail-workspace-remove-ws-reporting"),
    );
    fireEvent.click(screen.getByTestId("admin-confirm-modal-confirm"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      unitId: "u-root",
      workspaceId: "ws-reporting",
      relationship: "Managed",
    });
    expect(apiMocks.mutate).toHaveBeenCalled();
  });

  test("P-AR-2-05 saves the typed member limit through audited OU upsert", async () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-quota"));
    fireEvent.change(screen.getByTestId("unit-detail-quota-member-limit"), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByTestId("unit-detail-quota-save"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toMatchObject({
      input: {
        id: "u-root",
        name: "Marketing",
        slug: "marketing",
        unitTypeId: "t-1",
        parentUnitId: null,
        status: "Active",
        maxMembers: 50,
        metadata: {},
      },
    });
  });

  test("P-AR-2-06 renders OU-filtered audit list and opens JSON diff drawer", () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-audit"));

    expect(apiMocks.auditUnitIds).toContain("u-root");
    const row = screen.getByTestId("unit-detail-audit-row-audit-1");
    expect(within(row).getByText("Organizational unit saved")).toBeTruthy();
    expect(within(row).queryByText("organization.unit.upsert")).toBeNull();
    expect(within(row).getByText(/Admin User/)).toBeTruthy();

    fireEvent.click(row);
    const drawer = screen.getByTestId("unit-detail-audit-drawer");
    expect(within(drawer).getByText("Organizational unit saved")).toBeTruthy();
    expect(drawer.textContent).toContain("Old Marketing");
    expect(drawer.textContent).toContain("targetUnitId");
  });

  test("settings tab distinguishes active status from structured blockers and keeps delete disabled", () => {
    renderWithProvider(<UnitsTab />);

    fireEvent.click(screen.getByTestId("unit-detail-tab-settings"));
    const panel = screen.getByTestId("unit-detail-settings-panel");
    expect(within(panel).getByText("Deletion eligibility")).toBeTruthy();
    fireEvent.click(screen.getByTestId("unit-detail-deletion-preview-button"));
    expect(
      within(panel).getByText(
        "Active units must be disabled or archived before deletion.",
      ),
    ).toBeTruthy();
    expect(within(panel).getByText("Members")).toBeTruthy();
    expect(
      (screen.getByTestId("unit-detail-delete-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("permanent delete requires the exact name and sends the preview revision", async () => {
    apiMocks.deletionPreview = {
      id: "u-disabled",
      name: "Old Squad",
      status: "Disabled",
      updatedAt: "2026-01-02T00:00:00Z",
      deletable: true,
      blockers: [],
    };
    renderWithProvider(<UnitsTab />);
    await selectFacadeOption("organization-unit-status-filter", "Disabled");
    fireEvent.click(
      within(screen.getByTestId("organization-unit-row-u-disabled")).getByRole(
        "button",
      ),
    );
    fireEvent.click(screen.getByTestId("unit-detail-tab-settings"));
    fireEvent.click(screen.getByTestId("unit-detail-deletion-preview-button"));
    fireEvent.click(screen.getByTestId("unit-detail-delete-button"));

    const confirm = screen.getByTestId("unit-delete-confirm-button");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("unit-delete-confirm-input"), {
      target: { value: "Old" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("unit-delete-confirm-input"), {
      target: { value: "Old Squad" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(triggerArgAt(0)).toEqual({
      id: "u-disabled",
      confirmedName: "Old Squad",
      previewRevision: "2026-01-02T00:00:00Z",
    });
    expect(apiMocks.mutate).toHaveBeenCalled();
  });
});
