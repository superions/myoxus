// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  waitForWorkspaceReady,
} from "../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ??
  process.env.E2E_BASE_URL ??
  "http://localhost:3010";
const API = process.env.E2E_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;

const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /ReferenceError/i,
  /index error, retry in 5s/i,
  /blocks is not defined/i,
  /VirgultumError/i,
  /block id is not found/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];

type DeletionProbeWindow = {
  currentWorkspace: {
    docs: {
      store: {
        documentLifecycle: {
          signal(docId: string): AbortSignal;
          state(docId: string): string;
        };
      };
    };
    engine: {
      doc: {
        storage: {
          subscribeDocDelete(callback: (docId: string) => void): () => void;
        };
      };
    };
  };
  __myoxusDeletionProbe?: {
    signal: AbortSignal;
    off: () => void;
    deleted?: { aborted: boolean; state: string };
  };
};

async function captureDeletionGeneration(page: Page, docId: string) {
  return page.evaluate((id) => {
    const target = window as unknown as DeletionProbeWindow;
    const workspace = target.currentWorkspace;
    const lifecycle = workspace.docs.store.documentLifecycle;
    const probe: NonNullable<DeletionProbeWindow["__myoxusDeletionProbe"]> = {
      signal: lifecycle.signal(id),
      off: () => {},
    };
    // Observe the real purge without changing product state. A quiet window
    // alone can be green because a route disposed its last request consumer.
    probe.off = workspace.engine.doc.storage.subscribeDocDelete((deletedId) => {
      if (deletedId === id) {
        probe.deleted = {
          aborted: probe.signal.aborted,
          state: lifecycle.state(id),
        };
      }
    });
    target.__myoxusDeletionProbe = probe;
    return lifecycle.state(id);
  }, docId);
}

type MetadataField = {
  key: string;
  textValue: string | null;
};

type MetadataProjection = {
  docId: string;
  projectionMode: string;
  projectionVersion: string;
  metadataRevision: number;
  fields: MetadataField[];
};

type MetadataQueryData = {
  documentMetadata: MetadataProjection;
};

type SetMetadataData = {
  setDocumentMetadata: {
    metadata: MetadataProjection;
  };
};

type PageMetaData = {
  workspace: {
    pageMeta: {
      updatedAt: string;
    } | null;
  } | null;
};

type PermanentDeleteData = {
  deleteDocumentsPermanently: {
    alreadyDeleted: number;
    deleted: number;
    failed: number;
    forbidden: number;
    rootMetaRemoved: number;
  };
};

type WorkspaceDocsData = {
  workspace: {
    docs: {
      edges: Array<{ node: { id: string; title?: string } }>;
    };
  } | null;
};

type MutationCapabilityData = {
  __type: {
    fields: Array<{ name: string }>;
  } | null;
};

type ObservedGraphqlResponse = {
  body: unknown;
  postData: string;
  requestHeaders: Record<string, string>;
  status: number;
  url: string;
};

type ObservedGraphqlRequest = {
  postData: string;
};

function cookieHeader(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function collectFatalErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return () => errors;
}

function collectGraphqlResponses(page: Page): ObservedGraphqlResponse[] {
  const responses: ObservedGraphqlResponse[] = [];
  page.on("response", (response) => {
    if (!response.url().endsWith("/graphql")) return;
    if (response.request().method() !== "POST") return;

    void (async () => {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      responses.push({
        body,
        postData: response.request().postData() ?? "",
        requestHeaders: response.request().headers(),
        status: response.status(),
        url: response.url(),
      });
    })();
  });
  return responses;
}

function collectGraphqlRequests(page: Page): ObservedGraphqlRequest[] {
  const requests: ObservedGraphqlRequest[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/graphql") || request.method() !== "POST") {
      return;
    }
    requests.push({
      postData: request.postData() ?? "",
    });
  });
  return requests;
}

function isDocumentLifecycleRequest(postData: string, docId: string): boolean {
  const normalized = postData.toLowerCase();
  return (
    normalized.includes(docId.toLowerCase()) &&
    [
      "documentmetadata",
      "listcomments",
      "listcommentchanges",
      "documentlinks",
    ].some((operation) => normalized.includes(operation))
  );
}

function observedMetadata(
  response: ObservedGraphqlResponse,
): MetadataProjection | null {
  const body = response.body as {
    data?: MetadataQueryData;
    errors?: unknown[];
  };
  if (body?.errors?.length) return null;
  return body?.data?.documentMetadata ?? null;
}

async function waitForObservedMetadata(
  responses: ObservedGraphqlResponse[],
  docId: string,
  minimumMetadataRevision: number,
  documentNumber: string,
): Promise<ObservedGraphqlResponse> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const match = responses.find((response) => {
      const metadata = observedMetadata(response);
      return (
        metadata?.docId === docId &&
        metadata.projectionMode === "MYOXUS_NATIVE" &&
        metadata.metadataRevision >= minimumMetadataRevision &&
        documentNumberFrom(metadata) === documentNumber
      );
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const summary = responses.map((response) => ({
    bodyPreview: JSON.stringify(response.body).slice(0, 500),
    hasDocumentMetadataPost: response.postData.includes("documentMetadata"),
    hasDocIdPost: response.postData.includes(docId),
    metadata: observedMetadata(response),
    postDataPreview: response.postData.slice(0, 500),
    requestHeaders: {
      "x-myoxus-client": response.requestHeaders["x-myoxus-client"],
      "x-myoxus-client-format":
        response.requestHeaders["x-myoxus-client-format"],
    },
    status: response.status,
    url: response.url,
  }));
  throw new Error(
    `No browser documentMetadata response for ${docId} at revision >= ${minimumMetadataRevision} with document number ${documentNumber}. Observed: ${JSON.stringify(summary)}`,
  );
}

async function injectCookies(
  context: BrowserContext,
  rawCookies: string[],
): Promise<void> {
  for (const raw of rawCookies) {
    const nameVal = raw.split(";")[0];
    const [name, ...rest] = nameVal.split("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: rest.join("=").trim(),
        url: FRONTEND,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
  }
}

async function nativeGql<T>(
  request: APIRequestContext,
  cookies: string[],
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post(GQL, {
    data: { query, variables },
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(cookies),
      "x-myoxus-client": "web-smoke",
      "x-myoxus-client-format": "myoxus-native",
      "x-myoxus-client-capabilities": "document-metadata",
    },
    timeout: 15_000,
  });
  if (!response.ok()) {
    throw new Error(
      `GraphQL HTTP ${response.status()}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("GraphQL response did not contain data");
  return body.data;
}

async function readMetadata(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<MetadataProjection> {
  const data = await nativeGql<MetadataQueryData>(
    request,
    cookies,
    `query MetadataFreshness($workspaceId: ID!, $docId: ID!) {
      documentMetadata(
        workspaceId: $workspaceId,
        docId: $docId,
        requestedProjectionMode: MYOXUS_NATIVE
      ) {
        docId
        projectionMode
        projectionVersion
        metadataRevision
        fields { key textValue }
      }
    }`,
    { workspaceId, docId },
  );
  return data.documentMetadata;
}

async function readMetadataWithRetry(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<MetadataProjection> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await readMetadata(request, cookies, workspaceId, docId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Metadata did not materialize for ${docId}`);
}

async function requirePermanentDeleteCleanupSupport(
  request: APIRequestContext,
  cookies: string[],
): Promise<void> {
  const data = await nativeGql<MutationCapabilityData>(
    request,
    cookies,
    `query MetadataFreshnessCleanupCapability {
      __type(name: "ApiMutationRoot") {
        fields { name }
      }
    }`,
  );
  const hasBulkPermanentDelete = Boolean(
    data.__type?.fields.some(
      (field) => field.name === "deleteDocumentsPermanently",
    ),
  );
  if (!hasBulkPermanentDelete) {
    throw new Error(
      "Metadata freshness smoke requires deleteDocumentsPermanently for deterministic cleanup; aborting before creating a disposable document because the running server schema does not expose it.",
    );
  }
}

async function setDocumentNumber(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
  documentNumber: string,
): Promise<MetadataProjection> {
  const data = await nativeGql<SetMetadataData>(
    request,
    cookies,
    `mutation SetMetadataFreshness($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) {
      setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) {
        metadata {
          docId
          projectionMode
          projectionVersion
          metadataRevision
          fields { key textValue }
        }
      }
    }`,
    {
      workspaceId,
      docId,
      input: { documentNumber },
    },
  );
  return data.setDocumentMetadata.metadata;
}

async function readPageUpdatedAt(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<string | null> {
  const data = await nativeGql<PageMetaData>(
    request,
    cookies,
    `query PageMetaFreshness($workspaceId: String!, $pageId: String!) {
      workspace(id: $workspaceId) {
        pageMeta(pageId: $pageId) { updatedAt }
      }
    }`,
    { workspaceId, pageId: docId },
  );
  return data.workspace?.pageMeta?.updatedAt ?? null;
}

async function waitForStablePageUpdatedAt(
  request: APIRequestContext,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<string> {
  let previous: string | null = null;
  for (let attempt = 0; attempt < 40 && previous === null; attempt++) {
    previous = await readPageUpdatedAt(request, cookies, workspaceId, docId);
    if (previous === null) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (previous === null) {
    throw new Error(`pageMeta.updatedAt did not materialize for ${docId}`);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const current = await readPageUpdatedAt(
      request,
      cookies,
      workspaceId,
      docId,
    );
    if (current === null) continue;
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

function documentNumberFrom(metadata: MetadataProjection): string | null {
  return (
    metadata.fields.find((field) => field.key === "documentNumber")
      ?.textValue ?? null
  );
}

async function createDoc(
  page: Page,
  workspaceId: string,
  title: string,
): Promise<string> {
  await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
    waitUntil: "load",
    timeout: 30_000,
  });
  await waitForWorkspaceReady(page, { allDocs: true });
  await page
    .locator(
      '[data-testid="sidebar-new-page-button"], [data-testid="new-page-button-trigger"]',
    )
    .first()
    .click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/(?!all(?:$|\?))[^/?#]+/, {
    timeout: 20_000,
  });

  await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForSelector("v-line", { timeout: 20_000 });

  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive doc id from ${page.url()}`);
  }

  const titleContainer = page.locator("doc-title .doc-title-container").first();
  await expect(titleContainer).toBeVisible({ timeout: 20_000 });
  await titleContainer.click();

  const titleEditor = page.locator("doc-title .inline-editor").first();
  await expect(titleEditor).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(title);
  await page.keyboard.press("Enter");
  await titleEditor.blur();
  await expect(titleContainer).toContainText(title, { timeout: 20_000 });

  return docId;
}

async function cleanupDoc(
  request: APIRequestContext,
  workspaceId: string,
  cookies: string[],
  docId: string,
  title: string,
): Promise<void> {
  await permanentlyDeleteDoc(request, workspaceId, cookies, docId);
  await expectDocAbsent(request, workspaceId, cookies, docId, title);
}

async function permanentlyDeleteDoc(
  request: APIRequestContext,
  workspaceId: string,
  cookies: string[],
  docId: string,
): Promise<void> {
  await nativeGql<PermanentDeleteData>(
    request,
    cookies,
    `mutation MetadataFreshnessCleanup($input: DeleteDocumentsPermanentlyInput!) {
      deleteDocumentsPermanently(input: $input) {
        alreadyDeleted
        deleted
        failed
        forbidden
        rootMetaRemoved
      }
    }`,
    { input: { workspaceId, docIds: [docId] } },
  ).then(({ deleteDocumentsPermanently }) => {
    if (
      deleteDocumentsPermanently.failed > 0 ||
      deleteDocumentsPermanently.forbidden > 0
    ) {
      throw new Error(
        `Metadata freshness cleanup failed: ${JSON.stringify(deleteDocumentsPermanently)}`,
      );
    }
  });
}

async function expectDocAbsent(
  request: APIRequestContext,
  workspaceId: string,
  cookies: string[],
  docId: string,
  title: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const data = await nativeGql<WorkspaceDocsData>(
          request,
          cookies,
          `query MetadataFreshnessCleanupDocs($workspaceId: String!) {
            workspace(id: $workspaceId) {
              docs(pagination: { first: 200 }) {
                edges { node { id title } }
              }
            }
          }`,
          { workspaceId },
        );
        return (data.workspace?.docs.edges ?? [])
          .filter(({ node }) => node.id === docId || node.title === title)
          .map(({ node }) => ({ id: node.id, title: node.title ?? "" }));
      },
      {
        message:
          "metadata freshness cleanup must not leave its smoke document visible in the workspace",
        timeout: 20_000,
      },
    )
    .toEqual([]);
}

async function openCurrentDocumentMetadata(page: Page): Promise<void> {
  const directInfoButton = page.getByTestId("header-info-button");
  if (await directInfoButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await directInfoButton.click();
  } else {
    const menuButton = page
      .getByTestId("header-dropDownButton")
      .or(page.getByRole("button", { name: /open menu/i }))
      .first();
    await expect(menuButton).toBeVisible({ timeout: 20_000 });
    await menuButton.click();
    await page.getByTestId("editor-option-menu-info").click();
  }
  await expect(page.getByTestId("document-metadata-dialog")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("document-metadata-editor")).toBeVisible({
    timeout: 20_000,
  });
}

test("native document metadata freshness reaches the running Web client without changing page updatedAt", async ({
  context,
  page,
  request,
}, testInfo) => {
  const getErrors = collectFatalErrors(page);
  const cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  await injectCookies(context, cookies);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  await requirePermanentDeleteCleanupSupport(request, cookies);

  const suffix = Date.now();
  const title = `Metadata freshness smoke ${suffix}`;
  const documentNumber = `FRESH-${suffix}`;
  let docId: string | undefined;
  let permanentlyDeleted = false;

  try {
    docId = await createDoc(page, workspaceId, title);
    const pageUpdatedAtBefore = await waitForStablePageUpdatedAt(
      request,
      cookies,
      workspaceId,
      docId,
    );
    const initial = await readMetadataWithRetry(
      request,
      cookies,
      workspaceId,
      docId,
    );

    const changed = await setDocumentNumber(
      request,
      cookies,
      workspaceId,
      docId,
      documentNumber,
    );
    expect(documentNumberFrom(changed)).toBe(documentNumber);
    expect(changed.metadataRevision).toBeGreaterThan(initial.metadataRevision);
    expect(changed.projectionVersion).not.toBe(initial.projectionVersion);

    const pageUpdatedAtAfter = await readPageUpdatedAt(
      request,
      cookies,
      workspaceId,
      docId,
    );
    expect(pageUpdatedAtAfter).toBe(pageUpdatedAtBefore);

    const graphqlResponses = collectGraphqlResponses(page);
    const graphqlRequests = collectGraphqlRequests(page);

    await openCurrentDocumentMetadata(page);

    const metadataResponse = await waitForObservedMetadata(
      graphqlResponses,
      changed.docId,
      changed.metadataRevision,
      documentNumber,
    );
    const requestHeaders = metadataResponse.requestHeaders;
    expect(requestHeaders["x-myoxus-client-format"]).toBe("myoxus-native");
    expect(requestHeaders["x-myoxus-client"]).toBe("web");

    const responseBody = metadataResponse.body as {
      data?: MetadataQueryData;
      errors?: unknown[];
    };
    expect(responseBody.errors ?? []).toHaveLength(0);
    expect(responseBody.data?.documentMetadata.projectionMode).toBe(
      "MYOXUS_NATIVE",
    );
    expect(
      responseBody.data?.documentMetadata.metadataRevision,
    ).toBeGreaterThanOrEqual(changed.metadataRevision);
    expect(documentNumberFrom(responseBody.data!.documentMetadata)).toBe(
      documentNumber,
    );

    await expect(
      page
        .getByTestId("document-metadata-field-documentNumber")
        .locator("input"),
    ).toHaveValue(documentNumber, { timeout: 30_000 });
    await testInfo.attach("document-metadata-freshness-web-after", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    expect(await captureDeletionGeneration(page, docId)).toBe("available");
    await permanentlyDeleteDoc(request, workspaceId, cookies, docId);
    permanentlyDeleted = true;

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as DeletionProbeWindow).__myoxusDeletionProbe
                ?.deleted,
          ),
        {
          message:
            "confirmed Storage purge must abort the original request generation before a later not-found request",
          timeout: 10_000,
        },
      )
      .toEqual({ aborted: true, state: "not-found" });

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("document-metadata-dialog")).toBeHidden({
      timeout: 10_000,
    });
    await expect(
      page.locator(
        '[data-testid="not-found"], [data-testid="workbench-route-not-found"]',
      ),
      "permanent deletion must replace the document surface with its terminal route state",
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByTestId("document-metadata-field-documentNumber"),
      "terminal lifecycle must not retain stale native metadata",
    ).toHaveCount(0);
    await testInfo.attach("document-metadata-terminal-not-found", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    const requestsAtTerminal = graphqlRequests.filter((entry) =>
      isDocumentLifecycleRequest(entry.postData, docId),
    ).length;
    await page.waitForTimeout(15_000);
    const requestsAfterQuietWindow = graphqlRequests.filter((entry) =>
      isDocumentLifecycleRequest(entry.postData, docId),
    ).length;
    const fatalErrors = getErrors();
    await testInfo.attach("document-metadata-terminal-request-evidence", {
      body: Buffer.from(
        JSON.stringify(
          {
            fatalErrors,
            quietWindowMilliseconds: 15_000,
            confirmedDeletion: await page.evaluate(
              () =>
                (window as unknown as DeletionProbeWindow).__myoxusDeletionProbe
                  ?.deleted,
            ),
            requestsAfterQuietWindow,
            requestsAtTerminal,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
    expect(
      requestsAfterQuietWindow,
      "terminal document lifecycle must suppress metadata, comment and graph follow-up requests",
    ).toBe(requestsAtTerminal);
    await expectDocAbsent(request, workspaceId, cookies, docId, title);

    expect(
      fatalErrors,
      "Fatal JS errors during document metadata freshness smoke",
    ).toHaveLength(0);
  } finally {
    let cleanupError: unknown;
    try {
      await page.evaluate(() => {
        const target = window as unknown as DeletionProbeWindow;
        target.__myoxusDeletionProbe?.off();
        delete target.__myoxusDeletionProbe;
      });
    } catch (error) {
      // A failed probe teardown must not prevent server fixture cleanup.
      cleanupError = error;
    }
    if (docId) {
      try {
        if (permanentlyDeleted) {
          await expectDocAbsent(request, workspaceId, cookies, docId, title);
        } else {
          await cleanupDoc(request, workspaceId, cookies, docId, title);
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    await signOutViaApi(request, API, cookies);
    if (cleanupError) {
      throw cleanupError;
    }
  }
});
