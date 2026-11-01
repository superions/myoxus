/**
 * @vitest-environment happy-dom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => {
  const translations: Record<string, string> = {
    "com.myoxus.settings.workspace.documents.header.title": "Documents",
    "com.myoxus.settings.workspace.documents.header.subtitle":
      "Workspace document defaults",
    "com.myoxus.settings.workspace.documents.notice.title":
      "Canonical metadata",
    "com.myoxus.settings.workspace.documents.notice.text":
      "These settings write server-side document defaults.",
    "com.myoxus.settings.workspace.documents.section.settings": "Settings",
    "com.myoxus.settings.workspace.documents.section.override-policy":
      "Attribute policy",
    "com.myoxus.settings.workspace.documents.loading":
      "Loading document settings...",
    "com.myoxus.settings.workspace.documents.section.preview":
      "New document preview",
    "com.myoxus.settings.workspace.documents.field.status-schema":
      "Status schema",
    "com.myoxus.settings.workspace.documents.field.default-status":
      "Default status",
    "com.myoxus.settings.workspace.documents.action.save":
      "Save document settings",
    "com.myoxus.settings.workspace.documents.action.reset": "Reset",
    "com.myoxus.settings.workspace.documents.action.saving": "Saving...",
    "com.myoxus.settings.workspace.documents.error.save":
      "Failed to save document settings",
    "com.myoxus.settings.workspace.documents.history.field.automatic":
      "Automatic edit capture",
    "com.myoxus.settings.workspace.documents.history.field.interval":
      "Capture interval (minutes)",
    "com.myoxus.settings.workspace.documents.history.field.named-enabled":
      "Named event versions",
    "com.myoxus.settings.workspace.documents.history.field.publish":
      "On publication",
    "com.myoxus.settings.workspace.documents.history.field.pdf":
      "On PDF export",
    "com.myoxus.settings.workspace.documents.history.field.daily":
      "Daily named version (04:30 UTC)",
    "com.myoxus.settings.workspace.documents.history.field.retention":
      "Named-version retention",
    "com.myoxus.settings.workspace.documents.history.field.triggers":
      "Event triggers",
    "com.myoxus.settings.workspace.documents.history.action.cancel": "Cancel",
    "com.myoxus.settings.workspace.documents.history.action.save":
      "Save automation",
    "com.myoxus.settings.workspace.documents.history.action.server-default":
      "Use server defaults",
    "com.myoxus.settings.workspace.documents.history.mode.custom": "Custom",
    "com.myoxus.settings.workspace.documents.history.mode.enabled": "Enabled",
    "com.myoxus.settings.workspace.documents.history.mode.disabled": "Disabled",
    "com.myoxus.settings.workspace.documents.history.mode.inherit":
      "Server default ({{value}})",
    "com.myoxus.settings.workspace.documents.history.value.enabled": "on",
    "com.myoxus.settings.workspace.documents.history.value.disabled": "off",
    "com.myoxus.document-metadata.section.label-visibility": "Visible labels",
    "com.myoxus.document-metadata.label-visibility.toggle":
      "Show {{label}} above the document",
    "com.myoxus.document-metadata.field.status": "Status",
    "com.myoxus.document-metadata.field.document-type": "Document type",
    "com.myoxus.document-metadata.field.classification": "Classification",
    "com.myoxus.document-metadata.field.version": "Version",
    Retry: "Retry",
  };
  const t = new Proxy(
    {},
    {
      get: (_target, key: string) => (params?: Record<string, string>) => {
        let text = translations[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {})) {
          text = text.replace(`{{${name}}}`, value);
        }
        return text;
      },
    },
  );
  return { useI18n: () => t };
});

vi.mock("../../primitives", () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  AccordionControl: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AccordionPanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Badge: ({ children, ...rest }: React.HTMLAttributes<HTMLElement>) => (
    <span {...rest} data-testid="facade-badge">
      {children}
    </span>
  ),
  BadgeList: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul {...rest} data-testid="facade-badge-list">
      {children}
    </ul>
  ),
  BadgeListItem: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLLIElement>) => <li {...rest}>{children}</li>,
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
  MyoxusText: ({
    children,
    component: Component = "span",
    tone: _tone,
    typographySlot: _typographySlot,
    ...rest
  }: React.HTMLAttributes<HTMLElement> & {
    component?: React.ElementType;
    tone?: string;
    typographySlot?: string;
  }) => <Component {...rest}>{children}</Component>,
  SettingsPage: ({
    children,
    title,
    subtitle,
  }: {
    children: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
  }) => (
    <main>
      <header>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </header>
      {children}
    </main>
  ),
  SettingsNotice: ({
    children,
    title,
    tone: _tone,
    ...rest
  }: {
    children: ReactNode;
    title?: ReactNode;
    tone?: string;
  } & React.HTMLAttributes<HTMLElement>) => (
    <aside {...rest}>
      {title ? <strong>{title}</strong> : null}
      <p>{children}</p>
    </aside>
  ),
  SettingsField: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: ReactNode;
    inline?: boolean;
  }) => (
    <label data-testid="facade-settings-field">
      <span>{label}</span>
      {children}
    </label>
  ),
  MyoxusSelect: ({
    block: _block,
    data,
    onChange,
    value,
    controlMaxWidth: _controlMaxWidth,
    ...rest
  }: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> & {
    block?: boolean;
    data: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    controlMaxWidth?: string;
  }) => (
    <select
      {...rest}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {data.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  NumberInput: ({
    onChange,
    ...rest
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
    onChange?: (value: number | string) => void;
  }) => (
    <input
      {...rest}
      type="number"
      onChange={(event) => onChange?.(Number(event.currentTarget.value))}
    />
  ),
  SettingsRow: ({
    children,
    disabled: _disabled,
    name,
  }: {
    children: ReactNode;
    disabled?: boolean;
    name: ReactNode;
  }) => (
    <label data-testid="facade-settings-row">
      <span>{name}</span>
      {children}
    </label>
  ),
  SettingsSummaryCard: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: ReactNode;
  }) => (
    <article data-testid="facade-settings-summary-card">
      <header>{label}</header>
      {children}
    </article>
  ),
  SettingsSummaryGrid: ({ children }: { children: ReactNode }) => (
    <div data-testid="facade-settings-summary-grid">{children}</div>
  ),
  SettingsToolbar: ({ children }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="facade-settings-toolbar">{children}</div>
  ),
  SettingWrapper: ({
    children,
    title,
  }: {
    children: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
  Stack: ({
    children,
    component: Component = "div",
    ...rest
  }: React.HTMLAttributes<HTMLElement> & {
    component?: React.ElementType;
  }) => <Component {...rest}>{children}</Component>,
  Switch: ({
    checked,
    label,
    onChange,
    testId,
    ...rest
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
    label?: ReactNode;
    onChange?: (checked: boolean) => void;
    testId?: string;
  }) => (
    <label>
      <span>{label}</span>
      <input
        {...rest}
        data-testid={testId}
        checked={checked}
        onChange={() => onChange?.(!checked)}
        type="checkbox"
      />
    </label>
  ),
  Table: ({
    children,
    withColumnBorders: _withColumnBorders,
    withRowBorders: _withRowBorders,
    ...rest
  }: React.TableHTMLAttributes<HTMLTableElement> & {
    withColumnBorders?: boolean;
    withRowBorders?: boolean;
  }) => <table {...rest}>{children}</table>,
  TableBody: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody {...rest}>{children}</tbody>
  ),
  TableCell: ({
    children,
    ...rest
  }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td {...rest}>{children}</td>
  ),
  TableHead: ({
    children,
    ...rest
  }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th {...rest}>{children}</th>
  ),
  TableHeader: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead {...rest}>{children}</thead>
  ),
  TableRow: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr {...rest}>{children}</tr>
  ),
}));

vi.mock("@myoxus/core/modules/server", () => ({
  GraphQLService: Symbol("GraphQLService"),
}));

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: Symbol("WorkspaceService"),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: vi.fn((value: unknown) => value),
    useService: vi.fn(),
  };
});

import { WorkspaceDocumentsSettingsView } from ".";

const settings = {
  __typename: "WorkspaceDocumentSettingsType",
  workspaceId: "ws-1",
  statusSchemaId: "schema-simple",
  defaultStatusId: "status-draft",
  versionPolicyId: "policy-global",
  defaultDocumentTypeId: "type-report",
  defaultClassificationId: "class-internal",
  defaultRetentionPolicyId: "retention-standard",
  updatedBy: null,
  updatedAt: "2026-05-02T10:00:00Z",
};

const historySettings = {
  workspaceId: "ws-1",
  namedVersioningEnabled: null as boolean | null,
  autoVersionOn: null as string[] | null,
  retentionCount: null as number | null,
  editCaptureEnabled: null as boolean | null,
  editCaptureIntervalMs: null as number | null,
  effectiveNamedVersioningEnabled: true,
  effectiveAutoVersionOn: ["on_pdf_export"],
  effectiveRetentionCount: 10,
  effectiveEditCaptureEnabled: true,
  effectiveEditCaptureIntervalMs: 900_000,
  enabledSource: "server",
  intervalSource: "server",
  legacyIntervalNormalized: false,
  runtimeAvailable: false,
  revision: "revision-1",
  updatedAt: null,
};

const statusSchemas = [
  {
    __typename: "DocumentStatusSchemaType",
    id: "schema-simple",
    key: "simple",
    label: "Simple",
    description: null,
    complexity: "simple",
    isPreset: true,
    isActive: true,
    metadata: {},
  },
  {
    __typename: "DocumentStatusSchemaType",
    id: "schema-review",
    key: "review",
    label: "Review",
    description: null,
    complexity: "review",
    isPreset: true,
    isActive: true,
    metadata: {},
  },
];

const statusValues = {
  simple: [
    {
      __typename: "DocumentStatusValueType",
      id: "status-draft",
      schemaId: "schema-simple",
      key: "draft",
      label: "Draft",
      description: null,
      color: null,
      icon: null,
      sortOrder: 0,
      terminal: false,
      isActive: true,
      metadata: {},
    },
  ],
  review: [
    {
      __typename: "DocumentStatusValueType",
      id: "status-needs-approval",
      schemaId: "schema-review",
      key: "needs_approval",
      label: "Needs approval",
      description: null,
      color: null,
      icon: null,
      sortOrder: 0,
      terminal: false,
      isActive: true,
      metadata: {},
    },
  ],
};

const documentTypes = [
  {
    __typename: "DocumentTypeDefinitionType",
    id: "type-report",
    key: "report",
    label: "Report",
    description: null,
    icon: null,
    color: null,
    defaultStatusId: "status-draft",
    isActive: true,
    isSuggested: true,
    templateDefaults: {},
  },
];

const versionPolicies = [
  {
    __typename: "DocumentVersionPolicyType",
    id: "policy-global",
    scope: "global",
    workspaceId: null,
    name: "Global policy",
    isDefault: true,
    enabledByDefault: true,
    schemePreset: "simple_counter",
    customPattern: null,
    timezoneMode: "utc",
    autoVersionOn: ["on_pdf_export"],
    retentionCount: 20,
    pinManualVersions: false,
    pinPublishVersions: true,
    publishedVersionsProtected: true,
    exportVersionsProtected: true,
    metadataSchema: {},
    createdBy: null,
    createdAt: "2026-05-02T10:00:00Z",
    updatedBy: null,
    updatedAt: "2026-05-02T10:00:00Z",
  },
];

const definitions = [
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "status",
    label: "Status",
    enabled: true,
    requiredMode: "optional",
    editableBy: "editor",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T10:00:00Z",
  },
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "documentType",
    label: "Document type",
    enabled: true,
    requiredMode: "optional",
    editableBy: "editor",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T10:00:00Z",
  },
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "version",
    label: "Version",
    enabled: true,
    requiredMode: "optional",
    editableBy: "admin_only",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: { computed: true },
    updatedBy: null,
    updatedAt: "2026-05-02T10:00:00Z",
  },
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "classification",
    label: "Classification",
    enabled: true,
    requiredMode: "optional",
    editableBy: "editor",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T10:00:00Z",
  },
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "language",
    label: "Language",
    enabled: true,
    requiredMode: "optional",
    editableBy: "editor",
    visibleInHeader: false,
    visibleInProperties: true,
    visibleInLists: false,
    exportMode: "optional",
    validationConfig: {},
    metadata: { allowWorkspaceOverride: true },
    updatedBy: null,
    updatedAt: "2026-05-02T10:00:00Z",
  },
];

const values = {
  classification: [
    {
      __typename: "DocumentMetadataValueDefinitionType",
      id: "class-internal",
      fieldKey: "classification",
      key: "internal",
      label: "Internal",
      description: null,
      color: null,
      icon: null,
      sortOrder: 0,
      isActive: true,
      metadata: {},
    },
  ],
  retentionPolicy: [
    {
      __typename: "DocumentMetadataValueDefinitionType",
      id: "retention-standard",
      fieldKey: "retentionPolicy",
      key: "standard",
      label: "Standard retention",
      description: null,
      color: null,
      icon: null,
      sortOrder: 0,
      isActive: true,
      metadata: {},
    },
  ],
};

function gqlMock({
  definitionsOverride = definitions,
  failSave = false,
  historyOverride,
}: {
  definitionsOverride?: typeof definitions;
  failSave?: boolean;
  historyOverride?: Partial<typeof historySettings>;
} = {}) {
  const currentHistorySettings = { ...historySettings, ...historyOverride };
  return vi.fn(
    async ({
      query,
      variables,
    }: {
      query: { op: string };
      variables?: any;
    }) => {
      switch (query.op) {
        case "workspaceDocumentSettings":
          return { workspaceDocumentSettings: settings };
        case "workspaceHistorySettings":
          return { workspaceHistorySettings: currentHistorySettings };
        case "documentStatusSchemas":
          return { documentStatusSchemas: statusSchemas };
        case "documentStatusValues":
          return {
            documentStatusValues:
              statusValues[variables.schemaKey as "simple" | "review"],
          };
        case "documentTypes":
          return { documentTypes };
        case "documentVersionPolicies":
          return { documentVersionPolicies: versionPolicies };
        case "documentMetadataFieldDefinitions":
          return { documentMetadataFieldDefinitions: definitionsOverride };
        case "documentMetadataValueDefinitions":
          return {
            documentMetadataValueDefinitions:
              values[
                variables.fieldKey as "classification" | "retentionPolicy"
              ],
          };
        case "updateWorkspaceDocumentSettings":
          if (failSave) throw new Error("permission denied");
          return {
            updateWorkspaceDocumentSettings: {
              ...settings,
              statusSchemaId: variables.input.statusSchemaId,
              defaultStatusId: variables.input.defaultStatusId,
            },
          };
        case "updateWorkspaceHistorySettings":
          if (failSave) throw new Error("permission denied");
          return {
            updateWorkspaceHistorySettings: {
              ...currentHistorySettings,
              ...variables.input,
              revision: "revision-2",
            },
          };
        default:
          throw new Error(`unexpected op ${query.op}`);
      }
    },
  );
}

describe("Workspace document settings", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("separates workspace defaults, personal visibility, and global policy", async () => {
    const gql = gqlMock();
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{ status: false }}
        onSetHeaderVisibilityOverride={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    expect(
      (await screen.findByRole("heading", { name: "Documents", level: 1 }))
        .textContent,
    ).toBe("Documents");
    expect(screen.queryByText("New document preview")).toBeNull();
    expect(
      (screen.getByLabelText("Default status") as HTMLSelectElement).value,
    ).toBe("status-draft");
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Report").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Internal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Global policy").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("facade-settings-row").length).toBeGreaterThan(
      10,
    );
    expect(
      screen.queryAllByTestId("facade-settings-summary-card"),
    ).toHaveLength(0);
    expect(screen.getAllByTestId("facade-badge").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "Visible labels" }).textContent,
    ).toBe("Visible labels");
    expect(
      screen.queryByRole("button", { name: "Save document settings" }),
    ).toBeNull();
    expect(screen.queryByText("classification", { exact: true })).toBeNull();
    expect(
      (
        screen.getByLabelText(
          "Show Status above the document",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  test("persists header label visibility from workspace document settings", async () => {
    const gql = gqlMock();
    const onSetHeaderVisibilityOverride = vi.fn();
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{ status: false }}
        onSetHeaderVisibilityOverride={onSetHeaderVisibilityOverride}
        workspaceId="ws-1"
      />,
    );

    await screen.findByRole("heading", { name: "Documents" });
    fireEvent.click(screen.getByLabelText("Show Status above the document"));
    expect(onSetHeaderVisibilityOverride).toHaveBeenCalledWith("status", true);
  });

  test("uses the full canonical header catalog for additional configured fields", async () => {
    const onChange = vi.fn();
    const extra = {
      ...definitions[0],
      key: "language",
      label: "Language",
      visibleInHeader: true,
    };
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={
          {
            gql: gqlMock({ definitionsOverride: [...definitions, extra] }),
          } as never
        }
        headerVisibilityOverrides={{ language: false }}
        onSetHeaderVisibilityOverride={onChange}
        workspaceId="ws-1"
      />,
    );
    await screen.findByRole("heading", { name: "Documents" });
    fireEvent.click(screen.getByLabelText("Show Language above the document"));
    expect(onChange).toHaveBeenCalledWith("language", true);
  });

  test("validates and saves automatic history independently", async () => {
    const gql = gqlMock();
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{}}
        onSetHeaderVisibilityOverride={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await screen.findByRole("heading", { name: "Documents" });
    fireEvent.change(screen.getByLabelText("Automatic edit capture"), {
      target: { value: "disabled" },
    });
    fireEvent.change(screen.getByLabelText("Capture interval (minutes)"), {
      target: { value: "custom" },
    });
    const interval = screen.getByTestId("workspace-history-interval-minutes");
    fireEvent.change(interval, { target: { value: "10" } });
    expect(
      screen
        .getByRole("button", { name: "Save automation" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(interval, { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            op: "updateWorkspaceHistorySettings",
          }),
          variables: {
            workspaceId: "ws-1",
            input: expect.objectContaining({
              expectedRevision: "revision-1",
              editCaptureEnabled: false,
              editCaptureIntervalMs: 900_000,
            }),
          },
        }),
      ),
    );
  });

  test("resets only history overrides to authoritative server defaults", async () => {
    const gql = gqlMock({
      historyOverride: {
        editCaptureEnabled: false,
        editCaptureIntervalMs: 1_200_000,
        revision: "revision-custom",
      },
    });
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{}}
        onSetHeaderVisibilityOverride={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await screen.findByRole("heading", { name: "Documents" });
    fireEvent.click(
      screen.getByRole("button", { name: "Use server defaults" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            workspaceId: "ws-1",
            input: expect.objectContaining({
              expectedRevision: "revision-custom",
              editCaptureEnabled: null,
              editCaptureIntervalMs: null,
            }),
          },
        }),
      ),
    );
  });

  test("does not allow personal visibility overrides to enable server-hidden header fields", async () => {
    const hiddenDocumentTypeDefinitions = definitions.map((definition) =>
      definition.key === "documentType"
        ? { ...definition, visibleInHeader: false }
        : definition,
    );
    const gql = gqlMock({ definitionsOverride: hiddenDocumentTypeDefinitions });
    const onSetHeaderVisibilityOverride = vi.fn();
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{ documentType: true }}
        onSetHeaderVisibilityOverride={onSetHeaderVisibilityOverride}
        workspaceId="ws-1"
      />,
    );

    await screen.findByRole("heading", { name: "Documents" });
    const toggle = screen.getByLabelText(
      "Show Document type above the document",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onSetHeaderVisibilityOverride).not.toHaveBeenCalled();
  });

  test("saves changed status schema through generated workspace mutation", async () => {
    const gql = gqlMock();
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{}}
        onSetHeaderVisibilityOverride={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await screen.findByRole("heading", { name: "Documents" });
    fireEvent.change(screen.getByLabelText("Status schema"), {
      target: { value: "schema-review" },
    });
    expect(
      (screen.getByLabelText("Default status") as HTMLSelectElement).value,
    ).toBe("status-needs-approval");
    fireEvent.click(
      screen.getByRole("button", { name: "Save document settings" }),
    );

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            workspaceId: "ws-1",
            input: expect.objectContaining({
              statusSchemaId: "schema-review",
              defaultStatusId: "status-needs-approval",
            }),
          }),
        }),
      ),
    );
  });

  test("shows permission errors instead of silently pretending read-only save worked", async () => {
    const gql = gqlMock({ failSave: true });
    render(
      <WorkspaceDocumentsSettingsView
        graphqlService={{ gql } as never}
        headerVisibilityOverrides={{}}
        onSetHeaderVisibilityOverride={vi.fn()}
        workspaceId="ws-1"
      />,
    );

    await screen.findByRole("heading", { name: "Documents" });
    fireEvent.change(screen.getByLabelText("Status schema"), {
      target: { value: "schema-review" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save document settings" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "permission denied",
    );
  });
});
