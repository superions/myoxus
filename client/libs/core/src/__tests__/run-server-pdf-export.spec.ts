/**
 * @vitest-environment happy-dom
 *
 * Server PDF export — propagation of `unmappedFontFamilies` into the
 * `ServerPdfExportResult` returned to the caller. Locks the user-visible
 * font-fallback warning contract on `todo/pdf-refactoring.md:1778`.
 *
 * The renderer reports families it could not honour via the `done`-row
 * column `pdf_export_jobs.unmapped_font_families` (P-FONT-COVERAGE-05b).
 * The GraphQL `pdfExportJob`/`exportPdf` shapes surface this as
 * `unmappedFontFamilies: [String!]!`. The export hook funnels the list
 * back to the React layer so a non-blocking `notify.warning` toast can
 * cite the families. Without this propagation, users would see "PDF
 * exported successfully" while their custom body font silently
 * fell back to "Inter" — exactly the regression this contract guards.
 *
 * Invariants:
 *  - INV-PDF-EXPORT-WARN-01: sync-done path returns the families from
 *    `exportPdf.unmappedFontFamilies` without polling
 *  - INV-PDF-EXPORT-WARN-02: queued→running→done polling path returns
 *    the families from the final `pdfExportJob` row
 *  - INV-PDF-EXPORT-WARN-03: empty array stays empty (common case —
 *    no fallback occurred)
 *  - INV-PDF-EXPORT-WARN-04: missing field (older server) is coerced
 *    to an empty array, never undefined — keeps `.length` safe in
 *    the React caller
 *  - INV-PDF-EXPORT-SSE-01: queued async jobs prefer SSE and keep terminal
 *    warning fields without extra polling
 *  - INV-PDF-EXPORT-SSE-02: repeated SSE failure falls back to polling
 *  - INV-PDF-EXPORT-SSE-03: open SSE streams respect the export timeout
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/ui-facade", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notify: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("@myoxus/global-loading", () => ({
  pushGlobalLoadingEventAtom: {},
  resolveGlobalLoadingEventAtom: {},
}));

vi.mock(
  "@myoxus/core/editor/virgultum/doc-editor/virgultum-editor",
  () => ({}),
);

vi.mock("@myoxus/core/modules/server", () => ({
  GraphQLService: class {},
}));

vi.mock("@myoxus/core/modules/editor", () => ({
  EditorService: class {},
}));

vi.mock("@myoxus/core/modules/workspace/global-schema", () => ({
  getMyoxusWorkspaceSchema: () => ({}),
}));

vi.mock("@myoxus/graphql", () => ({
  ServerDeploymentType: { Cloud: "Cloud", Standalone: "Standalone" },
  documentMetadataFieldDefinitionFieldsFragment: "",
  documentMetadataFieldsFragment: "",
  documentMetadataStateFieldsFragment: "",
  documentMetadataValidationFieldsFragment: "",
  documentMetadataValidationIssueFieldsFragment: "",
  documentStatusValueFieldsFragment: "",
  documentTypeDefinitionFieldsFragment: "",
  documentVersionFieldsFragment: "",
  pdfExportJobQuery: { id: "pdfExportJobQuery", op: "pdfExportJob", query: "" },
  exportPdfMutation: {
    id: "exportPdfMutation",
    op: "exportPdf",
    query: "",
  },
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({}),
}));

// Admin Vitest also executes this core spec. Keep broad framework modules as
// partial mocks so unrelated imports continue to receive their real exports.
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLiveData: () => null,
  useService: () => ({}),
}));

vi.mock("@myoxus/track", () => ({
  track: { $: { sharePanel: { $: { export: () => {} } } } },
}));

vi.mock("@virgultum/editor/blocks/surface", () => ({
  ExportManager: class {},
}));

vi.mock("@virgultum/editor/shared/adapters", () => ({
  docLinkBaseURLMiddleware: () => null,
  embedSyncedDocMiddleware: () => null,
  HtmlAdapterFactoryIdentifier: {},
  MarkdownAdapterFactoryIdentifier: {},
  titleMiddleware: () => null,
}));

vi.mock("@virgultum/editor/shared/utils", () => ({
  printToPdf: () => Promise.resolve(),
}));

vi.mock("@virgultum/editor/store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Transformer: class {},
}));

vi.mock("@virgultum/editor/widgets/linked-doc", () => ({
  createAssetsArchive: () => null,
  download: vi.fn(),
  HtmlTransformer: { exportDoc: () => Promise.resolve() },
  MarkdownTransformer: { exportDoc: () => Promise.resolve() },
  ZipTransformer: { exportDocs: () => Promise.resolve() },
}));

vi.mock("../components/hooks/myoxus-async-hooks", () => ({
  useAsyncCallback: (fn: unknown) => fn,
}));

import {
  __test__ as pdfExportHookTest,
  runServerPdfExport,
  type ServerPdfExportResult,
} from "../components/hooks/myoxus/use-export-page";
import { PDF_EXPORT_COMPLETED_EVENT } from "../modules/pdf-export/events";
import { runServerDocxExport } from "../modules/file-export/run-server-docx-export";
import { DOCX_MIME } from "../modules/file-export/deliver-file";
import { download } from "@virgultum/editor/widgets/linked-doc";

type GqlServiceShape = {
  gql: (args: { query: unknown; variables?: unknown }) => Promise<unknown>;
};

const ORIGINAL_FETCH = globalThis.fetch;
const fetchService = {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
};

function withMockFetch(
  ok: boolean,
  bytes: ArrayBuffer = new ArrayBuffer(0),
): () => void {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      blob: () =>
        Promise.resolve(
          new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
        ),
    } as Response),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return () => {
    globalThis.fetch = ORIGINAL_FETCH;
  };
}

function makeService(
  steps: Array<Record<string, unknown>>,
): GqlServiceShape & { calls: Array<{ op: string; variables?: unknown }> } {
  const calls: Array<{ op: string; variables?: unknown }> = [];
  const queue = [...steps];
  return {
    calls,
    gql: ({ query, variables }: { query: unknown; variables?: unknown }) => {
      const op = (query as { op?: string } | undefined)?.op ?? "<unknown-op>";
      calls.push({ op, variables });
      const next = queue.shift();
      if (!next) {
        throw new Error(`unexpected gql call for op=${op}`);
      }
      return Promise.resolve(next);
    },
  };
}

class MockEventSource {
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  fail() {
    this.onerror?.();
  }

  close() {
    this.closed = true;
  }
}

function makeEventSourceService() {
  const instances: MockEventSource[] = [];
  return {
    instances,
    eventSourceService: {
      eventSource: vi.fn(() => {
        const source = new MockEventSource();
        instances.push(source);
        return source as unknown as EventSource;
      }),
    },
  };
}

describe("runServerPdfExport — unmappedFontFamilies propagation", () => {
  test("INV-PDF-EXPORT-WARN-01: sync-done path returns families from exportPdf", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-sync",
            status: "done",
            downloadUrl: "/api/pdf-export/job-sync/download",
            errorClass: null,
            unmappedFontFamilies: ["Atkinson Hyperlegible", "Helvetica Neue"],
          },
        },
      ]);
      const result: ServerPdfExportResult = await runServerPdfExport(
        "ws-1",
        "doc-1",
        "Title",
        service as never,
        { fetchService },
      );
      expect(result.unmappedFontFamilies).toEqual([
        "Atkinson Hyperlegible",
        "Helvetica Neue",
      ]);
      expect(service.calls.map((c) => c.op)).toEqual(["exportPdf"]);
    } finally {
      restore();
    }
  });

  test("INV-PDF-EXPORT-WARN-02: polling path returns families from final pdfExportJob row", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-async",
            status: "queued",
            downloadUrl: null,
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
        {
          pdfExportJob: {
            status: "running",
            downloadUrl: null,
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
        {
          pdfExportJob: {
            status: "done",
            downloadUrl: "/api/pdf-export/job-async/download",
            errorClass: null,
            unmappedFontFamilies: ["Iosevka Slab"],
          },
        },
      ]);
      const real = globalThis.setTimeout;
      // Skip the 2 s wait so the test doesn't need fake timers.
      // @ts-expect-error patching global
      globalThis.setTimeout = (cb: () => void) => {
        cb();
        return 0 as never;
      };
      try {
        const result = await runServerPdfExport(
          "ws-1",
          "doc-1",
          "Title",
          service as never,
          { fetchService },
        );
        expect(result.unmappedFontFamilies).toEqual(["Iosevka Slab"]);
        expect(service.calls.map((c) => c.op)).toEqual([
          "exportPdf",
          "pdfExportJob",
          "pdfExportJob",
        ]);
      } finally {
        globalThis.setTimeout = real;
      }
    } finally {
      restore();
    }
  });

  test("INV-PDF-EXPORT-WARN-03: empty array stays empty (common case)", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-empty",
            status: "done",
            downloadUrl: "/api/pdf-export/job-empty/download",
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
      ]);
      const result = await runServerPdfExport(
        "ws-1",
        "doc-1",
        "Title",
        service as never,
        { fetchService },
      );
      expect(result.unmappedFontFamilies).toEqual([]);
    } finally {
      restore();
    }
  });

  test("INV-PDF-EXPORT-WARN-04: missing field is coerced to empty array", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-missing-field",
            status: "done",
            downloadUrl: "/api/pdf-export/job-missing-field/download",
            errorClass: null,
            // unmappedFontFamilies absent — server response without optional unmappedFontFamilies
          },
        },
      ]);
      const result = await runServerPdfExport(
        "ws-1",
        "doc-1",
        "Title",
        service as never,
        { fetchService },
      );
      expect(Array.isArray(result.unmappedFontFamilies)).toBe(true);
      expect(result.unmappedFontFamilies).toEqual([]);
    } finally {
      restore();
    }
  });

  test("INV-PDF-EXPORT-HISTORY-01: successful download emits a document-scoped completion event", async () => {
    const restore = withMockFetch(true);
    const listener = vi.fn();
    window.addEventListener(PDF_EXPORT_COMPLETED_EVENT, listener);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-event",
            status: "done",
            downloadUrl: "/api/pdf-export/job-event/download",
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
      ]);
      await runServerPdfExport("ws-1", "doc-1", "Title", service as never, {
        fetchService,
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]?.[0]).toMatchObject({
        detail: {
          workspaceId: "ws-1",
          docId: "doc-1",
          jobId: "job-event",
          downloadUrl: "/api/pdf-export/job-event/download",
        },
      });
    } finally {
      window.removeEventListener(PDF_EXPORT_COMPLETED_EVENT, listener);
      restore();
    }
  });

  test("INV-PDF-EXPORT-SSE-01: queued jobs prefer SSE and keep terminal warning fields", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-sse",
            status: "queued",
            downloadUrl: null,
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
      ]);
      const { eventSourceService, instances } = makeEventSourceService();
      const progress: string[] = [];
      const promise = runServerPdfExport(
        "ws-1",
        "doc-1",
        "Title",
        service as never,
        {
          fetchService,
          eventSourceService,
          templateId: "report",
          locale: "de",
          onProgress: (update) => progress.push(update.phase),
        },
      );

      await Promise.resolve();
      expect(eventSourceService.eventSource).toHaveBeenCalledWith(
        "/api/pdf-export/job-sse/events",
        { withCredentials: true },
      );
      instances[0]?.emit("update", {
        job_id: "job-sse",
        status: "running",
        phase: "rendering",
      });
      instances[0]?.emit("done", {
        job_id: "job-sse",
        status: "done",
        phase: "done",
        download_url: "/api/pdf-export/job-sse/download",
        unmapped_font_families: ["Iosevka Slab"],
      });

      const result = await promise;
      expect(result.unmappedFontFamilies).toEqual(["Iosevka Slab"]);
      expect(service.calls.map((c) => c.op)).toEqual(["exportPdf"]);
      expect(service.calls[0]?.variables).toEqual({
        input: {
          workspaceId: "ws-1",
          docId: "doc-1",
          templateId: "report",
          locale: "de",
        },
      });
      expect(progress).toEqual(["queued", "rendering", "done"]);
    } finally {
      restore();
    }
  });

  test("INV-PDF-EXPORT-SSE-02: SSE failure falls back to polling", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-fallback",
            status: "queued",
            downloadUrl: null,
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
        {
          pdfExportJob: {
            status: "done",
            downloadUrl: "/api/pdf-export/job-fallback/download",
            errorClass: null,
            unmappedFontFamilies: ["Atkinson Hyperlegible"],
          },
        },
      ]);
      const { eventSourceService, instances } = makeEventSourceService();
      const promise = runServerPdfExport(
        "ws-1",
        "doc-1",
        "Title",
        service as never,
        {
          fetchService,
          eventSourceService,
          pollIntervalMs: 0,
          sseMaxRetries: 0,
        },
      );

      await Promise.resolve();
      instances[0]?.fail();

      const result = await promise;
      expect(result.unmappedFontFamilies).toEqual(["Atkinson Hyperlegible"]);
      expect(service.calls.map((c) => c.op)).toEqual([
        "exportPdf",
        "pdfExportJob",
      ]);
    } finally {
      restore();
    }
  });

  test("INV-PDF-EXPORT-SSE-03: open SSE stream respects timeoutMs", async () => {
    const restore = withMockFetch(true);
    try {
      const service = makeService([
        {
          exportPdf: {
            id: "job-sse-timeout",
            status: "queued",
            downloadUrl: null,
            errorClass: null,
            unmappedFontFamilies: [],
          },
        },
      ]);
      const { eventSourceService, instances } = makeEventSourceService();
      const promise = runServerPdfExport(
        "ws-1",
        "doc-1",
        "Title",
        service as never,
        { fetchService, eventSourceService, timeoutMs: 5 },
      );

      await Promise.resolve();
      expect(eventSourceService.eventSource).toHaveBeenCalledWith(
        "/api/pdf-export/job-sse-timeout/events",
        { withCredentials: true },
      );
      await expect(promise).rejects.toMatchObject({ errorClass: "Timeout" });
      expect(instances[0]?.closed).toBe(true);
      expect(service.calls.map((c) => c.op)).toEqual(["exportPdf"]);
    } finally {
      restore();
    }
  });
});

describe("PDF export preflight — source sync barrier", () => {
  function makePage() {
    return {
      id: "doc-1",
      workspace: {
        id: "ws-1",
      },
    };
  }

  function makeWorkspace(waitForSynced: ReturnType<typeof vi.fn>) {
    return {
      id: "ws-1",
      engine: {
        doc: {
          waitForSynced,
        },
      },
    };
  }

  test("INV-PDF-EXPORT-SYNC-01: failed document sync aborts before render dispatch", async () => {
    const waitForSynced = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("not synced"));
    await expect(
      pdfExportHookTest.runServerPdfExportPreflight(
        makePage() as never,
        "page",
        makeWorkspace(waitForSynced) as never,
        null,
        {} as never,
      ),
    ).rejects.toMatchObject({
      errorClass: "Unavailable",
      errorDetail:
        "pdf export source sync barrier did not complete before render dispatch",
      workspaceId: "ws-1",
      docId: "doc-1",
    });
    expect(waitForSynced).toHaveBeenCalledWith("ws-1", expect.any(AbortSignal));
    expect(waitForSynced).toHaveBeenCalledWith(
      "doc-1",
      expect.any(AbortSignal),
    );
    waitForSynced
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("not synced"));
    const fetch = vi.fn();
    await expect(
      runServerDocxExport(
        {
          page: makePage() as never,
          pageMode: "page",
          workspace: {
            ...makeWorkspace(waitForSynced),
            flavour: "myoxus",
          } as never,
          fetchService: { fetch },
        },
        () => {},
      ),
    ).rejects.toMatchObject({ reason: "sync" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("INV-PDF-EXPORT-SYNC-02: page-mode export may start only after workspace and doc are synced", async () => {
    const waitForSynced = vi.fn().mockResolvedValue(undefined);
    await expect(
      pdfExportHookTest.runServerPdfExportPreflight(
        makePage() as never,
        "page",
        makeWorkspace(waitForSynced) as never,
        null,
        {} as never,
      ),
    ).resolves.toBeUndefined();
    expect(waitForSynced.mock.calls.map(([docId]) => docId)).toEqual([
      "ws-1",
      "doc-1",
    ]);
  });
});

test("Word waits for the committed source before delivering its Unicode filename and observed notices", async () => {
  const originalElectron = BUILD_CONFIG.isElectron;
  BUILD_CONFIG.isElectron = false;
  try {
    let synced!: () => void;
    const leaf = new Promise<void>((resolve) => {
      synced = resolve;
    });
    const waitForSynced = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(leaf);
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2]);
    const fetch = vi.fn().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "content-type": DOCX_MIME,
          "content-disposition":
            "attachment; filename*=UTF-8''%C3%9Cberblick.docx",
          "x-myoxus-conversion-warnings": JSON.stringify([
            { code: "unavailable_image_omitted", count: 2 },
          ]),
        },
      }),
    );
    const progress = vi.fn();
    const pending = runServerDocxExport(
      {
        page: { id: "doc key", meta: { title: "Old title" } } as never,
        pageMode: "page",
        workspace: {
          id: "workspace",
          flavour: "myoxus",
          engine: { doc: { waitForSynced } },
        } as never,
        fetchService: { fetch },
      },
      progress,
    );
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    synced();
    const result = await pending;
    expect(waitForSynced.mock.calls.map(([id]) => id)).toEqual([
      "workspace",
      "doc key",
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace/docs/doc%20key/export/docx",
      {
        method: "POST",
        credentials: "include",
        timeout: 130_000,
        throwOnHttpError: false,
      },
    );
    expect(result).toEqual({
      filename: "Überblick.docx",
      warnings: [{ code: "unavailable_image_omitted", count: 2 }],
      outcome: "provided",
    });
    expect(progress.mock.calls.map(([phase]) => phase)).toEqual([
      "sync",
      "prepare",
    ]);
    const delivered = vi.mocked(download).mock.lastCall;
    expect(delivered?.[1]).toBe("Überblick.docx");
    expect(new Uint8Array(await delivered![0].arrayBuffer())).toEqual(bytes);
  } finally {
    BUILD_CONFIG.isElectron = originalElectron;
  }
});
