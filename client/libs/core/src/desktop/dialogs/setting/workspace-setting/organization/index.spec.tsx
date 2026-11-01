/**
 * @vitest-environment happy-dom
 */
/**
 * Web frontend Workspace-Setting → Organisation tab — smoke specs.
 *
 * Covers:
 *   ORG-G-T01 — Manager sieht eigene Workspace-Aktionen.
 *   ORG-G-T02 — Manager sieht keine fremden Workspace-Aktionen.
 *   ORG-G-T03 — Root-Level-Projektanlage respektiert Policy.
 *   ORG-G-T04 — Manager kann keine Adminrolle vergeben (UI bietet keine).
 */
import { readFileSync } from "node:fs";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// ── Stubs ────────────────────────────────────────────────────────────

vi.mock("@myoxus/i18n", () => {
  const dynamicTranslations: Record<string, string> = {
    "com.myoxus.settings.workspace.organization.audit.category.organization":
      "Organisation",
    "com.myoxus.settings.workspace.organization.audit.event.organization.member.assign":
      "Mitglied zugewiesen",
    "com.myoxus.settings.workspace.organization.audit.target.organization_unit_member":
      "OU-Mitglied",
  };
  const proxy = new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === "t") {
          return (i18nKey: string) => dynamicTranslations[i18nKey] ?? i18nKey;
        }
        return () => key;
      },
    },
  );
  return { useI18n: () => proxy };
});

vi.mock("../../primitives", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Input: ({
    block: _block,
    onChange,
    ...rest
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
    block?: boolean;
    onChange?: (value: string) => void;
  }) => (
    <input
      {...rest}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  ),
  FormRow: ({
    label,
    children,
  }: {
    label?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div data-myoxus-ui-role="form-row">
      {label ? <span>{label}</span> : null}
      {children}
    </div>
  ),
  FormSelect: ({
    block: _block,
    data,
    onChange,
    placeholder,
    value,
    controlMaxWidth: _controlMaxWidth,
    ...rest
  }: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
    data: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    placeholder?: string;
    controlMaxWidth?: string;
    block?: boolean;
  }) => (
    <select
      {...rest}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {data.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  SettingsControlEmpty: ({ children }: { children: React.ReactNode }) => (
    <div data-myoxus-ui-role="settings-control-empty">{children}</div>
  ),
  SettingsControlList: ({ children }: { children: React.ReactNode }) => (
    <div data-myoxus-ui-role="settings-control-list">{children}</div>
  ),
  SettingsDefinitionItem: ({
    children,
    label,
  }: {
    children: React.ReactNode;
    label: React.ReactNode;
  }) => (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  ),
  SettingsDefinitionList: ({ children }: { children: React.ReactNode }) => (
    <dl>{children}</dl>
  ),
  SettingsListItemMeta: ({
    breakAnywhere: _breakAnywhere,
    children,
  }: {
    breakAnywhere?: boolean;
    children: React.ReactNode;
  }) => <span data-myoxus-ui-role="settings-list-item-meta">{children}</span>,
  SettingsListItemTitle: ({ children }: { children: React.ReactNode }) => (
    <span data-myoxus-ui-role="settings-list-item-title">{children}</span>
  ),
  SettingsPage: ({
    title,
    subtitle,
    children,
  }: {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <main data-myoxus-ui-role="settings-page">
      <header>{title}</header>
      {subtitle}
      {children}
    </main>
  ),
  SettingsSection: ({
    title,
    description,
    children,
  }: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section data-testid="setting-wrapper">
      <header>{title}</header>
      {description}
      {children}
    </section>
  ),
  SettingsStatusText: ({ children }: { children: React.ReactNode }) => (
    <span data-myoxus-ui-role="settings-status-active">{children}</span>
  ),
  SettingsToolbar: ({ children }: { children: React.ReactNode }) => (
    <div data-myoxus-ui-role="settings-toolbar">{children}</div>
  ),
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StatusDot: ({
    label,
    tone,
    ...rest
  }: React.HTMLAttributes<HTMLSpanElement> & {
    label?: React.ReactNode;
    tone?: string;
  }) => (
    <span data-tone={tone} data-myoxus-ui-role="status-dot" {...rest}>
      {label}
    </span>
  ),
  SuggestionList: ({ children }: { children: React.ReactNode }) => (
    <div data-myoxus-ui-role="suggestion-list">{children}</div>
  ),
  SuggestionListItemButton: ({
    children,
    onMouseDown,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest} type="button" onMouseDown={onMouseDown}>
      {children}
    </button>
  ),
  SurfaceListItem: ({
    alignItems: _alignItems,
    appearance: _appearance,
    children,
    justifyContent: _justifyContent,
    layout: _layout,
    ...rest
  }: React.HTMLAttributes<HTMLElement> & {
    alignItems?: string;
    appearance?: string;
    justifyContent?: string;
    layout?: string;
  }) => (
    <article {...rest} data-myoxus-ui-role="surface-list-item">
      {children}
    </article>
  ),
  SurfaceListItemMain: ({ children }: { children: React.ReactNode }) => (
    <div data-myoxus-ui-role="surface-list-item-main">{children}</div>
  ),
  SurfaceListMeta: ({ children }: { children: React.ReactNode }) => (
    <span data-myoxus-ui-role="surface-list-meta">{children}</span>
  ),
  Table: ({
    children,
    withColumnBorders: _withColumnBorders,
    withTableBorder: _withTableBorder,
    verticalSpacing: _verticalSpacing,
    ...rest
  }: React.HTMLAttributes<HTMLTableElement> & {
    verticalSpacing?: string;
    withColumnBorders?: boolean;
    withTableBorder?: boolean;
  }) => <table {...rest}>{children}</table>,
  TableBody: ({ children, ...rest }: React.HTMLAttributes<HTMLElement>) => (
    <tbody {...rest}>{children}</tbody>
  ),
  TableCell: ({
    children,
    muted: _muted,
    ...rest
  }: React.TdHTMLAttributes<HTMLElement> & { muted?: boolean }) => (
    <td {...rest}>{children}</td>
  ),
  TableHead: ({ children, ...rest }: React.ThHTMLAttributes<HTMLElement>) => (
    <th {...rest}>{children}</th>
  ),
  TableHeader: ({ children, ...rest }: React.HTMLAttributes<HTMLElement>) => (
    <thead {...rest}>{children}</thead>
  ),
  TableRow: ({ children, ...rest }: React.HTMLAttributes<HTMLElement>) => (
    <tr {...rest}>{children}</tr>
  ),
  TableScrollContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-myoxus-ui-role="table-scroll-container">{children}</div>
  ),
}));

const myUnitsRef: {
  current: Array<{ id: string; name: string; slug: string; status: string }>;
} = {
  current: [],
};
const myLinksRef: {
  current: Array<{
    unitId: string;
    unitName?: string | null;
    unitSlug?: string | null;
    workspaceId: string;
    workspaceName?: string | null;
    relationship: string;
  }>;
} = { current: [] };
const myMembersRef: {
  current: Array<{
    unitId: string;
    userId: string;
    userEmail?: string | null;
    userName?: string | null;
    userAvatarUrl?: string | null;
    role: string;
    source: string;
    createdAt: string;
    updatedAt: string;
  }>;
} = { current: [] };
const managerSearchUsersRef: {
  current: Array<{
    id: string;
    email: string;
    name: string;
    features: string[];
  }>;
} = { current: [] };
const myAuditRef: {
  current: Array<{
    id: string;
    eventKey: string;
    category: string;
    targetUnitId: string;
    target?: { type: string; id: string; label?: string | null } | null;
    actor?: { id?: string | null; label?: string | null } | null;
    oldValue?: unknown;
    newValue?: unknown;
    metadata?: unknown;
    createdAt: string;
  }>;
} = { current: [] };

const rootDecisionRef: { current: string | undefined } = { current: undefined };
const unitDecisionRef: { current: string | undefined } = { current: undefined };
const wsDecisionRef: { current: boolean | undefined } = { current: undefined };

const createProjectTrigger = vi.fn().mockResolvedValue({
  createOrganizationProject: { decision: "Allowed", requestId: null },
});
const createWorkspaceTrigger = vi.fn();
const addMemberTrigger = vi.fn().mockResolvedValue(true);
const removeMemberTrigger = vi.fn().mockResolvedValue(true);

vi.mock("../../../../../components/hooks/use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    const trigger =
      mutation.id === "createWorkspaceInOrganizationUnitMutation"
        ? createWorkspaceTrigger
        : mutation.id === "addOrganizationUnitMemberAsManagerMutation"
          ? addMemberTrigger
          : mutation.id === "removeOrganizationUnitMemberAsManagerMutation"
            ? removeMemberTrigger
            : createProjectTrigger;
    return {
      trigger,
      isMutating: false,
      data: undefined,
    };
  },
}));

vi.mock("../../../../../components/hooks/use-query", () => {
  const queryStub = (data: unknown) => ({
    data,
    isLoading: false,
    error: undefined,
    mutate: vi.fn().mockResolvedValue(undefined),
  });
  return {
    useQuery: (options?: { query: { id: string }; variables?: any }) => {
      if (!options) {
        return queryStub({});
      }
      const { query, variables } = options;
      if (query.id === "myOrganizationUnitsQuery") {
        return queryStub({ myOrganizationUnits: myUnitsRef.current });
      }
      if (query.id === "myOrganizationUnitWorkspacesQuery") {
        return queryStub({ myOrganizationUnitWorkspaces: myLinksRef.current });
      }
      if (query.id === "myOrganizationUnitMembersQuery") {
        return queryStub({ myOrganizationUnitMembers: myMembersRef.current });
      }
      if (query.id === "managerSearchUsersQuery") {
        return queryStub({ managerSearchUsers: managerSearchUsersRef.current });
      }
      if (query.id === "myOrganizationAuditLogQuery") {
        return queryStub({ myOrganizationAuditLog: myAuditRef.current });
      }
      if (query.id === "canCreateOrganizationProjectQuery") {
        const isUnit = variables?.unitId != null;
        return queryStub({
          canCreateOrganizationProject: isUnit
            ? unitDecisionRef.current
            : rootDecisionRef.current,
        });
      }
      if (query.id === "canCreateWorkspaceInOrganizationUnitQuery") {
        return queryStub({
          canCreateWorkspaceInOrganizationUnit: wsDecisionRef.current ?? false,
        });
      }
      return queryStub({});
    },
  };
});

import { WorkspaceOrganizationSettings } from "./index";

afterEach(() => {
  cleanup();
  myUnitsRef.current = [];
  myLinksRef.current = [];
  myMembersRef.current = [];
  managerSearchUsersRef.current = [];
  myAuditRef.current = [];
  rootDecisionRef.current = undefined;
  unitDecisionRef.current = undefined;
  wsDecisionRef.current = undefined;
  createProjectTrigger.mockClear();
  createWorkspaceTrigger.mockClear();
  addMemberTrigger.mockClear();
  removeMemberTrigger.mockClear();
});

describe("WorkspaceOrganizationSettings", () => {
  test("ORG-G-T01: manager creates a project in their own unit", async () => {
    myUnitsRef.current = [
      { id: "u1", name: "Marketing", slug: "marketing", status: "Active" },
    ];
    rootDecisionRef.current = "Allowed";

    render(<WorkspaceOrganizationSettings />);

    expect(screen.getAllByText("Marketing").length).toBeGreaterThan(0);
    const name = screen.getByTestId(
      "organization-create-project-name",
    ) as HTMLInputElement;
    const submit = screen.getByTestId(
      "organization-create-project-submit",
    ) as HTMLButtonElement;
    expect(name.value).toBe("");
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(createProjectTrigger).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Campaign" } });
    fireEvent.change(screen.getByTestId("organization-create-project-unit"), {
      target: { value: "u1" },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(createProjectTrigger).toHaveBeenCalledExactlyOnceWith({
        input: { proposedName: "Campaign", parentUnitId: "u1" },
      }),
    );
    await waitFor(() => expect(name.value).toBe(""));
    expect(submit.disabled).toBe(true);
  });

  test("ORG-G-T02: empty unit list shows the empty-OU row (no foreign actions)", () => {
    myUnitsRef.current = [];
    render(<WorkspaceOrganizationSettings />);
    // The my-units empty key is rendered (i18n proxy returns the key
    // verbatim, which is enough to assert presence).
    expect(screen.getAllByText(/my-units\.empty/).length).toBeGreaterThan(0);
  });

  test("ORG-G-T03: root project decision pill reflects policy", () => {
    myUnitsRef.current = [
      { id: "u1", name: "Marketing", slug: "marketing", status: "Active" },
    ];
    rootDecisionRef.current = "Denied";
    render(<WorkspaceOrganizationSettings />);
    expect(
      screen.getByText(/policy\.denied/).closest("dd")?.textContent,
    ).toContain("policy.denied");
  });

  test("ORG-G-T05: workspace links render clear names instead of raw UUID labels", () => {
    const unitId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    myUnitsRef.current = [
      {
        id: unitId,
        name: "Bauamt",
        slug: "bauamt",
        status: "Active",
      },
    ];
    myLinksRef.current = [
      {
        unitId,
        unitName: "Bauamt",
        unitSlug: "bauamt",
        workspaceId,
        workspaceName: "Alpha Bauprojekte",
        relationship: "Owner",
      },
    ];

    const { container } = render(<WorkspaceOrganizationSettings />);

    expect(
      screen.getByText("Alpha Bauprojekte").closest("article")?.textContent,
    ).toContain("Bauamt");
    expect(screen.getAllByText("Bauamt").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("unit-label");
    expect(container.textContent).not.toContain(workspaceId);
    expect(container.textContent).not.toContain(unitId);
    expect(container.textContent).not.toMatch(/\bbauamt\b/);
  });

  test("ORG-G-T06: member administration uses user search and never displays UUIDs as editable labels", () => {
    const unitId = "33333333-3333-4333-8333-333333333333";
    const userId = "44444444-4444-4444-8444-444444444444";
    myUnitsRef.current = [
      {
        id: unitId,
        name: "Personal",
        slug: "personal",
        status: "Active",
      },
    ];
    myMembersRef.current = [
      {
        unitId,
        userId,
        userName: "Ada Lovelace",
        userEmail: "ada@example.test",
        userAvatarUrl: null,
        role: "Member",
        source: "Manual",
        createdAt: "2026-05-18T00:00:00Z",
        updatedAt: "2026-05-18T00:00:00Z",
      },
    ];
    managerSearchUsersRef.current = [
      {
        id: userId,
        name: "Ada Lovelace",
        email: "ada@example.test",
        features: [],
      },
    ];

    const { container } = render(<WorkspaceOrganizationSettings />);
    fireEvent.change(screen.getByTestId("organization-member-unit"), {
      target: { value: unitId },
    });
    fireEvent.change(screen.getByTestId("organization-member-user-search"), {
      target: { value: "Ada" },
    });
    fireEvent.mouseDown(screen.getByTestId("organization-member-user-option"));
    fireEvent.click(screen.getByTestId("organization-member-add"));

    expect(screen.queryByText(/^Admin$/i)).toBeNull();
    expect(screen.queryByText(/^Owner$/i)).toBeNull();
    expect(screen.queryByTestId("organization-member-user-id")).toBeNull();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ada@example.test").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain(userId);
    expect(addMemberTrigger).toHaveBeenCalledWith({
      unitId,
      userId,
      role: "Member",
    });
  });

  test("ORG-G-T07: audit rows render translated labels and hide raw UUID fallback labels", async () => {
    const unitId = "55555555-5555-4555-8555-555555555555";
    const targetUserId = "66666666-6666-4666-8666-666666666666";
    myUnitsRef.current = [
      {
        id: unitId,
        name: "Bauamt",
        slug: "bauamt",
        status: "Active",
      },
    ];
    myAuditRef.current = [
      {
        id: "audit-1",
        eventKey: "organization.member.assign",
        category: "organization",
        targetUnitId: unitId,
        target: {
          type: "organization_unit_member",
          id: targetUserId,
          label: targetUserId,
        },
        actor: { id: "actor-1", label: "manager@example.test" },
        createdAt: "2026-05-18T10:00:00Z",
      },
    ];

    const { container } = render(<WorkspaceOrganizationSettings />);

    fireEvent.change(
      screen.getByLabelText(
        "com.myoxus.settings.workspace.organization.audit.unit-label",
      ),
      { target: { value: unitId } },
    );

    const auditRow = (await screen.findByText("Mitglied zugewiesen")).closest(
      "article",
    );
    expect(auditRow?.textContent).toContain("Organisation");
    expect(auditRow?.textContent).toContain("manager@example.test");
    expect(auditRow?.textContent).toContain("OU-Mitglied");
    expect(container.textContent).toContain("OU-Mitglied");
    expect(container.textContent).not.toContain(targetUserId);
    expect(container.textContent).not.toContain("organization.member.assign");
  });

  test("ORG-G-T08: German settings copy avoids raw OU/workspace/policy labels", () => {
    const de = JSON.parse(
      readFileSync("client/libs/i18n/src/resources/de.json", "utf8"),
    ) as Record<string, string>;
    const visibleCopy = [
      "com.myoxus.settings.workspace.organization.header.subtitle",
      "com.myoxus.settings.workspace.organization.create-project.policy-root",
      "com.myoxus.settings.workspace.organization.create-project.policy-unit",
      "com.myoxus.settings.workspace.organization.create-workspace.policy",
      "com.myoxus.settings.workspace.organization.create-workspace.submit",
      "com.myoxus.settings.workspace.organization.create-workspace.title",
      "com.myoxus.settings.workspace.organization.create-workspace.unit-placeholder",
      "com.myoxus.settings.workspace.organization.audit.target.organization_unit_member",
      "com.myoxus.settings.workspace.organization.members.empty",
      "com.myoxus.settings.workspace.organization.members.empty-desc",
      "com.myoxus.settings.workspace.organization.members.source-label",
      "com.myoxus.settings.workspace.organization.members.title",
      "com.myoxus.settings.workspace.organization.my-units.empty",
      "com.myoxus.settings.workspace.organization.workspaces.empty",
      "com.myoxus.settings.workspace.organization.workspaces.title",
      "com.myoxus.settings.workspace.organization.workspaces.unknown",
    ]
      .map((key) => de[key])
      .join("\n");

    expect(visibleCopy).toContain("Arbeitsbereiche");
    expect(visibleCopy).toContain("Organisationseinheit");
    expect(visibleCopy).toContain("Verantwortliche");
    expect(visibleCopy).not.toMatch(
      /\b(?:OU|OUs|Workspace|Workspaces|Policy|Root)\b/,
    );
    expect(visibleCopy).not.toContain("Manager:innen");
  });
});
