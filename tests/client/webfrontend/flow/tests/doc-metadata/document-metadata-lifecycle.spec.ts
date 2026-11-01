/**
 * Document metadata lifecycle E2E.
 *
 * Covers the real user path from a newly created document through canonical
 * editor metadata fields and status transitions. Setup and cleanup use GraphQL/HTTP
 * APIs only; the suite deletes the generated workspace before removing the
 * temporary user.
 */
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

import {
  apiSignIn,
  type ApiUser,
  createTestUser,
  ensureAdminUser,
  FRONTEND_BASE,
  gqlRequest,
  injectSessionCookies,
} from "../../../../adminfrontend/e2e/fixtures/auth";
import { deleteWorkspace } from "../../../../adminfrontend/e2e/fixtures/workspaces";

interface WorkspaceListResponse {
  workspaces: Array<{ id: string }>;
}

interface WorkspaceDocsResponse {
  workspace: {
    docs: {
      edges: Array<{ node: { id: string; title: string } }>;
    };
  };
}

interface DeleteUserResponse {
  admin: { deleteUser: { success: boolean } };
}

interface StatusSchemasResponse {
  documentStatusSchemas: Array<{ id: string; key: string }>;
}

interface StatusValuesResponse {
  documentStatusValues: Array<{ id: string; key: string; label: string }>;
}

interface DocumentTypesResponse {
  documentTypes: Array<{
    id: string;
    key: string;
    label: string;
    isActive: boolean;
  }>;
}

interface MetadataValuesResponse {
  documentMetadataValueDefinitions: Array<{
    id: string;
    key: string;
    label: string;
    isActive: boolean;
  }>;
}

interface MetadataFieldsResponse {
  documentMetadataFieldDefinitions: Array<{
    key: string;
    visibleInProperties: boolean;
    visibleInHeader: boolean;
    editableBy: string;
  }>;
}

interface WorkspaceSettingsResponse {
  updateWorkspaceDocumentSettings: {
    workspaceId: string;
    statusSchemaId: string | null;
    defaultStatusId: string | null;
  };
}

interface DocumentMetadataResponse {
  documentMetadata: {
    docId: string;
    projectionMode: string;
    projectionVersion: string;
    metadataRevision: number;
    fields: Array<{
      key: string;
      reference: { id: string; key: string; label: string } | null;
      textValue: string | null;
      timestampValue: string | null;
      userId: string | null;
    }>;
    audience: Array<{
      value: { id: string; key: string; label: string };
    }>;
  };
}

interface DocumentVersionsResponse {
  documentVersions: Array<{
    id: string;
    label: string;
    event: string;
    kind: string;
  }>;
}

let user: ApiUser;
let userCookies: string[];
let workspaceId: string;
let originalVisibility: MetadataFieldsResponse["documentMetadataFieldDefinitions"] =
  [];

const ALL_PROPERTY_METADATA_KEYS = [
  "status",
  "documentType",
  "version",
  "responsible",
  "reviewDueAt",
  "validFrom",
  "validUntil",
  "classification",
  "documentNumber",
  "language",
  "audience",
  "retentionPolicy",
];

const PRIMARY_PROPERTY_METADATA_KEYS = [
  "status",
  "documentType",
  "version",
  "classification",
  "documentNumber",
  "responsible",
  "reviewDueAt",
  "validUntil",
];

const SECONDARY_PROPERTY_METADATA_KEYS = ALL_PROPERTY_METADATA_KEYS.filter(
  (key) => !PRIMARY_PROPERTY_METADATA_KEYS.includes(key),
);

function preferredActiveValue(
  values: MetadataValuesResponse["documentMetadataValueDefinitions"],
  preferredKeys: string[],
) {
  const active = values.filter((value) => value.isActive);
  return (
    preferredKeys
      .map((key) => active.find((value) => value.key === key))
      .find(Boolean) ?? active[0]
  );
}

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function deleteTestUserStrict(
  request: APIRequestContext,
  userId: string,
): Promise<void> {
  const data = await gqlRequest<DeleteUserResponse>(
    request,
    `mutation DeleteDocMetadataLifecycleUser($id: String!) {
       admin { deleteUser(id: $id) { success } }
     }`,
    { id: userId },
  );
  expect(data.admin.deleteUser.success).toBe(true);
}

async function clickFirstVisible(
  page: Page,
  selectors: string[],
): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await locator.click();
      return;
    }
  }
  throw new Error(`No visible locator found: ${selectors.join(", ")}`);
}

async function dismissOpenInAppOverlay(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content: `[data-testid="open-in-app-card"] { display: none !important; pointer-events: none !important; }`,
    })
    .catch(() => undefined);
  const dismissButton = page.getByRole("button", { name: "Dismiss" });
  if (await dismissButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await dismissButton
      .click()
      .catch(async () => page.keyboard.press("Escape"));
  }
}

async function createWorkspacePage(
  request: APIRequestContext,
  page: Page,
  targetWorkspaceId: string,
  title: string,
): Promise<string> {
  await page.goto(`${FRONTEND_BASE}/workspace/${targetWorkspaceId}/all`, {
    waitUntil: "load",
  });
  await dismissOpenInAppOverlay(page);
  await page.waitForSelector(
    '[data-testid="sidebar-new-page-button"], [data-testid="new-page-button-trigger"]',
    { timeout: 30_000 },
  );
  await clickFirstVisible(page, [
    '[data-testid="sidebar-new-page-button"]',
    '[data-testid="new-page-button-trigger"]',
  ]);
  await page.waitForURL(
    (url) => !url.pathname.endsWith(`/${targetWorkspaceId}/all`),
    {
      timeout: 20_000,
    },
  );

  const titleEditor = page.locator("doc-title .inline-editor").first();
  await expect(titleEditor).toBeVisible({ timeout: 20_000 });
  await titleEditor.fill(title);
  await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForSelector("v-line", { timeout: 20_000 });
  await dismissOpenInAppOverlay(page);

  const segments = new URL(page.url()).pathname.split("/").filter(Boolean);
  const workspaceRouteIndex = segments.findIndex(
    (segment, index) =>
      segment === "workspace" && segments[index + 1] === targetWorkspaceId,
  );
  const routeId =
    workspaceRouteIndex >= 0 ? segments[workspaceRouteIndex + 2] : undefined;
  // Cloud document IDs are not UUID-only; newly created docs commonly use
  // compact URL-safe IDs, so only reject known workspace collection routes.
  if (routeId && !["all", "journals"].includes(routeId)) {
    return routeId;
  }

  const docs = await gqlRequest<WorkspaceDocsResponse>(
    request,
    `query DocMetadataLifecycleResolveDoc($workspaceId: String!) {
       workspace(id: $workspaceId) {
         docs(pagination: { first: 50 }) {
           edges { node { id title } }
         }
       }
     }`,
    { workspaceId: targetWorkspaceId },
  );
  const docId = docs.workspace.docs.edges
    .map((edge) => edge.node)
    .find((doc) => doc.title === title)?.id;
  if (!docId) {
    throw new Error(`Could not derive doc id from URL/title: ${page.url()}`);
  }
  return docId;
}

async function configureReviewSchema(
  request: APIRequestContext,
  targetWorkspaceId: string,
): Promise<void> {
  const schemas = await gqlRequest<StatusSchemasResponse>(
    request,
    `query DocMetadataLifecycleSchemas { documentStatusSchemas { id key } }`,
  );
  const review = schemas.documentStatusSchemas.find(
    (schema) => schema.key === "review",
  );
  if (!review) throw new Error("Missing review document status schema");
  const reviewStatuses = await gqlRequest<StatusValuesResponse>(
    request,
    `query DocMetadataLifecycleReviewStatuses {
       documentStatusValues(schemaKey: "review") { id key label }
     }`,
  );
  const draft = reviewStatuses.documentStatusValues.find(
    (status) => status.key === "draft",
  );
  if (!draft) throw new Error("Missing review draft document status");

  const updated = await gqlRequest<WorkspaceSettingsResponse>(
    request,
    `mutation UseReviewStatusSchema($workspaceId: ID!, $input: UpdateWorkspaceDocumentSettingsInput!) {
       updateWorkspaceDocumentSettings(workspaceId: $workspaceId, input: $input) {
         workspaceId
         statusSchemaId
         defaultStatusId
       }
    }`,
    {
      workspaceId: targetWorkspaceId,
      input: { statusSchemaId: review.id, defaultStatusId: draft.id },
    },
  );
  expect(updated.updateWorkspaceDocumentSettings.statusSchemaId).toBe(
    review.id,
  );
  expect(updated.updateWorkspaceDocumentSettings.defaultStatusId).toBe(
    draft.id,
  );
}

async function ensureLifecycleMetadataVisible(
  request: APIRequestContext,
): Promise<void> {
  const definitions = await gqlRequest<MetadataFieldsResponse>(
    request,
    `query DocMetadataLifecycleDefinitions {
       documentMetadataFieldDefinitions { key visibleInProperties visibleInHeader editableBy }
     }`,
  );
  originalVisibility = definitions.documentMetadataFieldDefinitions
    .filter((definition) => ALL_PROPERTY_METADATA_KEYS.includes(definition.key))
    .map((definition) => ({
      key: definition.key,
      visibleInProperties: definition.visibleInProperties,
      visibleInHeader: definition.visibleInHeader,
      editableBy: definition.editableBy,
    }));

  for (const key of ALL_PROPERTY_METADATA_KEYS) {
    await gqlRequest(
      request,
      `mutation EnableLifecycleAttributeForE2E($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) {
         admin {
           updateDocumentMetadataFieldDefinition(input: $input) {
             key
             visibleInProperties
           }
         }
       }`,
      {
        input: {
          key,
          visibleInProperties: true,
          visibleInHeader: true,
          ...([
            "status",
            "documentType",
            "classification",
            "language",
            "audience",
            "retentionPolicy",
            "responsible",
          ].includes(key)
            ? { editableBy: "editor" }
            : {}),
        },
      },
    );
  }
}

async function restoreLifecycleMetadataVisibility(
  request: APIRequestContext,
): Promise<void> {
  for (const definition of originalVisibility) {
    await gqlRequest(
      request,
      `mutation RestoreLifecycleAttributeForE2E($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) {
         admin {
           updateDocumentMetadataFieldDefinition(input: $input) {
             key
             visibleInProperties
           }
         }
       }`,
      {
        input: {
          key: definition.key,
          visibleInProperties: definition.visibleInProperties,
          visibleInHeader: definition.visibleInHeader,
          editableBy: definition.editableBy,
        },
      },
    );
  }
}

async function loadLifecycleLookups(request: APIRequestContext) {
  const [
    statuses,
    types,
    classifications,
    audiences,
    retentionPolicies,
    languages,
  ] = await Promise.all([
    gqlRequest<StatusValuesResponse>(
      request,
      `query DocMetadataLifecycleStatuses { documentStatusValues(schemaKey: "review") { id key label } }`,
    ),
    gqlRequest<DocumentTypesResponse>(
      request,
      `query DocMetadataLifecycleTypes { documentTypes { id key label isActive } }`,
    ),
    gqlRequest<MetadataValuesResponse>(
      request,
      `query DocMetadataLifecycleClassifications($fieldKey: String!) {
         documentMetadataValueDefinitions(fieldKey: $fieldKey) { id key label isActive }
      }`,
      { fieldKey: "classification" },
    ),
    gqlRequest<MetadataValuesResponse>(
      request,
      `query DocMetadataLifecycleAudiences($fieldKey: String!) {
         documentMetadataValueDefinitions(fieldKey: $fieldKey) { id key label isActive }
       }`,
      { fieldKey: "audience" },
    ),
    gqlRequest<MetadataValuesResponse>(
      request,
      `query DocMetadataLifecycleRetentionPolicies($fieldKey: String!) {
         documentMetadataValueDefinitions(fieldKey: $fieldKey) { id key label isActive }
       }`,
      { fieldKey: "retentionPolicy" },
    ),
    gqlRequest<MetadataValuesResponse>(
      request,
      `query DocMetadataLifecycleLanguages($fieldKey: String!) {
         documentMetadataValueDefinitions(fieldKey: $fieldKey) { id key label isActive }
       }`,
      { fieldKey: "language" },
    ),
  ]);
  const inReview = statuses.documentStatusValues.find(
    (status) => status.key === "in_review",
  );
  const approved = statuses.documentStatusValues.find(
    (status) => status.key === "approved",
  );
  const docType =
    types.documentTypes.find(
      (type) => type.key === "internal_documentation" && type.isActive,
    ) ?? types.documentTypes.find((type) => type.isActive);
  const classification =
    classifications.documentMetadataValueDefinitions.find(
      (value) => value.key === "internal" && value.isActive,
    ) ??
    classifications.documentMetadataValueDefinitions.find(
      (value) => value.isActive,
    );
  const audienceValues =
    audiences.documentMetadataValueDefinitions.filter(
      (value) => value.isActive && value.key !== "internal",
    ).length >= 2
      ? audiences.documentMetadataValueDefinitions.filter(
          (value) => value.isActive && value.key !== "internal",
        )
      : audiences.documentMetadataValueDefinitions.filter(
          (value) => value.isActive,
        );
  const retentionPolicy = preferredActiveValue(
    retentionPolicies.documentMetadataValueDefinitions,
    ["long_term", "archive", "short_lived", "standard"],
  );
  const language = preferredActiveValue(
    languages.documentMetadataValueDefinitions,
    ["de", "fr", "es", "en"],
  );
  if (
    !inReview ||
    !approved ||
    !docType ||
    !classification ||
    audienceValues.length < 2 ||
    !retentionPolicy ||
    !language
  ) {
    throw new Error("Missing document-metadata lifecycle lookup values");
  }
  return {
    inReview,
    approved,
    docType,
    classification,
    audienceValues,
    retentionPolicy,
    language,
  };
}

interface NativeDocumentMetadataState {
  statusId: string | null;
  typeId: string | null;
  classificationId: string | null;
  responsibleUserId: string | null;
  reviewDueAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  documentNumber: string | null;
  languageId: string | null;
  audienceIds: string[];
  retentionPolicyId: string | null;
  currentVersionId: string | null;
  currentVersionLabel: string | null;
}

async function readDocumentMetadata(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
): Promise<DocumentMetadataResponse["documentMetadata"]> {
  const res = await request.post(`${FRONTEND_BASE}/graphql`, {
    data: {
      query: `query DocMetadataLifecycleMetadata($workspaceId: ID!, $docId: ID!) {
       documentMetadata(workspaceId: $workspaceId, docId: $docId, requestedProjectionMode: MYOXUS_NATIVE) {
         docId
         projectionMode
         projectionVersion
         metadataRevision
         fields {
           key
           reference { id key label }
           textValue
           timestampValue
           userId
         }
         audience {
           value { id key label }
         }
       }
     }`,
      variables: { workspaceId, docId },
    },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(userCookies),
      "x-myoxus-client": "web-flow",
      "x-myoxus-client-format": "myoxus-native",
      "x-myoxus-client-capabilities": "document-metadata",
    },
  });
  if (!res.ok()) {
    throw new Error(`GraphQL HTTP ${res.status()}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: DocumentMetadataResponse;
    errors?: unknown[];
  };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) {
    throw new Error("GraphQL response did not contain document metadata");
  }
  const response = body.data;
  expect(response.documentMetadata.projectionMode).toBe("MYOXUS_NATIVE");
  return response.documentMetadata;
}

function metadataField(
  metadata: DocumentMetadataResponse["documentMetadata"],
  key: string,
) {
  return metadata.fields.find((field) => field.key === key);
}

function stateFromMetadata(
  metadata: DocumentMetadataResponse["documentMetadata"],
): NativeDocumentMetadataState {
  const status = metadataField(metadata, "status");
  const type = metadataField(metadata, "documentType");
  const classification = metadataField(metadata, "classification");
  const responsible = metadataField(metadata, "responsible");
  const reviewDueAt = metadataField(metadata, "reviewDueAt");
  const validFrom = metadataField(metadata, "validFrom");
  const validUntil = metadataField(metadata, "validUntil");
  const documentNumber = metadataField(metadata, "documentNumber");
  const language = metadataField(metadata, "language");
  const retentionPolicy = metadataField(metadata, "retentionPolicy");
  const version = metadataField(metadata, "version");

  return {
    statusId: status?.reference?.id ?? null,
    typeId: type?.reference?.id ?? null,
    classificationId: classification?.reference?.id ?? null,
    responsibleUserId: responsible?.userId ?? null,
    reviewDueAt: reviewDueAt?.timestampValue ?? null,
    validFrom: validFrom?.timestampValue ?? null,
    validUntil: validUntil?.timestampValue ?? null,
    documentNumber: documentNumber?.textValue ?? null,
    languageId: language?.reference?.id ?? null,
    audienceIds: metadata.audience.map((entry) => entry.value.id),
    retentionPolicyId: retentionPolicy?.reference?.id ?? null,
    currentVersionId: version?.reference?.id ?? null,
    currentVersionLabel: version?.reference?.label ?? null,
  };
}

async function waitForMetadataState(
  request: APIRequestContext,
  docId: string,
  predicate: (state: NativeDocumentMetadataState) => boolean,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = stateFromMetadata(
          await readDocumentMetadata(request, workspaceId, docId),
        );
        return predicate(state);
      },
      { timeout: 15_000, message },
    )
    .toBe(true);
}

function reviewDateLocal(): string {
  return dateTimeLocalOffsetDays(7);
}

function dateTimeLocalOffsetDays(days: number): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  date.setDate(date.getDate() + (days - 7));
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function waitForGraphqlMutation(
  page: Page,
  operation: "setDocumentMetadata" | "transitionDocumentStatus",
  action: () => Promise<void>,
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/graphql") &&
      response.request().postData()?.includes(operation) === true,
    { timeout: 15_000 },
  );
  await action();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body?.errors ?? []).toEqual([]);
  const validation =
    body?.data?.transitionDocumentStatus?.validation ??
    body?.data?.setDocumentMetadata?.validation;
  if (validation) {
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
  }
}

async function selectMetadataOption(
  page: Page,
  metadataKey: string,
  optionLabel: string,
): Promise<void> {
  const row = page.getByTestId(`document-metadata-field-${metadataKey}`);
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function openDocumentMetadataEditor(page: Page): Promise<void> {
  await page.getByTestId("header-dropDownButton").click();
  await page.getByTestId("editor-option-menu-info").click();
  const dialog = page.getByTestId("document-metadata-dialog");
  await expect(dialog).toBeVisible();
  const editor = dialog.getByTestId("document-metadata-editor");
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId("document-info-tab-edit").click();
}

async function fillBlurredInput(
  page: Page,
  metadataKey: string,
  value: string,
  selector = "input",
): Promise<void> {
  await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
    const input = page
      .getByTestId(`document-metadata-field-${metadataKey}`)
      .locator(selector);
    await input.fill(value);
    await input.blur();
  });
}

async function createNamedVersion(
  request: APIRequestContext,
  workspaceId: string,
  docId: string,
  label: string,
): Promise<{ id: string; label: string }> {
  const data = await gqlRequest<{
    createDocumentVersion: { id: string; label: string };
  }>(
    request,
    `mutation CreateDocMetadataLifecycleVersion($workspaceId: ID!, $docId: ID!, $label: String!) {
       createDocumentVersion(workspaceId: $workspaceId, docId: $docId, label: $label) { id label }
     }`,
    { workspaceId, docId, label },
  );
  expect(data.createDocumentVersion.id).toBeTruthy();
  expect(data.createDocumentVersion.label).toBeTruthy();
  return data.createDocumentVersion;
}

test.describe.serial("Document metadata lifecycle E2E", () => {
  test.setTimeout(150_000);

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request);
    user = await createTestUser(request, {
      name: "Doc Metadata Lifecycle E2E",
    });
    await ensureLifecycleMetadataVisible(request);
    userCookies = await apiSignIn(request, user.email, user.password);
    const workspaces = await gqlRequest<WorkspaceListResponse>(
      request,
      `query DocMetadataLifecycleWorkspaces { workspaces { id } }`,
    );
    workspaceId = workspaces.workspaces[0]?.id;
    if (!workspaceId)
      throw new Error("Temporary lifecycle user has no workspace");
    await configureReviewSchema(request, workspaceId);
  });

  test.afterAll(async ({ request }) => {
    await ensureAdminUser(request);
    await restoreLifecycleMetadataVisibility(request);
    if (workspaceId) await deleteWorkspace(request, workspaceId);
    if (user?.id) await deleteTestUserStrict(request, user.id);
  });

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.localStorage.setItem("app_config", '{"onBoarding":false}');
      window.localStorage.setItem(
        "global-state:open-link-mode",
        '"open-in-web"',
      );
      window.localStorage.setItem("is-first-open", "false");
      window.localStorage.setItem("dismissAiOnboarding", "true");
      window.localStorage.setItem("dismissAiOnboardingEdgeless", "true");
      window.localStorage.setItem("dismissAiOnboardingLocal", "true");
    });
    await injectSessionCookies(context, userCookies);
  });

  test("P-DOC-ATTR-I-01: user sets fields and approval transition creates a version", async ({
    page,
    request,
  }) => {
    await apiSignIn(request, user.email, user.password);
    const lookups = await loadLifecycleLookups(request);
    const suffix = Date.now().toString(36);
    const docId = await createWorkspacePage(
      request,
      page,
      workspaceId,
      `Doc Metadata Lifecycle ${suffix}`,
    );

    await openDocumentMetadataEditor(page);
    await expect(
      page.getByTestId("document-metadata-field-status").getByRole("combobox"),
    ).toBeVisible({ timeout: 15_000 });
    await waitForMetadataState(
      request,
      docId,
      (state) => Boolean(state.statusId),
      "wait for effective initial status",
    );

    await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
      await selectMetadataOption(page, "documentType", lookups.docType.label);
    });
    await waitForMetadataState(
      request,
      docId,
      (state) => state.typeId === lookups.docType.id,
      "wait for document type",
    );

    await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
      await selectMetadataOption(
        page,
        "classification",
        lookups.classification.label,
      );
    });
    await waitForMetadataState(
      request,
      docId,
      (state) => state.classificationId === lookups.classification.id,
      "wait for classification",
    );

    const reviewAt = reviewDateLocal();
    await fillBlurredInput(page, "reviewDueAt", reviewAt);
    await waitForMetadataState(
      request,
      docId,
      (state) => Boolean(state.reviewDueAt),
      "wait for review date",
    );

    await waitForGraphqlMutation(page, "transitionDocumentStatus", async () => {
      await selectMetadataOption(page, "status", lookups.inReview.label);
    });
    await waitForMetadataState(
      request,
      docId,
      (state) => state.statusId === lookups.inReview.id,
      "wait for in_review status",
    );

    await waitForGraphqlMutation(page, "transitionDocumentStatus", async () => {
      await selectMetadataOption(page, "status", lookups.approved.label);
    });
    await waitForMetadataState(
      request,
      docId,
      (state) =>
        state.statusId === lookups.approved.id &&
        Boolean(state.currentVersionId),
      "wait for approved status and current version",
    );

    const versions = await gqlRequest<DocumentVersionsResponse>(
      request,
      `query DocMetadataLifecycleVersions($workspaceId: ID!, $docId: ID!) {
         documentVersions(workspaceId: $workspaceId, docId: $docId) { id label event kind }
       }`,
      { workspaceId, docId },
    );
    expect(
      versions.documentVersions.some(
        (version) => version.event === "manual" && version.kind === "published",
      ),
    ).toBe(true);
  });

  test("P-DOC-ATTR-I-01b: all canonical editor metadata fields persist through the UI contract", async ({
    page,
    request,
  }) => {
    await apiSignIn(request, user.email, user.password);
    const lookups = await loadLifecycleLookups(request);
    const suffix = Date.now().toString(36);
    const docId = await createWorkspacePage(
      request,
      page,
      workspaceId,
      `Doc Metadata Full Matrix ${suffix}`,
    );
    await openDocumentMetadataEditor(page);

    for (const key of PRIMARY_PROPERTY_METADATA_KEYS) {
      await expect(
        page.getByTestId(`document-metadata-field-${key}`),
      ).toBeVisible({
        timeout: 15_000,
      });
    }
    for (const key of SECONDARY_PROPERTY_METADATA_KEYS) {
      await expect(
        page.getByTestId(`document-metadata-field-${key}`),
      ).toBeVisible({
        timeout: 15_000,
      });
    }
    await expect(
      page.getByTestId("document-metadata-field-version").locator("input"),
    ).toBeDisabled();
    await waitForMetadataState(
      request,
      docId,
      (state) => Boolean(state.statusId),
      "wait for effective initial status before full metadata-field matrix",
    );

    await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
      await selectMetadataOption(page, "documentType", lookups.docType.label);
    });
    await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
      await selectMetadataOption(
        page,
        "classification",
        lookups.classification.label,
      );
    });
    await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
      await selectMetadataOption(
        page,
        "retentionPolicy",
        lookups.retentionPolicy.label,
      );
    });
    await expect(
      page
        .getByTestId("document-metadata-field-responsible")
        .getByRole("combobox"),
    ).toHaveValue(user.name);

    const reviewAt = reviewDateLocal();
    const validFrom = dateTimeLocalOffsetDays(1);
    const validUntil = dateTimeLocalOffsetDays(30);
    await fillBlurredInput(page, "reviewDueAt", reviewAt);
    await fillBlurredInput(page, "validFrom", validFrom);
    await fillBlurredInput(page, "validUntil", validUntil);

    const documentNumber = `E2E-DOC-${suffix.toUpperCase()}`;
    const language = lookups.language;
    const selectedAudienceValues = lookups.audienceValues.slice(0, 2);
    const audienceIds = selectedAudienceValues.map((value) => value.id);
    await fillBlurredInput(page, "documentNumber", documentNumber);
    // Reuse the document's provider from the header, then read back in Details.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator('button[data-metadata-key="language"]').click();
    await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
      await page
        .getByTestId("document-metadata-popover-language")
        .getByRole("combobox")
        .click();
      await page
        .getByRole("option", { name: language.label, exact: true })
        .click();
    });
    await expect(
      page.getByTestId("document-metadata-popover-language"),
    ).toBeHidden();
    await expect(page.locator('[data-metadata-key="language"]')).toContainText(
      language.label,
    );
    await page.locator('button[data-metadata-key="audience"]').click();
    for (const audience of selectedAudienceValues) {
      await waitForGraphqlMutation(page, "setDocumentMetadata", async () => {
        await page
          .getByTestId("document-metadata-popover-audience")
          .getByRole("combobox")
          .click();
        await page
          .getByRole("option", { name: audience.label, exact: true })
          .click();
      });
      await waitForMetadataState(
        request,
        docId,
        (state) => state.audienceIds.includes(audience.id),
        `wait for audience value ${audience.key}`,
      );
    }

    await expect(
      page.getByTestId("document-metadata-popover-audience"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator('button[data-metadata-key="status"]').click();
    await waitForGraphqlMutation(page, "transitionDocumentStatus", async () => {
      await page
        .getByTestId("document-metadata-popover-status")
        .getByRole("combobox")
        .click();
      await page
        .getByRole("option", { name: lookups.inReview.label, exact: true })
        .click();
    });
    await expect(
      page.getByTestId("document-metadata-popover-status"),
    ).toBeHidden();
    await openDocumentMetadataEditor(page);
    await expect(
      page
        .getByTestId("document-metadata-field-language")
        .getByRole("combobox"),
    ).toHaveValue(language.label);

    await waitForMetadataState(
      request,
      docId,
      (state) =>
        state.statusId === lookups.inReview.id &&
        state.typeId === lookups.docType.id &&
        state.classificationId === lookups.classification.id &&
        state.retentionPolicyId === lookups.retentionPolicy.id &&
        state.documentNumber === documentNumber &&
        state.languageId === language.id &&
        audienceIds.every((id) => state.audienceIds.includes(id)) &&
        state.responsibleUserId === user.id &&
        Boolean(state.reviewDueAt) &&
        Boolean(state.validFrom) &&
        Boolean(state.validUntil),
      "wait for all canonical metadata values",
    );

    const version = await createNamedVersion(
      request,
      workspaceId,
      docId,
      `full-matrix-${suffix}`,
    );
    const editor = page.getByTestId("document-metadata-editor");
    await editor.getByRole("button", { name: "Refresh" }).click();
    await expect
      .poll(
        async () =>
          stateFromMetadata(
            await readDocumentMetadata(request, workspaceId, docId),
          ).currentVersionId,
        { timeout: 15_000, message: "wait for current version metadata field" },
      )
      .toBe(version.id);
    await expect(
      page.getByTestId("document-metadata-field-version").locator("input"),
    ).toHaveValue(new RegExp(version.label));
  });
});
