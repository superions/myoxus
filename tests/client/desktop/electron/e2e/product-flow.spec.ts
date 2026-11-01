// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { ClientHandler } from "@myoxus/desktop-api-contract";

import { expect, test, type TestInfo } from "@playwright/test";

import {
  assertPackagedElectronClassification,
  closeElectron,
  launchPackagedElectron,
  type PackagedElectronRuntime,
  removeDirectory,
} from "../fixtures/packaged-runtime";
import {
  appendElectronContent,
  assertWebReceivesContentWithoutReload,
  classifyOfflineRuntimeEvents,
  classifyOnlineRuntimeEvents,
  classifyWebRuntimeEvents,
  connectAndPasswordLogin,
  createElectronDocument,
  deleteDisposableDocument,
  fileSha256,
  openAuthenticatedWebSession,
  openLiveDocumentInWeb,
  openWebWorkspace,
  productFlowProfile,
  profileWasRemoved,
  proveOfflineDocumentPersistence,
  requireProductFlowEnvironment,
  requireProductFlowReleaseIdentity,
  requireProductFlowServerInfo,
  seededWorkspace,
  waitForDocumentSyncAvailability,
  waitForDocumentTitleProjection,
  type WebSession,
  writeProductFlowEvidence,
  writeProductFlowScreenshot,
} from "../fixtures/product-flow";

type CleanupEvidence = {
  document: {
    attempted: boolean;
    deleted: boolean;
    docId?: string;
    result?: { failed: number; forbidden: number };
    verifiedAbsent: boolean;
  };
  errors: string[];
  firstRuntimeClosed: boolean;
  profile: {
    path: string;
    removed: boolean;
  };
  secondRuntimeClosed: boolean;
  webBrowserClosed: boolean;
  webSessionSignedOut: boolean;
};

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

async function attachScreenshots(
  testInfo: TestInfo,
  electron: PackagedElectronRuntime,
  web: WebSession,
  label: string,
): Promise<Record<string, { file: string; sha256: string }>> {
  const [electronScreenshot, webScreenshot] = await Promise.all([
    writeProductFlowScreenshot(
      testInfo,
      `electron-${label}`,
      await electron.page.captureScreenshot(),
    ),
    writeProductFlowScreenshot(
      testInfo,
      `web-${label}`,
      await web.page.screenshot({ fullPage: true }),
    ),
  ]);
  return { electron: electronScreenshot, web: webScreenshot };
}

test.describe("D-ER-C-03/04/05 packaged server product flow", () => {
  test.describe.configure({ mode: "serial" });

  test("QG-ER-5: password login, workspace, live sync and offline restart persistence", async ({
    request,
  }, testInfo) => {
    test.setTimeout(180_000);

    const environment = requireProductFlowEnvironment();
    const releaseIdentity = requireProductFlowReleaseIdentity();
    const serverInfo = await requireProductFlowServerInfo(request, environment);
    const profile = productFlowProfile(testInfo);
    const suffix = randomUUID();
    const title = `Electron product flow ${suffix}`;
    const initialContent = `Initial packaged content ${suffix}`;
    const liveContent = `Live Electron mutation ${suffix}`;
    const evidence: Record<string, unknown> = {
      schema: "myoxus.electron-product-flow.v1",
      contract: ["D-ER-C-03", "D-ER-C-04", "D-ER-C-05", "QG-ER-5"],
      credentials: {
        emailEnvironment: "E2E_USER_EMAIL",
        passwordEnvironment: "E2E_USER_PASSWORD",
        provisioner: "build/scripts/test/seed-test-users.sh",
      },
      document: {
        initialContent,
        liveContent,
        title,
      },
      environment: {
        apiUrl: environment.apiUrl,
        environmentId: releaseIdentity.environmentId,
        frontendUrl: environment.frontendUrl,
      },
      generatedAt: new Date().toISOString(),
      flowId: suffix,
      profile,
      release: {
        ...releaseIdentity,
        package: {
          name: releaseIdentity.packagePath.split(/[\\/]/).at(-1),
          sha256: await fileSha256(releaseIdentity.packagePath),
        },
        packagePath: undefined,
      },
      serverInfo,
    };
    const cleanup: CleanupEvidence = {
      document: {
        attempted: false,
        deleted: false,
        verifiedAbsent: false,
      },
      errors: [],
      firstRuntimeClosed: false,
      profile: { path: profile, removed: false },
      secondRuntimeClosed: false,
      webBrowserClosed: false,
      webSessionSignedOut: false,
    };

    let first: PackagedElectronRuntime | undefined;
    let second: PackagedElectronRuntime | undefined;
    let web: WebSession | undefined;
    let workspaceId: string | undefined;
    let docId: string | undefined;
    let serverId: string | undefined;
    let flowFailure: unknown;

    try {
      await removeDirectory(profile);
      web = await openAuthenticatedWebSession(request, environment);
      const workspace = await seededWorkspace(
        request,
        environment,
        web.cookies,
      );
      workspaceId = workspace.id;
      evidence.workspace = workspace;
      await openWebWorkspace(web, environment, workspaceId);

      first = await launchPackagedElectron(profile);
      await assertPackagedElectronClassification(first);
      (evidence.release as Record<string, unknown>).executable = {
        name: first.main.executableRealPath.split(/[\\/]/).at(-1),
        sha256: await fileSha256(first.main.executableRealPath),
      };
      const login = await connectAndPasswordLogin(
        first.page,
        environment,
        workspaceId,
      );
      evidence.login = {
        captchaSolved: login.captchaSolved,
        method: "password",
        server: environment.apiUrl,
      };
      serverId = await first.page.evaluate(async () => {
        const tabs = await (
          window as unknown as Window & { __apis: ClientHandler }
        ).__apis.ui.getTabsStatus();
        const active = tabs.find((tab) => tab.active);
        if (!active?.serverId)
          throw new Error("Active native tab has no registered server");
        return active.serverId;
      });

      docId = await createElectronDocument(first.page, title, initialContent);
      (evidence.document as Record<string, unknown>).docId = docId;
      await waitForDocumentTitleProjection(
        request,
        environment,
        web.cookies,
        workspaceId,
        docId,
        title,
      );
      await waitForDocumentSyncAvailability(
        request,
        environment,
        web.cookies,
        workspaceId,
        docId,
      );
      await openLiveDocumentInWeb(web, docId, title, initialContent);
      evidence.liveSync = await assertWebReceivesContentWithoutReload(
        web,
        docId,
        initialContent,
        liveContent,
        () =>
          appendElectronContent(
            first!.page,
            docId!,
            initialContent,
            liveContent,
          ),
      );
      evidence.screenshots = await attachScreenshots(
        testInfo,
        first,
        web,
        "live-sync",
      );

      const firstClassification = classifyOnlineRuntimeEvents(
        first.events,
        serverId,
      );
      const firstWebClassification = classifyWebRuntimeEvents(web.events);
      expect(
        firstClassification.unexpected,
        "The online packaged Electron flow emitted unexpected console, page, or request errors",
      ).toEqual([]);
      expect(
        firstWebClassification.unexpected,
        "The real Chromium Web client emitted console, page, or request errors",
      ).toEqual([]);
      evidence.webRuntime = {
        expectedQueryAborts: firstWebClassification.expectedQueryAborts,
        unexpectedEvents: firstWebClassification.unexpected,
      };
      evidence.firstLaunch = {
        expectedQueryAborts: firstClassification.expectedQueryAborts,
        expectedOfflineBootstrapEvents: firstClassification.expectedOffline,
        main: first.main,
        renderer: first.renderer,
        shell: first.shell,
        unexpectedEvents: firstClassification.unexpected,
      };

      await closeElectron(first);
      const firstRenderer = first.page;
      first = undefined;
      cleanup.firstRuntimeClosed = true;
      await expect.poll(() => firstRenderer.closed).toBe(true);

      second = await launchPackagedElectron(profile, {
        networkMode: "offline",
      });
      await assertPackagedElectronClassification(second);
      const offlineEventStart = 0;
      const persistence = await proveOfflineDocumentPersistence(
        second.page,
        environment,
        workspaceId,
        docId,
        title,
        liveContent,
      );
      await expect
        .poll(
          () =>
            classifyOfflineRuntimeEvents(
              second!.events.slice(offlineEventStart),
              environment.apiUrl,
              serverId!,
            ).expectedOffline.some((event) => event.source === "requestfailed"),
          {
            message:
              "The offline persistence proof must include a failed standalone-server request",
            timeout: 10_000,
          },
        )
        .toBe(true);

      const secondOnlineClassification = classifyOnlineRuntimeEvents(
        second.events.slice(0, offlineEventStart),
        serverId,
      );
      const secondOfflineClassification = classifyOfflineRuntimeEvents(
        second.events.slice(offlineEventStart),
        environment.apiUrl,
        serverId!,
      );
      expect(
        secondOnlineClassification.unexpected,
        "The restarted packaged Electron flow failed before offline emulation",
      ).toEqual([]);
      expect(
        secondOfflineClassification.unexpected,
        "Offline Electron emitted an error outside the exact expected transport failures",
      ).toEqual([]);
      evidence.restartPersistence = {
        expectedOfflineEvents: secondOfflineClassification.expectedOffline,
        main: second.main,
        persistence,
        preOfflineBootstrapEvents: secondOnlineClassification.expectedOffline,
        unexpectedEvents: [
          ...secondOnlineClassification.unexpected,
          ...secondOfflineClassification.unexpected,
        ],
      };
      (evidence.screenshots as Record<string, unknown>).offline =
        await writeProductFlowScreenshot(
          testInfo,
          "electron-offline-persistence",
          await second.page.captureScreenshot(),
        );
      const finalWebClassification = classifyWebRuntimeEvents(web.events);
      expect(
        finalWebClassification.unexpected,
        "The Web client must remain healthy while Electron restarts and works offline",
      ).toEqual([]);
      evidence.webRuntime = {
        expectedQueryAborts: finalWebClassification.expectedQueryAborts,
        unexpectedEvents: finalWebClassification.unexpected,
      };
    } catch (error) {
      flowFailure = error;
      evidence.flowFailure = errorText(error);
      if (second) {
        const restartFailure = await second.page
          .evaluate(
            ({ workspaceId, docId }) => {
              type ProbeObservable = {
                subscribe: (observer: {
                  error: (error: unknown) => void;
                  next: (value: unknown) => void;
                }) => { unsubscribe: () => void };
              };
              const workspace = (
                globalThis as typeof globalThis & {
                  currentWorkspace?: {
                    docCollection?: {
                      getDoc: (id: string) => unknown;
                    };
                    docs?: {
                      list?: {
                        doc$: (id: string) => { value: unknown };
                        isReady$?: { value: unknown };
                      };
                    };
                    engine?: {
                      blob?: { state$?: ProbeObservable };
                      doc?: {
                        docState$?: (id: string) => ProbeObservable;
                        state$?: ProbeObservable;
                      };
                      indexer?: { state$?: ProbeObservable };
                    };
                    rootYDoc?: {
                      getMap: (name: string) => {
                        get: (key: string) => unknown;
                      };
                    };
                  };
                }
              ).currentWorkspace;
              const readObservable = async (
                observable: ProbeObservable | undefined,
              ) => {
                if (!observable) return null;
                return new Promise<unknown>((resolve) => {
                  const timeout = setTimeout(() => resolve("timeout"), 2_000);
                  let subscription: { unsubscribe: () => void } | undefined;
                  subscription = observable.subscribe({
                    error: (observableError) => {
                      clearTimeout(timeout);
                      queueMicrotask(() => subscription?.unsubscribe());
                      resolve({
                        error:
                          observableError instanceof Error
                            ? `${observableError.name}: ${observableError.message}\n${observableError.stack ?? ""}`
                            : String(observableError),
                      });
                    },
                    next: (value) => {
                      clearTimeout(timeout);
                      queueMicrotask(() => subscription?.unsubscribe());
                      resolve(value);
                    },
                  });
                });
              };
              const readDocState = (id: string | undefined) =>
                id && workspace?.engine?.doc?.docState$
                  ? readObservable(workspace.engine.doc.docState$(id))
                  : null;
              return Promise.all([
                readDocState(workspaceId),
                readDocState(docId),
                readObservable(workspace?.engine?.doc?.state$),
                readObservable(workspace?.engine?.indexer?.state$),
                readObservable(workspace?.engine?.blob?.state$),
              ]).then(
                ([
                  rootState,
                  docState,
                  aggregateDocState,
                  indexerState,
                  blobState,
                ]) => ({
                  aggregateDocState,
                  blobState,
                  bodyText: document.body.innerText.slice(0, 4_000),
                  currentWorkspace: Boolean(workspace),
                  docCollectionHasDoc: Boolean(
                    docId && workspace?.docCollection?.getDoc(docId),
                  ),
                  docListReady: workspace?.docs?.list?.isReady$?.value ?? null,
                  docRecordPresent: Boolean(
                    docId && workspace?.docs?.list?.doc$(docId).value,
                  ),
                  docState,
                  indexerState,
                  rootHasPages: Boolean(
                    workspace?.rootYDoc?.getMap("meta").get("pages"),
                  ),
                  rootState,
                  url: location.href,
                }),
              );
            },
            { workspaceId, docId },
          )
          .catch((diagnosticError: unknown) => ({
            diagnosticError: errorText(diagnosticError),
          }));
        evidence.restartFailure = {
          ...restartFailure,
          runtimeEvents: second.events,
        };
      }
      const captures = await Promise.allSettled([
        first || second
          ? testInfo.attach("electron-flow-failure", {
              body: await (first ?? second)!.page.captureScreenshot(),
              contentType: "image/png",
            })
          : Promise.resolve(),
        web
          ? testInfo.attach("web-flow-failure", {
              body: await web.page.screenshot({ fullPage: true }),
              contentType: "image/png",
            })
          : Promise.resolve(),
      ]);
      evidence.failureCaptureErrors = captures.flatMap((capture) =>
        capture.status === "rejected" ? [errorText(capture.reason)] : [],
      );
    }

    if (first) {
      try {
        await closeElectron(first);
        cleanup.firstRuntimeClosed = true;
      } catch (error) {
        cleanup.errors.push(
          `close first Electron runtime: ${errorText(error)}`,
        );
      }
    }
    if (second) {
      try {
        await closeElectron(second);
        cleanup.secondRuntimeClosed = true;
      } catch (error) {
        cleanup.errors.push(
          `close second Electron runtime: ${errorText(error)}`,
        );
      }
    }
    if (!second) cleanup.secondRuntimeClosed = true;

    if (web) {
      try {
        await web.browser.close();
        cleanup.webBrowserClosed = true;
      } catch (error) {
        cleanup.errors.push(`close Chromium Web client: ${errorText(error)}`);
      }
      if (workspaceId && docId) {
        cleanup.document.attempted = true;
        cleanup.document.docId = docId;
        try {
          const result = await deleteDisposableDocument(
            request,
            environment,
            web.cookies,
            workspaceId,
            docId,
          );
          cleanup.document.result = result;
          cleanup.document.deleted = true;
          cleanup.document.verifiedAbsent = true;
        } catch (error) {
          cleanup.errors.push(
            `delete disposable document ${docId}: ${errorText(error)}`,
          );
        }
      }
      try {
        await web.signOut();
        cleanup.webSessionSignedOut = true;
      } catch (error) {
        cleanup.errors.push(`sign out Web session: ${errorText(error)}`);
      }
    } else {
      cleanup.webBrowserClosed = true;
      cleanup.webSessionSignedOut = true;
    }

    try {
      await removeDirectory(profile);
      cleanup.profile.removed = await profileWasRemoved(profile);
      if (!cleanup.profile.removed) {
        cleanup.errors.push(`Electron profile still exists: ${profile}`);
      }
    } catch (error) {
      cleanup.errors.push(`remove Electron profile: ${errorText(error)}`);
    }

    evidence.cleanup = cleanup;
    await writeProductFlowEvidence(testInfo, evidence);

    const failures = [
      ...(flowFailure ? [flowFailure] : []),
      ...cleanup.errors.map((message) => new Error(message)),
    ];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Packaged Electron product flow or its cleanup failed: ${failures
          .map(errorText)
          .join("; ")}`,
      );
    }

    expect(cleanup).toMatchObject({
      document: {
        attempted: true,
        deleted: true,
        verifiedAbsent: true,
      },
      errors: [],
      firstRuntimeClosed: true,
      profile: { removed: true },
      secondRuntimeClosed: true,
      webBrowserClosed: true,
      webSessionSignedOut: true,
    });
  });
});
