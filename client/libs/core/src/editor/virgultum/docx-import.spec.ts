/** @vitest-environment happy-dom */
import { Framework, LiveData } from "@myoxus/infra";
import { afterEach, expect, test, vi } from "vitest";
import { DocsService } from "../../modules/doc/services/docs";
import { DocsStore } from "../../modules/doc/stores/docs";
import { DocPropertiesStore } from "../../modules/doc/stores/doc-properties";
import { DocCreateMiddleware } from "../../modules/doc/providers/doc-create-middleware";
import { DocRecordList } from "../../modules/doc/entities/record-list";
import type { DocRecord } from "../../modules/doc/entities/record";
import { WorkspaceService } from "../../modules/workspace/services/workspace";
import { WorkspaceServerService } from "../../modules/server/services/workspace-server";
import { FetchService } from "../../modules/server/services/fetch";
import { GuardService } from "../../modules/permissions/services/guard";
import { openFilesWith } from "@virgultum/editor/shared/utils";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "server-page",
          title: "Word title",
          warnings: [],
          bestEffort: true,
        }),
        { status: 201 },
      ),
  );
  const waitForCreateAcknowledgement = vi.fn(
    async (_id: string, _signal?: AbortSignal, canonicalRoot = false) => {
      if (canonicalRoot)
        throw new Error(
          "Server-created membership has no local registration-owner marker",
        );
    },
  );
  const waitForDocSynced = vi.fn(async () => {});
  const release = vi.fn();
  const createDoc = vi.fn(() => {
    throw new Error("DOCX must never create a client page");
  });
  const workspace = {
    id: "origin-workspace",
    flavour: "myoxus",
    name$: new LiveData("Origin workspace"),
    docCollection: { createDoc },
  };
  const framework = new Framework();
  framework
    .service(DocsService, [
      DocsStore,
      DocPropertiesStore,
      [DocCreateMiddleware],
    ])
    .store(DocsStore, {
      addPriorityLoad: vi.fn(() => release),
      waitForCreateAcknowledgement,
      waitForDocSynced,
      watchDocIds: () => new LiveData<string[]>([]),
      watchTrashDocIds: () => new LiveData<string[]>([]),
      watchNonTrashDocIds: () => new LiveData<string[]>([]),
      watchDocListReady: () => new LiveData(true),
    } as unknown as DocsStore)
    .store(DocPropertiesStore, {} as DocPropertiesStore)
    .entity(DocRecordList, [DocsStore])
    .service(WorkspaceService, { workspace } as unknown as WorkspaceService)
    .service(WorkspaceServerService, {
      server: {
        scope: {
          get: (type: unknown) => {
            if (type !== FetchService) throw new Error("Unexpected service");
            return { fetch };
          },
        },
      },
    } as unknown as WorkspaceServerService)
    .service(GuardService, {
      can: vi.fn(async () => true),
    } as unknown as GuardService);
  const provider = framework.provider();
  cleanups.push(() => provider.dispose());
  const docs = provider.get(DocsService);
  vi.spyOn(docs.list, "doc$").mockReturnValue(
    new LiveData<DocRecord | undefined>({} as DocRecord),
  );
  const waitForSyncReady = vi.fn(async () => {});
  const open = vi
    .spyOn(docs, "open")
    .mockReturnValue({ doc: { waitForSyncReady }, release: vi.fn() } as never);
  return {
    docs,
    fetch,
    createDoc,
    release,
    waitForCreateAcknowledgement,
    waitForDocSynced,
    waitForSyncReady,
    open,
  };
}

test("DOCX shares one owned request and opens only a synchronized server-created page", async () => {
  const {
    docs,
    fetch,
    createDoc,
    release,
    waitForCreateAcknowledgement,
    waitForDocSynced,
    waitForSyncReady,
    open,
  } = setup();
  const file = new File(["Word upload bytes"], "Überblick.docx");
  let choose!: (file: File) => void;
  const select = vi.fn(
    () =>
      new Promise<File>((resolve) => {
        choose = resolve;
      }),
  );
  const first = docs.importDocx(select, "/workspace/origin-workspace/source");
  const duplicate = docs.importDocx(
    select,
    "/workspace/origin-workspace/other",
  );
  expect(duplicate).toBe(first);
  expect(select).toHaveBeenCalledTimes(1);
  choose(file);
  const result = await first;
  expect(result).toMatchObject({
    status: "complete",
    id: "server-page",
    filename: "Überblick.docx",
    workspaceId: "origin-workspace",
    origin: "/workspace/origin-workspace/source",
    ready: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe("/api/workspaces/origin-workspace/docs/import/docx");
  expect(options.credentials).toBe("include");
  expect((options.body as FormData).get("file")).toBeInstanceOf(File);
  expect(waitForCreateAcknowledgement).toHaveBeenCalledWith(
    "server-page",
    expect.any(AbortSignal),
  );
  expect(open).toHaveBeenCalledWith("server-page", { readonly: true });
  expect(waitForSyncReady).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(waitForDocSynced).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
  expect(createDoc).not.toHaveBeenCalled();
  const next = await docs.importDocx(async () => file, "/next-origin");
  expect(next?.status).toBe("complete");
  expect(next?.attemptId).not.toBe(result?.attemptId);
  docs.dismissDocxImportResult(result!.attemptId);
  expect(docs.docxImport$.value).toBe(next);
  docs.dismissDocxImportResult(next!.attemptId);
  expect(docs.docxImport$.value).toBeNull();
});

test("picker cancellation is neutral; a lost response is not a safe creation retry", async () => {
  const { docs, fetch, createDoc } = setup();
  const pickerError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "showOpenFilePicker",
    vi.fn(async () => {
      throw new DOMException("Cancelled", "AbortError");
    }),
  );
  expect(
    await docs.importDocx(
      async () => (await openFilesWith("Docx", false))?.[0],
      "/origin",
    ),
  ).toBeNull();
  expect(docs.docxImport$.value).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(pickerError).not.toHaveBeenCalled();
  fetch.mockRejectedValueOnce(new TypeError("Network connection lost"));
  const select = vi.fn(async () => new File(["bytes"], "source.docx"));
  expect(await docs.importDocx(select, "/origin")).toMatchObject({
    status: "error",
    reason: "unknown",
  });
  await docs.importDocx(select, "/other");
  expect(select).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(createDoc).not.toHaveBeenCalled();
});
