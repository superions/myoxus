/**
 * @vitest-environment happy-dom
 */

import { Framework, FrameworkRoot, LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { Modal } from "@myoxus/ui-facade";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({
    locale: "en-US",
    timezone: "UTC",
    dateFormat: "locale",
    timeFormat: "locale",
  }),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      language: "en",
      Edit: () => "Edit",
      Retry: () => "Retry",
      t: (key: string) => key,
      "com.myoxus.document-metadata.eyebrow": () => "Metadata",
      "com.myoxus.document-metadata.title": () => "Document metadata",
      "com.myoxus.document-metadata.description": () =>
        "Edit the canonical metadata used by workflows, PDF export and governance checks.",
      "com.myoxus.document-metadata.action.refresh": () => "Refresh",
      "com.myoxus.document-metadata.loading": () => "Loading metadata...",
      "com.myoxus.document-metadata.summary.fields": ({
        count,
      }: {
        count: number;
      }) => `Manage ${count} metadata fields`,
      "com.myoxus.document-metadata.summary.loading": () => "Loading metadata",
      "com.myoxus.document-metadata.more.title": () => "More metadata",
      "com.myoxus.document-metadata.section.metadata": () =>
        "Document metadata",
      "com.myoxus.document-metadata.section.system": () => "System",
      "com.myoxus.document-metadata.section.presentation": () =>
        "Display and modes",
      "com.myoxus.document-metadata.section.workflow": () => "Workflow",
      "com.myoxus.document-metadata.section.governance": () => "Governance",
      "com.myoxus.document-metadata.section.responsibility": () =>
        "Responsibility and dates",
      "com.myoxus.document-metadata.section.label-visibility": () =>
        "Visible labels",
      "com.myoxus.document-metadata.section.information": () =>
        "Document information",
      "com.myoxus.document-metadata.tab.information": () => "Information",
      "com.myoxus.document-metadata.sidebar.aria-label": () =>
        "Document attributes",
      "com.myoxus.document-metadata.sidebar.description": () =>
        "Read-only server metadata, system facts and display controls for this document.",
      "com.myoxus.document-metadata.label-visibility.toggle": ({
        label,
      }: {
        label: string;
      }) => `Show ${label} above the document`,
      "com.myoxus.document-metadata.field.status": () => "Status",
      "com.myoxus.document-metadata.field.document-type": () => "Document type",
      "com.myoxus.document-metadata.field.version": () => "Version",
      "com.myoxus.document-metadata.field.created-at": () => "Created at",
      "com.myoxus.document-metadata.field.created-by": () => "Created by",
      "com.myoxus.document-metadata.field.document-id": () => "Document ID",
      "com.myoxus.document-metadata.field.updated-at": () => "Updated at",
      "com.myoxus.document-metadata.field.updated-by": () => "Updated by",
      "com.myoxus.document-metadata.field.metadata-revision": () =>
        "Metadata revision",
      "com.myoxus.document-metadata.field.metadata-updated-at": () =>
        "Metadata updated at",
      "com.myoxus.document-metadata.field.projection-version": () =>
        "Projection version",
      "com.myoxus.document-metadata.field.primary-mode": () =>
        "Default view for this document",
      "com.myoxus.document-metadata.field.page-width": () => "Page width",
      "com.myoxus.document-metadata.field.edgeless-color-theme": () =>
        "Edgeless color theme",
      "com.myoxus.document-metadata.field.template-state": () =>
        "Template state",
      "com.myoxus.document-metadata.field.journal-date": () => "Journal date",
      "com.myoxus.document-metadata.field.integration-type": () =>
        "Integration type",
      "com.myoxus.document-metadata.field.responsible": () => "Responsible",
      "com.myoxus.document-metadata.field.review-due-at": () => "Review due at",
      "com.myoxus.document-metadata.field.valid-from": () => "Valid from",
      "com.myoxus.document-metadata.field.valid-until": () => "Valid until",
      "com.myoxus.document-metadata.field.classification": () =>
        "Classification",
      "com.myoxus.document-metadata.field.document-number": () =>
        "Document number",
      "com.myoxus.document-metadata.field.language": () => "Language",
      "com.myoxus.document-metadata.field.audience": () => "Audience",
      "com.myoxus.document-metadata.field.retention-policy": () =>
        "Retention policy",
      "com.myoxus.document-metadata.value.no-status": () => "No status",
      "com.myoxus.document-metadata.value.no-type": () => "No type",
      "com.myoxus.document-metadata.value.no-version": () => "No version",
      "com.myoxus.document-metadata.value.not-set": () => "Not set",
      "com.myoxus.document-metadata.value.unversioned-changes": () =>
        "Unversioned changes",
      "com.myoxus.document-metadata.value.changed": () => "changed",
      "com.myoxus.document-metadata.value.principal.one": () =>
        "responsible party",
      "com.myoxus.document-metadata.value.principal.other": () =>
        "responsible parties",
      "com.myoxus.document-metadata.validation.issues": () =>
        "validation issues",
      "com.myoxus.document-metadata.validation.warnings": () => "warnings",
      "com.myoxus.document-metadata.validation.required": ({
        label,
      }: {
        label: string;
      }) => `${label} is required.`,
      "com.myoxus.document-metadata.validation.blocks": () => "Blocks",
      "com.myoxus.page-properties.property.tags": () => "Tags",
      "com.myoxus.settings.workspace.documents.section.settings": () =>
        "Document settings",
      "com.myoxus.settings.workspace": () => "Workspace",
      "admin.documents.metadata-fields.editor.title": () =>
        "Metadata field policy",
      Page: () => "Page",
      Edgeless: () => "Edgeless",
    }) as any,
}));

import { DocumentLifecycleStore } from "../doc/stores/document-lifecycle";
import { WorkspaceService } from "../workspace";
import {
  PublicUserService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import { PublicUserStore } from "@myoxus/core/modules/server/stores/public-user";
import { loadDocumentMetadataModel } from "./api";
import { DocumentMetadataEditorView } from "./index";

const definitions = [
  {
    key: "status",
    label: "Status",
    enabled: true,
    requiredMode: "never",
    editableBy: "editor",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: { write: "transition_only" },
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    key: "documentType",
    label: "Document type",
    enabled: true,
    requiredMode: "never",
    editableBy: "editor",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    key: "version",
    label: "Version",
    enabled: true,
    requiredMode: "never",
    editableBy: "admin_only",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: { computed: true },
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    key: "classification",
    label: "Classification",
    enabled: true,
    requiredMode: "always",
    editableBy: "editor",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "required",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    key: "language",
    label: "Language",
    enabled: true,
    requiredMode: "never",
    editableBy: "editor",
    visibleInHeader: false,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
  {
    key: "responsible",
    label: "Responsible",
    enabled: true,
    requiredMode: "never",
    editableBy: "responsible",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00.000Z",
  },
];

const statusDraft = {
  id: "status-draft",
  schemaId: "schema-1",
  key: "draft",
  label: "Draft",
  description: null,
  color: null,
  icon: null,
  sortOrder: 1,
  terminal: false,
  isActive: true,
  metadata: {},
};

const documentTypeReport = {
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
};

const baseMetadata = {
  docId: "doc-1",
  workspaceId: "workspace-1",
  projectionMode: "MYOXUS_NATIVE",
  projectionVersion: "contract-v2:doc:7:fields:1:refs:1:org:1:ws:1",
  metadataRevision: 7,
  metadataUpdatedAt: "2026-05-02T00:00:00.000Z",
  metadataUpdatedBy: "user-1",
  system: {
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    createdBy: "user-1",
    updatedBy: "user-1",
    metadataUpdatedAt: "2026-05-02T00:00:00.000Z",
    metadataUpdatedBy: "user-1",
  },
  fields: [
    {
      key: "status",
      source: "DOCUMENT",
      reference: {
        id: "status-draft",
        key: "draft",
        label: "Draft",
        isActive: true,
      },
      textValue: null,
      timestampValue: null,
      dateValue: null,
      userId: null,
    },
    {
      key: "documentType",
      source: "DOCUMENT",
      reference: {
        id: "type-report",
        key: "report",
        label: "Report",
        isActive: true,
      },
      textValue: null,
      timestampValue: null,
      dateValue: null,
      userId: null,
    },
    {
      key: "version",
      source: "DOCUMENT",
      reference: { id: "ver-1", key: "1", label: "v1", isActive: true },
      textValue: "dirty",
      timestampValue: "2026-05-01T12:00:00.000Z",
      dateValue: null,
      userId: null,
    },
    {
      key: "classification",
      source: "FALLBACK",
      reference: null,
      textValue: null,
      timestampValue: null,
      dateValue: null,
      userId: null,
    },
    {
      key: "language",
      source: "ORGANIZATION",
      reference: { id: "lang-en", key: "en", label: "English", isActive: true },
      textValue: null,
      timestampValue: null,
      dateValue: null,
      userId: null,
    },
    {
      key: "documentNumber",
      source: "DOCUMENT",
      reference: null,
      textValue: "DOC-1",
      timestampValue: null,
      dateValue: null,
      userId: null,
    },
    {
      key: "responsible",
      source: "DOCUMENT",
      reference: null,
      textValue: null,
      timestampValue: null,
      dateValue: null,
      userId: "user-2",
    },
  ],
  audience: [],
  template: {
    state: "document",
    templateId: null,
    revisionId: null,
    instanceId: null,
  },
  journal: { journalDate: null },
  presentation: {
    primaryMode: "page",
    pageWidth: "standard",
    edgelessColorTheme: null,
  },
  integration: { integrationType: null },
  policy: { locks: [] },
  legacy: {},
};

const baseValidation = {
  valid: false,
  missingRequiredMetadataFields: ["classification"],
  blockedActions: ["export_pdf", "transition_status"],
  errors: [
    {
      code: "DOCUMENT_ATTRIBUTE_REQUIRED",
      key: "classification",
      message: "Classification is required.",
      severity: "error",
      blockedActions: ["export_pdf", "transition_status"],
      details: {},
    },
  ],
  warnings: [],
};

async function renderEditorLookupResponse(
  op: string,
  variables?: Record<string, unknown>,
) {
  switch (op) {
    case "documentMetadata":
      return { documentMetadata: baseMetadata };
    case "documentMetadataValidation":
      expect(variables?.docId).toBe("doc-1");
      return { documentMetadataValidation: baseValidation };
    case "documentMetadataFieldDefinitions":
      return { documentMetadataFieldDefinitions: definitions };
    case "documentTypes":
      return { documentTypes: [documentTypeReport] };
    case "workspaceDocumentSettings":
      return {
        workspaceDocumentSettings: {
          workspaceId: "workspace-1",
          statusSchemaId: "schema-1",
        },
      };
    case "getMembersByWorkspaceId":
      expect(variables?.workspaceId).toBe("workspace-1");
      return {
        workspace: {
          memberCount: 3,
          members: [
            {
              id: "user-1",
              name: "Server Creator",
              email: "creator@example.test",
              avatarUrl: null,
              permission: "Admin",
              inviteId: "",
              emailVerified: true,
              status: "Accepted",
            },
            {
              id: "user-2",
              name: "Ada Lovelace",
              email: "ada@example.test",
              avatarUrl: null,
              permission: "Admin",
              inviteId: "",
              emailVerified: true,
              status: "Accepted",
            },
            {
              id: "user-3",
              name: "Grace Hopper",
              email: "grace@example.test",
              avatarUrl: null,
              permission: "Writer",
              inviteId: "",
              emailVerified: true,
              status: "Accepted",
            },
          ],
        },
      };
    case "documentStatusSchemas":
      return {
        documentStatusSchemas: [
          {
            id: "schema-1",
            key: "simple",
            label: "Simple",
            description: null,
            complexity: "simple",
            isPreset: true,
            isActive: true,
            metadata: {},
          },
        ],
      };
    case "documentStatusValues":
      expect(variables?.schemaKey).toBe("simple");
      return {
        documentStatusValues: [
          statusDraft,
          {
            ...statusDraft,
            id: "status-review",
            key: "review",
            label: "Review",
            sortOrder: 2,
          },
        ],
      };
    case "documentMetadataValueDefinitions":
      return {
        documentMetadataValueDefinitions:
          variables?.fieldKey === "classification"
            ? [
                {
                  id: "class-internal",
                  fieldKey: "classification",
                  key: "internal",
                  label: "Internal",
                  description: null,
                  color: null,
                  icon: null,
                  sortOrder: 1,
                  isActive: true,
                  metadata: {},
                },
              ]
            : [],
      };
    case "transitionDocumentStatus":
      return {
        transitionDocumentStatus: {
          metadata: baseMetadata,
          validation: {
            valid: true,
            missingRequiredMetadataFields: [],
            blockedActions: [],
            errors: [],
            warnings: [],
          },
        },
      };
    case "setDocumentMetadata":
      return { setDocumentMetadata: { metadata: baseMetadata } };
    default:
      return {};
  }
}

function renderEditor(
  responseOverride?: (
    op: string,
    variables?: Record<string, unknown>,
  ) => Promise<unknown> | unknown | undefined,
  props?: Partial<ComponentProps<typeof DocumentMetadataEditorView>>,
  publicUsers?: PublicUserService,
  insideModal = false,
) {
  const framework = new Framework();
  framework.service(WorkspaceService, {
    workspace: { id: "workspace-1" },
  } as any);
  framework.store(DocumentLifecycleStore);
  if (publicUsers)
    framework.service(WorkspaceServerService, {
      server$: new LiveData({ scope: { get: () => publicUsers } }),
    } as any);
  const gql = vi.fn(
    async ({
      query,
      variables,
    }: {
      query: { op: string };
      variables?: Record<string, unknown>;
    }) =>
      (await responseOverride?.(query.op, variables)) ??
      renderEditorLookupResponse(query.op, variables),
  );

  const editor = (
    <DocumentMetadataEditorView
      docId="doc-1"
      graphqlService={{ gql } as never}
      {...props}
    />
  );
  render(
    <MyoxusUIProvider>
      <FrameworkRoot framework={framework.provider()}>
        {insideModal ? (
          <Modal open title="Metadata">
            {editor}
          </Modal>
        ) : (
          editor
        )}
      </FrameworkRoot>
    </MyoxusUIProvider>,
  );
  return gql;
}

async function chooseMantineSelectOption(label: string, option: string) {
  // Happy DOM has no clipping geometry; Floating hides portal descendants.
  // Served-browser journeys cover visibility and focus with actual layout.
  const control = await screen.findByRole("combobox", {
    name: label,
    hidden: true,
  });
  fireEvent.mouseDown(control);
  const options = await screen.findAllByRole("option", {
    name: option,
    hidden: true,
  });
  expect(options.length).toBeGreaterThan(0);
  fireEvent.click(options[options.length - 1]);
}

const headerChoices = [
  ["status", "Status", "status-next", "toStatusId"],
  ["documentType", "Document type", "documentType-next", "documentTypeId"],
  [
    "classification",
    "Classification",
    "classification-next",
    "classificationId",
  ],
  ["language", "Language", "language-next", "languageId"],
  [
    "retentionPolicy",
    "Retention policy",
    "retentionPolicy-next",
    "retentionPolicyId",
  ],
  ["audience", "Audience", "audience-next", "audienceIds"],
  ["responsible", "Responsible", "user-3", "responsibleUserId"],
] as const;

function headerFixture() {
  let metadata = {
    ...baseMetadata,
    fields: [
      ...baseMetadata.fields.filter(
        (field) =>
          !["classification", "retentionPolicy", "language"].includes(
            field.key,
          ),
      ),
      ...["classification", "retentionPolicy", "language"].map((key) => ({
        ...baseMetadata.fields[3],
        key,
        source: "DOCUMENT",
        reference: {
          id: `${key}-current`,
          key: "current",
          label: `${key} current`,
          isActive: true,
        },
      })),
    ] as Array<{
      key: string;
      source: string;
      reference: {
        id: string;
        key: string;
        label: string;
        isActive: boolean;
      } | null;
      textValue: string | null;
      timestampValue: string | null;
      dateValue: string | null;
      userId: string | null;
    }>,
    audience: [
      {
        source: "DOCUMENT",
        value: {
          id: "audience-current",
          key: "current",
          label: "audience current",
          isActive: true,
        },
      },
    ],
  };
  const choices = (key: string) =>
    ["current", "next"].map((suffix, index) => ({
      id: `${key}-${suffix}`,
      fieldKey: key,
      key: suffix,
      label: `${key} ${suffix}`,
      description: null,
      color: null,
      icon: null,
      sortOrder: index,
      isActive: true,
      metadata: {},
    }));
  const response = (
    op: string,
    variables?: Record<string, unknown>,
  ): unknown => {
    if (op === "documentMetadata") return { documentMetadata: metadata };
    if (op === "documentMetadataFieldDefinitions")
      return {
        documentMetadataFieldDefinitions: [
          ...headerChoices.map(([key, label]) => ({
            ...definitions[0],
            key,
            label,
            visibleInHeader: true,
            metadata: {},
          })),
          definitions.find((definition) => definition.key === "version")!,
        ],
      };
    if (op === "documentMetadataValueDefinitions")
      return {
        documentMetadataValueDefinitions: choices(String(variables?.fieldKey)),
      };
    if (op === "documentStatusValues")
      return {
        documentStatusValues: [
          statusDraft,
          { ...statusDraft, id: "status-next", label: "status next" },
        ],
      };
    if (op === "documentTypes")
      return {
        documentTypes: [
          documentTypeReport,
          {
            ...documentTypeReport,
            id: "documentType-next",
            label: "documentType next",
          },
        ],
      };
    if (op === "setDocumentMetadata" || op === "transitionDocumentStatus") {
      const input = variables?.input as Record<string, string | string[]>;
      const choice = headerChoices.find(([, , , field]) => field in input)!;
      const [key, , , field] = choice;
      const value = input[field];
      metadata = {
        ...metadata,
        metadataRevision: metadata.metadataRevision + 1,
        fields: metadata.fields.map((item) =>
          item.key !== key
            ? item
            : key === "responsible"
              ? { ...item, userId: value as string }
              : {
                  ...item,
                  reference: {
                    id: value as string,
                    key: "next",
                    label: `${key} next`,
                    isActive: true,
                  },
                },
        ),
        audience:
          key === "audience"
            ? (value as string[]).map((id) => ({
                source: "DOCUMENT",
                value: {
                  id,
                  key: id,
                  label: id.replace("-", " "),
                  isActive: true,
                },
              }))
            : metadata.audience,
      };
      return op === "setDocumentMetadata"
        ? { setDocumentMetadata: { metadata } }
        : {
            transitionDocumentStatus: { metadata, validation: baseValidation },
          };
    }
    return undefined;
  };
  return { response };
}

describe("DocumentMetadataEditor", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("loads native metadata and renders header, controls and validation", async () => {
    const gql = renderEditor();

    const header = await screen.findByTestId("document-metadata-header");
    expect(header.textContent).toContain("Draft");
    expect(header.textContent).toContain("Report");
    expect(header.textContent).toContain("v1");
    expect(header.textContent).not.toContain("DOC-1");
    expect(header.textContent).toContain("Ada Lovelace");
    expect(header.textContent).not.toContain("Not set");
    expect(
      screen.queryByTestId("document-metadata-field-classification"),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("document-metadata-toggle"));

    expect(
      screen.getByTestId("document-metadata-validation").textContent,
    ).toContain("Classification is required.");
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ op: "documentMetadataValidation" }),
        variables: { workspaceId: "workspace-1", docId: "doc-1" },
        context: expect.objectContaining({ signal: expect.any(AbortSignal) }),
      }),
    );
    expect(screen.queryByTestId("document-metadata-field-language")).toBeNull();
    const sectionOrder = [
      "document-info-section-metadata",
      "document-info-section-presentation",
      "document-info-section-system",
    ].map((testId) => screen.getByTestId(testId).textContent);
    expect(sectionOrder[0]).toContain("Document metadata");
    expect(sectionOrder[1]).toContain("Display and modes");
    expect(sectionOrder[1]).toContain("Default view for this document");
    expect(sectionOrder[1]).toContain("Page");
    expect(sectionOrder[2]).toContain("System");
    expect(sectionOrder[2]).toContain("Metadata revision");
    expect(sectionOrder[2]).toContain("7");
    fireEvent.click(screen.getByRole("button", { name: "More metadata" }));
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  test("preserves an acknowledged selection missing from the active catalog", async () => {
    const fixture = headerFixture();
    const gql = renderEditor((op, variables) => {
      const response = fixture.response(op, variables) as any;
      return op === "documentMetadataValueDefinitions" &&
        variables?.fieldKey === "classification"
        ? {
            documentMetadataValueDefinitions:
              response.documentMetadataValueDefinitions.filter(
                (value: any) => value.id === "classification-next",
              ),
          }
        : response;
    });
    const header = await screen.findByTestId("document-metadata-header");
    fireEvent.click(
      within(header).getByRole("button", { name: /^Classification:/ }),
    );
    const popover = await screen.findByTestId(
      "document-metadata-popover-classification",
    );
    expect(
      within(popover).getByRole("combobox", {
        name: "Classification",
        hidden: true,
      }),
    ).toHaveProperty("value", "classification current");
    await chooseMantineSelectOption("Classification", "classification current");
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query.op === "setDocumentMetadata",
      ),
    ).toHaveLength(0);
    await chooseMantineSelectOption("Classification", "classification next");
    await waitFor(() =>
      expect(header.textContent).toContain("classification next"),
    );
    const writes = gql.mock.calls.filter(
      ([request]) => request.query.op === "setDocumentMetadata",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][0].variables?.input).toEqual({
      classificationId: "classification-next",
    });
  });

  test("retains the acknowledged value after failed save and retries from the same popover", async () => {
    const fixture = headerFixture();
    let fail = true;
    const gql = renderEditor((op, variables) => {
      if (op === "setDocumentMetadata" && fail) {
        fail = false;
        return Promise.reject(new Error("Save unavailable"));
      }
      return fixture.response(op, variables);
    });
    const header = await screen.findByTestId("document-metadata-header");
    fireEvent.click(within(header).getByRole("button", { name: /^Language:/ }));
    await chooseMantineSelectOption("Language", "language next");
    const popover = await screen.findByTestId(
      "document-metadata-popover-language",
    );
    await within(popover).findByText("Save unavailable");
    expect(header.textContent).toContain("language current");
    fireEvent.click(
      within(popover).getByRole("button", { name: "Retry", hidden: true }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("document-metadata-popover-language"),
      ).toBeNull(),
    );
    expect(header.textContent).toContain("language next");
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query.op === "setDocumentMetadata",
      ),
    ).toHaveLength(2);
  });

  test("serializes audience full-set saves and removes from acknowledged values", async () => {
    const fixture = headerFixture();
    let acknowledge: (() => void) | undefined;
    let pending = true;
    const gql = renderEditor((op, variables) => {
      if (op === "setDocumentMetadata" && pending) {
        pending = false;
        return new Promise((resolve) => {
          acknowledge = () => resolve(fixture.response(op, variables));
        });
      }
      return fixture.response(op, variables);
    });
    const header = await screen.findByTestId("document-metadata-header");
    fireEvent.click(within(header).getByRole("button", { name: /^Audience:/ }));
    await chooseMantineSelectOption("Audience", "audience next");
    const popover = screen.getByTestId("document-metadata-popover-audience");
    expect(
      within(popover).getByRole("combobox", { name: "Audience", hidden: true }),
    ).toHaveProperty("disabled", true);
    expect(
      within(popover).getByRole("button", { name: "Delete", hidden: true }),
    ).toHaveProperty("disabled", true);
    expect(header.textContent).not.toContain("audience next");
    acknowledge!();
    await waitFor(() => expect(header.textContent).toContain("audience next"));
    fireEvent.click(
      within(popover).getAllByRole("button", {
        name: "Delete",
        hidden: true,
      })[0],
    );
    await waitFor(() =>
      expect(header.textContent).not.toContain("audience current"),
    );
    const writes = gql.mock.calls.filter(
      ([request]) => request.query.op === "setDocumentMetadata",
    );
    expect(writes.map(([request]) => request.variables?.input)).toEqual([
      { audienceIds: ["audience-current", "audience-next"] },
      { audienceIds: ["audience-next"] },
    ]);
    expect(
      within(header)
        .getByRole("button", { name: /^Audience:/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("does not publish a pending old-document save after its provider is disposed", async () => {
    const fixture = headerFixture();
    let acknowledge: (() => void) | undefined;
    const cache = {
      getModel: vi.fn(() => null),
      writeModel: vi.fn(),
      markStale: vi.fn(),
      invalidateIndex: vi.fn(),
    };
    renderEditor(
      (op, variables) => {
        if (op === "setDocumentMetadata")
          return new Promise((resolve) => {
            acknowledge = () => resolve(fixture.response(op, variables));
          });
        return fixture.response(op, variables);
      },
      { metadataCache: cache },
    );
    const header = await screen.findByTestId("document-metadata-header");
    cache.writeModel.mockClear();
    fireEvent.click(within(header).getByRole("button", { name: /^Language:/ }));
    await chooseMantineSelectOption("Language", "language next");
    cleanup();
    const next = headerFixture();
    renderEditor(
      (op, variables) =>
        op === "documentMetadataValidation"
          ? { documentMetadataValidation: baseValidation }
          : next.response(op, variables),
      { docId: "doc-2" },
    );
    await screen.findByTestId("document-metadata-header");
    await act(async () => acknowledge!());
    await waitFor(() =>
      expect(
        screen.getByTestId("document-metadata-header").textContent,
      ).toContain("language current"),
    );
    expect(cache.writeModel).not.toHaveBeenCalled();
    expect(cache.invalidateIndex).not.toHaveBeenCalled();
  });

  test("uses the declared transition writer for system-owned status rather than a raw patch", async () => {
    const fixture = headerFixture();
    const gql = renderEditor((op, variables) => {
      const response = fixture.response(op, variables) as any;
      return op === "documentMetadataFieldDefinitions"
        ? {
            documentMetadataFieldDefinitions:
              response.documentMetadataFieldDefinitions.map(
                (definition: any) =>
                  definition.key === "status"
                    ? {
                        ...definition,
                        editableBy: "admin_only",
                        metadata: { write: "transition_only" },
                      }
                    : definition,
              ),
          }
        : response;
    });
    const header = await screen.findByTestId("document-metadata-header");
    fireEvent.click(within(header).getByRole("button", { name: /^Status:/ }));
    const popover = await screen.findByTestId(
      "document-metadata-popover-status",
    );
    fireEvent.mouseDown(
      within(popover).getByRole("combobox", { name: "Status", hidden: true }),
    );
    expect(
      screen.queryAllByRole("option", { name: "No status", hidden: true }),
    ).toHaveLength(0);
    await chooseMantineSelectOption("Status", "status next");
    await waitFor(() => expect(header.textContent).toContain("status next"));
    const writes = gql.mock.calls.filter(([request]) =>
      ["setDocumentMetadata", "transitionDocumentStatus"].includes(
        request.query.op,
      ),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatchObject({
      query: { op: "transitionDocumentStatus" },
      variables: { input: { toStatusId: "status-next" } },
    });
  });

  test("renders workspace tags in their own row below metadata", async () => {
    const tag = {
      id: "tag-critical",
      value$: new LiveData("Critical"),
      color$: new LiveData("tag.red"),
    };
    renderEditor(undefined, {
      tagService: {
        tagList: {
          tagsByPageId$: () => new LiveData([tag]),
        },
      } as never,
    });

    const header = await screen.findByTestId("document-metadata-header");
    const tagList = await screen.findByTestId("document-metadata-tags");
    const tagChip = tagList.querySelector(
      '[data-myoxus-ui-role="document-metadata-tag-chip"]',
    ) as HTMLElement | null;
    const tagColor = tagChip?.querySelector(
      '[data-myoxus-ui-role="document-metadata-tag-color"]',
    ) as HTMLElement | null;
    const relativePosition = header.compareDocumentPosition(tagList);

    expect(header.textContent).toContain("Draft");
    expect(header.textContent).not.toContain("Critical");
    expect(tagList.textContent).toContain("Critical");
    expect(tagChip).not.toBeNull();
    expect(tagChip?.style.backgroundColor).toContain("--myoxus-tag-red");
    expect(tagColor?.style.backgroundColor).toContain(
      "--myoxus-palette-line-red",
    );
    expect(tagChip?.closest("ul")).toBe(tagList);
    expect(relativePosition & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  test("renders the selected three-tab document information structure", async () => {
    renderEditor(undefined, { detailsLayout: "dialog", showSummary: false });

    await screen.findByTestId("document-metadata-editor");
    expect(screen.queryByTestId("document-metadata-summary")).toBeNull();
    expect(screen.queryByTestId("document-metadata-toggle")).toBeNull();
    expect(screen.queryByTestId("document-metadata-more-toggle")).toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Edit",
      "Information",
      "System",
    ]);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Information",
    );
    const createdByRow = screen.getByTestId(
      "document-info-information-created-by",
    );
    expect(within(createdByRow).getByRole("rowheader").textContent).toBe(
      "Created by",
    );
    expect(createdByRow.textContent).toContain("Creator");

    fireEvent.click(screen.getByTestId("document-info-tab-edit"));
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Edit",
    );
  });

  test("information resolves retained creator and editor names outside operational membership", async () => {
    const read = vi.fn(async (id: string) => ({
      id,
      name: "Retained Author",
      email: "",
      avatarUrl: null,
    }));
    const framework = new Framework();
    framework.store(PublicUserStore, { getPublicUserById: read } as any);
    framework.service(PublicUserService, [PublicUserStore]);
    const provider = framework.provider();
    const profiles = provider.get(PublicUserService);
    renderEditor(
      (op) =>
        op === "getMembersByWorkspaceId"
          ? { workspace: { memberCount: 0, members: [] } }
          : undefined,
      { detailsLayout: "dialog", showSummary: false },
      profiles,
    );
    for (const field of ["created-by", "updated-by"]) {
      await waitFor(() => {
        expect(vi.mocked(console.warn).mock.calls).toEqual([]);
        expect(
          screen.getByTestId(`document-info-information-${field}`).textContent,
        ).toContain("Retained Author");
      });
      expect(
        screen.getByTestId(`document-info-information-${field}`).textContent,
      ).not.toContain("user-1");
    }
    expect(read).toHaveBeenCalledWith("user-1", expect.any(AbortSignal));
    expect(read).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  test("header label visibility overrides hide labels in the document header", async () => {
    renderEditor(undefined, {
      headerVisibilityOverrides: { status: false },
    });

    const header = await screen.findByTestId("document-metadata-header");
    expect(header.textContent).not.toContain("Draft");
    expect(header.textContent).toContain("Report");
    expect(header.textContent).toContain("v1");
  });

  test("server header visibility is an upper bound for personal overrides", async () => {
    renderEditor(
      (op) =>
        op === "documentMetadataFieldDefinitions"
          ? {
              documentMetadataFieldDefinitions: definitions.map((definition) =>
                definition.key === "documentType"
                  ? { ...definition, visibleInHeader: false }
                  : definition,
              ),
            }
          : undefined,
      {
        headerVisibilityOverrides: { documentType: true },
      },
    );

    const header = await screen.findByTestId("document-metadata-header");
    expect(header.textContent).toContain("Draft");
    expect(header.textContent).not.toContain("Report");
    expect(header.textContent).toContain("v1");
  });

  test("uses transitionDocumentStatus for status changes", async () => {
    const gql = renderEditor();
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));

    await chooseMantineSelectOption("Status", "Review");

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ op: "transitionDocumentStatus" }),
          variables: {
            workspaceId: "workspace-1",
            docId: "doc-1",
            input: { toStatusId: "status-review" },
          },
          context: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        }),
      ),
    );
  });

  test("uses setDocumentMetadata for normal native metadata fields", async () => {
    const gql = renderEditor();
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));

    await screen.findByTestId("document-metadata-field-classification");
    await chooseMantineSelectOption("Classification", "Internal");

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ op: "setDocumentMetadata" }),
          variables: {
            workspaceId: "workspace-1",
            docId: "doc-1",
            input: { classificationId: "class-internal" },
          },
          context: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        }),
      ),
    );
  });

  test("renders the document view as a system fact instead of a duplicate editor", async () => {
    renderEditor(undefined, { detailsLayout: "dialog", showSummary: false });
    await screen.findByTestId("document-info-tabs");
    fireEvent.click(screen.getByTestId("document-info-tab-system"));

    expect(
      screen.getByTestId("document-info-presentation-primary-mode").textContent,
    ).toContain("Page");
    expect(
      screen.queryByRole("combobox", {
        name: "Default view for this document",
      }),
    ).toBeNull();
  });

  test("invalidates the document-list metadata index after native field updates", async () => {
    const metadataCache = {
      getModel: vi.fn(() => null),
      writeModel: vi.fn(),
      markStale: vi.fn(),
      invalidateIndex: vi.fn(),
    };
    renderEditor(undefined, { metadataCache });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    await screen.findByTestId("document-metadata-field-classification");
    metadataCache.writeModel.mockClear();
    metadataCache.invalidateIndex.mockClear();

    await chooseMantineSelectOption("Classification", "Internal");

    await waitFor(() =>
      expect(metadataCache.writeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ docId: "doc-1" }),
        }),
        "setDocumentMetadata",
        "doc-1",
      ),
    );
    expect(metadataCache.invalidateIndex).toHaveBeenCalledTimes(1);
  });

  test("invalidates the document-list metadata index after status transitions", async () => {
    const metadataCache = {
      getModel: vi.fn(() => null),
      writeModel: vi.fn(),
      markStale: vi.fn(),
      invalidateIndex: vi.fn(),
    };
    renderEditor(undefined, { metadataCache });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    metadataCache.writeModel.mockClear();
    metadataCache.invalidateIndex.mockClear();

    await chooseMantineSelectOption("Status", "Review");

    await waitFor(() =>
      expect(metadataCache.writeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ docId: "doc-1" }),
        }),
        "transitionDocumentStatus",
        "doc-1",
      ),
    );
    expect(metadataCache.invalidateIndex).toHaveBeenCalledTimes(1);
  });

  test("reacts to canonical runtime-cache updates from other metadata consumers", async () => {
    const initialModel = await loadDocumentMetadataModel(
      {
        gql: ({ query, variables }: any) =>
          renderEditorLookupResponse(query.op, variables),
      } as never,
      "workspace-1",
      "doc-1",
    );
    const model$ = new LiveData<typeof initialModel | null>(initialModel);
    const metadataCache = {
      getModel: vi.fn(() => model$.value),
      watchModel: vi.fn(() => model$),
      hydrateModel: vi.fn(async () => model$.value!),
      writeModel: vi.fn(),
      markStale: vi.fn(),
      invalidateIndex: vi.fn(),
    };

    renderEditor(undefined, {
      detailsLayout: "dialog",
      metadataCache,
      showSummary: false,
    });

    const pageWidth = await screen.findByTestId(
      "document-info-presentation-page-width",
    );
    expect(pageWidth.textContent).toContain("standard");

    model$.next({
      ...initialModel,
      metadata: {
        ...initialModel.metadata,
        metadataRevision: initialModel.metadata.metadataRevision + 1,
        presentation: {
          primaryMode:
            initialModel.metadata.presentation?.primaryMode ?? "page",
          pageWidth: "fullWidth",
          edgelessColorTheme:
            initialModel.metadata.presentation?.edgelessColorTheme ?? null,
        },
      },
    });

    await waitFor(() => {
      expect(pageWidth.textContent).toContain("fullWidth");
    });
    expect(metadataCache.hydrateModel).toHaveBeenCalledTimes(1);
  });

  test("renders responsible as a workspace member select instead of raw UUID input", async () => {
    const gql = renderEditor();
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    const panel = await screen.findByTestId(
      "document-metadata-field-responsible",
    );

    expect(
      within(panel).getByRole("combobox", { name: "Responsible" }),
    ).toHaveProperty("value", "Ada Lovelace");

    await chooseMantineSelectOption("Responsible", "Grace Hopper");

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({ op: "setDocumentMetadata" }),
          variables: {
            workspaceId: "workspace-1",
            docId: "doc-1",
            input: { responsibleUserId: "user-3" },
          },
          context: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        }),
      ),
    );
  });

  test("keeps the current status visible when schema value lookup lags behind metadata", async () => {
    renderEditor((op) =>
      op === "documentStatusValues" ? { documentStatusValues: [] } : undefined,
    );
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    const panel = await screen.findByTestId("document-metadata-field-status");

    expect(
      within(panel).getByRole("combobox", { name: "Status" }),
    ).toHaveProperty("value", "Draft");
  });

  test("surfaces a malformed document-not-found response after one metadata request", async () => {
    class BrokenGraphQLError extends Error {
      override get message() {
        return undefined as never;
      }

      override toString() {
        return "Document not found";
      }
    }

    let metadataReads = 0;
    const gql = vi.fn(
      async ({
        query,
        variables,
      }: {
        query: { op: string };
        variables?: Record<string, unknown>;
      }) => {
        if (query.op === "documentMetadata") {
          metadataReads += 1;
          throw new BrokenGraphQLError();
        }
        return renderEditorLookupResponse(query.op, variables);
      },
    );

    await expect(
      loadDocumentMetadataModel({ gql } as never, "workspace-1", "doc-1"),
    ).rejects.toBeInstanceOf(BrokenGraphQLError);

    expect(metadataReads).toBe(1);
  });

  test("carries server projection version as native freshness signal", async () => {
    const model = await loadDocumentMetadataModel(
      {
        gql: ({
          query,
          variables,
        }: {
          query: { op: string };
          variables?: Record<string, unknown>;
        }) => renderEditorLookupResponse(query.op, variables),
      } as never,
      "workspace-1",
      "doc-1",
    );

    expect(model.state.projectionVersion).toBe(baseMetadata.projectionVersion);
    expect(model.state.metadataRevision).toBe(baseMetadata.metadataRevision);
    expect(model.state.metadataUpdatedAt).toBe(baseMetadata.metadataUpdatedAt);
    expect(model.state.metadataUpdatedAt).not.toBe(
      baseMetadata.system.updatedAt,
    );
  });

  test("only exposes workspace default settings action when permission gate allows it", async () => {
    const onConfigureWorkspaceDefaults = vi.fn();

    renderEditor(undefined, { onConfigureWorkspaceDefaults });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    expect(
      screen.queryByTestId("document-metadata-configure-defaults"),
    ).toBeNull();
    cleanup();

    renderEditor(undefined, {
      canConfigureWorkspaceDefaults: true,
      onConfigureWorkspaceDefaults,
    });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    fireEvent.click(
      await screen.findByTestId("document-metadata-configure-defaults"),
    );
    expect(onConfigureWorkspaceDefaults).toHaveBeenCalledTimes(1);
    cleanup();

    renderEditor(undefined, {
      canConfigureWorkspaceDefaults: true,
      onConfigureWorkspaceDefaults,
      readonly: true,
    });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    expect(
      screen.queryByTestId("document-metadata-configure-defaults"),
    ).toBeNull();
  });

  test("only exposes global policy navigation when global admin gate allows it", async () => {
    const onOpenGlobalPolicy = vi.fn();

    renderEditor(undefined, { onOpenGlobalPolicy });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    expect(
      screen.queryByTestId("document-metadata-open-global-policy"),
    ).toBeNull();
    cleanup();

    renderEditor(undefined, {
      canOpenGlobalPolicy: true,
      onOpenGlobalPolicy,
    });
    fireEvent.click(await screen.findByTestId("document-metadata-toggle"));
    fireEvent.click(
      await screen.findByTestId("document-metadata-open-global-policy"),
    );
    expect(onOpenGlobalPolicy).toHaveBeenCalledTimes(1);
  });
});
