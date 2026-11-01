// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceInitialContentPolicy } from "@myoxus/graphql";
import { nativeDocumentBundles } from "../services/source-metadata";

import { LiveData } from "@myoxus/infra";
import { expect, test, vi } from "vitest";

import { BuiltinTemplateReconcilerService } from "../services/builtin-reconciler";

test("seeding creates readable onboarding documents and reusable meeting sources without duplicates", async () => {
  const records = new Map<string, { id: string; trash$: LiveData<boolean> }>();
  const instanceIds$ = new LiveData<Record<string, string>>({});
  const createDoc = vi.fn(() => {
    const doc = { id: `seed-${records.size}`, trash$: new LiveData(false) };
    records.set(doc.id, doc);
    return doc;
  });
  const createTemplateDoc = vi.fn(async () => createDoc());
  const createProvisionedDoc = vi.fn(async () => createDoc());
  vi.stubGlobal("environment", { publicPath: "/" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const bytes = readFileSync(
        resolve(
          __dirname,
          "../../../../../../..",
          "client/libs/core/public",
          url.slice(1),
        ),
      );
      return new Response(bytes);
    }),
  );
  const importNativeTemplateDoc = vi.fn(
    async (_content: Uint8Array, _title: string, _purpose: string) =>
      createDoc(),
  );
  // Exercise the public seeding path with storage ports; no socket or locale
  // watcher is needed to verify creation flags and seed-once identity.
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      docsService: {
        createDoc,
        createProvisionedDoc,
        createTemplateDoc,
        importNativeTemplateDoc,
        list: { doc$: (id: string) => new LiveData(records.get(id)) },
      },
      workspaceServerService: { server: undefined },
      workspaceService: {
        workspace: {
          flavour: "local",
          meta: {
            initialContentPolicy: WorkspaceInitialContentPolicy.LegacyDefaults,
          },
          docCollection: {},
        },
      },
      setting: {
        loading$: new LiveData(false),
        builtinReconcileMigrationDone$: new LiveData(true),
        builtinTemplateInstanceDocIds$: instanceIds$,
        setBuiltinTemplateInstanceDocIds: (ids: Record<string, string>) =>
          instanceIds$.next(ids),
      },
    },
  ) as BuiltinTemplateReconcilerService;
  const slugs = [
    "meeting-templates-myoxus",
    "databases-guide-myoxus",
    "personal-journal",
  ];

  try {
    const [first, concurrent] = await Promise.all([
      reconciler.ensureBuiltinTemplatesSeeded(slugs),
      reconciler.ensureBuiltinTemplatesSeeded(slugs),
    ]);
    expect(concurrent).toEqual(first);
    expect(createDoc).toHaveBeenCalledTimes(nativeDocumentBundles.length);
    expect(importNativeTemplateDoc).toHaveBeenCalledTimes(
      nativeDocumentBundles.length,
    );
    expect(createProvisionedDoc).not.toHaveBeenCalled();
    expect(
      importNativeTemplateDoc.mock.calls.filter((call) => call[2] === "guide"),
    ).toHaveLength(
      nativeDocumentBundles.filter((bundle) => bundle.purpose === "guide")
        .length,
    );
    expect(
      importNativeTemplateDoc.mock.calls.filter(
        (call) => call[2] === "template",
      ),
    ).toHaveLength(
      nativeDocumentBundles.filter(
        (bundle) => (bundle.purpose ?? "template") === "template",
      ).length,
    );
    expect(nativeDocumentBundles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          template_id: "project-brief",
          version: "1.0.0",
        }),
      ]),
    );
    expect(createTemplateDoc).not.toHaveBeenCalled();
    expect(Object.keys(first)).toEqual(slugs);
    expect(await reconciler.ensureBuiltinTemplatesSeeded(slugs)).toEqual(first);
    records.delete(first[slugs[0]]);
    records.delete(first["personal-journal"]);
    const afterDelete = await reconciler.ensureBuiltinTemplatesSeeded(slugs);
    expect(afterDelete).not.toHaveProperty(slugs[0]);
    expect(afterDelete).not.toHaveProperty("personal-journal");
    expect(instanceIds$.value[slugs[0]]).toBe(first[slugs[0]]);
    expect(importNativeTemplateDoc).toHaveBeenCalledTimes(
      nativeDocumentBundles.length,
    );
    expect(createDoc).toHaveBeenCalledTimes(nativeDocumentBundles.length);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("seeding does not publish a template source before durable creation completes", async () => {
  const records = new Map<string, { id: string; trash$: LiveData<boolean> }>();
  const instanceIds$ = new LiveData<Record<string, string>>({});
  let completeCreation!: () => void;
  const creation = new Promise<void>((resolve) => {
    completeCreation = resolve;
  });
  const importNativeTemplateDoc = vi.fn(async () => {
    await creation;
    const doc = { id: "durable-source", trash$: new LiveData(false) };
    records.set(doc.id, doc);
    return doc;
  });
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      docsService: {
        createDoc: vi.fn(),
        importNativeTemplateDoc,
        list: { doc$: (id: string) => new LiveData(records.get(id)) },
      },
      workspaceServerService: { server: undefined },
      workspaceService: {
        workspace: {
          flavour: "local",
          meta: {
            initialContentPolicy: WorkspaceInitialContentPolicy.LegacyDefaults,
          },
          docCollection: {},
        },
      },
      setting: {
        loading$: new LiveData(false),
        builtinReconcileMigrationDone$: new LiveData(true),
        builtinTemplateInstanceDocIds$: instanceIds$,
        setBuiltinTemplateInstanceDocIds: (ids: Record<string, string>) =>
          instanceIds$.next(ids),
      },
    },
  ) as BuiltinTemplateReconcilerService;

  vi.stubGlobal("environment", { publicPath: "/" });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          readFileSync(
            resolve(
              __dirname,
              "../../../../../../../client/libs/core/public",
              url.slice(1),
            ),
          ),
        ),
    ),
  );
  try {
    const pending = (reconciler as any).seedLocalBuiltinTemplates(
      ["personal-journal"],
      "en",
    );
    await Promise.resolve();
    expect(instanceIds$.value).toEqual({});

    completeCreation();
    await expect(pending).resolves.toEqual({
      "personal-journal": "durable-source",
    });
    expect(instanceIds$.value).toEqual({
      "personal-journal": "durable-source",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("retired Meeting Focus cannot be provisioned offline or erase an existing custom source", async () => {
  const source = {
    id: "retained",
    trash$: new LiveData(false),
    moveToTrash: vi.fn(),
  };
  const createTemplateDoc = vi.fn();
  const importNativeTemplateDoc = vi.fn();
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      docsService: {
        createTemplateDoc,
        importNativeTemplateDoc,
        list: { doc$: () => new LiveData(source) },
      },
      workspaceService: {
        workspace: {
          flavour: "local",
          meta: {
            initialContentPolicy: WorkspaceInitialContentPolicy.LegacyDefaults,
          },
          docCollection: {},
        },
      },
      workspaceServerService: { server: undefined },
      setting: {
        loading$: new LiveData(false),
        builtinTemplateInstanceDocIds$: new LiveData({
          "meeting-focus": "retained",
        }),
        setBuiltinTemplateInstanceDocIds: vi.fn(),
      },
    },
  ) as BuiltinTemplateReconcilerService;
  expect(
    await reconciler.ensureBuiltinTemplatesSeeded(["meeting-focus"]),
  ).toEqual({});
  expect(createTemplateDoc).not.toHaveBeenCalled();
  expect(importNativeTemplateDoc).not.toHaveBeenCalled();
  expect(source.moveToTrash).not.toHaveBeenCalled();
  expect(source.trash$.value).toBe(false);
});

test("an unbound cloud workspace never enters native offline provisioning", async () => {
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      workspaceService: { workspace: { flavour: "cloud" } },
      workspaceServerService: { server: undefined },
      setting: { loading$: new LiveData(false) },
    },
  ) as BuiltinTemplateReconcilerService;
  await expect(
    reconciler.ensureBuiltinTemplatesSeeded(["welcome-myoxus"]),
  ).rejects.toThrow("Registry is not available");
});

test("cloud onboarding waits for authoritative guide delivery and document sync", async () => {
  vi.useFakeTimers();
  const slug = "welcome-myoxus";
  const records = new Map<string, { id: string; trash$: LiveData<boolean> }>([
    ["stale-reader", { id: "stale-reader", trash$: new LiveData(false) }],
  ]);
  const createTemplateDoc = vi.fn(),
    importNativeTemplateDoc = vi.fn();
  const waitForSynced = vi.fn(async (id: string) => {
    if (id === "server-reader")
      records.set(id, { id, trash$: new LiveData(false) });
  });
  const gql = vi
    .fn()
    .mockResolvedValueOnce({
      workspace: {
        templateSuggestions: {
          guideDeliveries: [{ slug, documentId: null, pending: true }],
        },
      },
    })
    .mockResolvedValueOnce({
      workspace: {
        templateSuggestions: {
          guideDeliveries: [
            { slug, documentId: "server-reader", pending: false },
          ],
        },
      },
    });
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      deliveryAbort: new AbortController(),
      reconcile: vi.fn(async () => {}),
      docsService: {
        createTemplateDoc,
        importNativeTemplateDoc,
        list: { doc$: (id: string) => new LiveData(records.get(id)) },
      },
      workspaceService: {
        workspace: {
          id: "cloud-workspace",
          flavour: "cloud",
          engine: { doc: { waitForSynced } },
        },
      },
      workspaceServerService: { server: { gql } },
      setting: {
        loading$: new LiveData(false),
        builtinTemplateInstanceDocIds$: new LiveData({
          [slug]: "local-settings-must-not-win",
        }),
      },
      bindings$: new LiveData({
        "stale-reader": { slug, docId: "stale-reader", state: "Ok" },
      }),
    },
  ) as BuiltinTemplateReconcilerService;
  try {
    const pending = reconciler.ensureBuiltinTemplatesSeeded([slug]);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({ [slug]: "server-reader" });
    expect(gql).toHaveBeenCalledTimes(2);
    expect(waitForSynced).toHaveBeenCalledWith(
      "cloud-workspace",
      expect.any(AbortSignal),
    );
    expect(waitForSynced).toHaveBeenCalledWith(
      "server-reader",
      expect.any(AbortSignal),
    );
    expect(createTemplateDoc).not.toHaveBeenCalled();
    expect(importNativeTemplateDoc).not.toHaveBeenCalled();
    expect(records.get("stale-reader")!.trash$.value).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a viewer receives server bindings without starting provisioning", async () => {
  const createTemplateDoc = vi.fn();
  const bindings$ = new LiveData({});
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      docsService: { createTemplateDoc },
      workspaceService: { workspace: { id: "workspace" } },
      workspaceServerService: {
        server: {
          gql: vi.fn(async () => ({
            workspaceTemplateReconcileSlugs: [
              {
                slug: "personal-journal",
                builderVersion: 1,
                expectedHash: "hash",
                appliedHash: "hash",
                workspaceDocId: "source",
                instanceState: "Ok",
                provisioningMode: "SeedOnce",
                hasInstance: true,
              },
            ],
          })),
        },
      },
      guardService: { can: vi.fn(async () => false) },
      bindings$,
    },
  ) as BuiltinTemplateReconcilerService;

  await (reconciler as any).runReconcile();

  expect(bindings$.value).toEqual({
    source: {
      slug: "personal-journal",
      docId: "source",
      state: "Ok",
      metadata: {
        slug: "personal-journal",
        source: "bundle",
        category: "journal-daily",
        tags: ["journal", "journal-daily"],
        titlePolicy: "template",
        purpose: "template",
      },
    },
  });
  expect(createTemplateDoc).not.toHaveBeenCalled();
});

test.each(["replacement-source", null] as const)(
  "a reconcile run compare-and-sets only the retired default (%s)",
  async (replacement) => {
    const pageTemplateDocId$ = new LiveData<string | undefined>(
      "retired-source",
    );
    const journalTemplateDocId$ = new LiveData<string | undefined>(
      "journal-source",
    );
    const replacePageTemplateDocId = vi.fn(
      (expected: string, replacement?: string) => {
        if (pageTemplateDocId$.value !== expected) return false;
        pageTemplateDocId$.next(replacement);
        return true;
      },
    );
    const gql = vi
      .fn()
      .mockResolvedValueOnce({ workspaceTemplateReconcileSlugs: [] })
      .mockResolvedValueOnce({
        workspace: {
          templateSuggestions: {
            pageDefaultReplacements: [
              {
                retiredSourceDocId: "retired-source",
                replacementSourceDocId: replacement,
              },
            ],
          },
        },
      });
    const reconciler = Object.assign(
      Object.create(BuiltinTemplateReconcilerService.prototype),
      {
        workspaceService: { workspace: { id: "workspace" } },
        workspaceServerService: { server: { gql } },
        guardService: { can: vi.fn(async () => false) },
        setting: {
          loading$: new LiveData(false),
          pageTemplateDocId$,
          journalTemplateDocId$,
          replacePageTemplateDocId,
          replaceJournalTemplateDocId: vi.fn(),
        },
        bindings$: new LiveData({}),
      },
    ) as BuiltinTemplateReconcilerService;

    await (reconciler as any).runReconcile();

    expect(replacePageTemplateDocId).toHaveBeenCalledWith(
      "retired-source",
      replacement ?? undefined,
    );
    expect(pageTemplateDocId$.value).toBe(replacement ?? undefined);
    expect(
      (reconciler as any).setting.replaceJournalTemplateDocId,
    ).toHaveBeenCalledWith("retired-source", replacement ?? undefined);
    expect(journalTemplateDocId$.value).toBe("journal-source");
  },
);

test("explicit cloud recovery follows a passive read once and propagates provisioning failures", async () => {
  let releaseRead!: () => void;
  const passiveRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let firstRead = true;
  let failure: Error | undefined;
  const provisionCalls: boolean[] = [];
  const gql = vi.fn(
    async ({ variables }: { variables: Record<string, unknown> }) => {
      if (variables.input)
        return {
          workspace: { templateSuggestions: { pageDefaultReplacements: [] } },
        };
      provisionCalls.push(variables.provisionSources === true);
      if (variables.provisionSources && failure) throw failure;
      if (firstRead) {
        firstRead = false;
        await passiveRead;
      }
      return { workspaceTemplateReconcileSlugs: [] };
    },
  );
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      workspaceService: { workspace: { id: "workspace", flavour: "cloud" } },
      workspaceServerService: { server: { gql } },
      setting: { loading$: new LiveData(false) },
      bindings$: new LiveData({}),
    },
  ) as BuiltinTemplateReconcilerService;
  const read = reconciler.reconcile();
  const repair = reconciler.reconcile(true);
  const joined = reconciler.reconcile(true);
  expect(provisionCalls).toEqual([false]);
  releaseRead();
  await Promise.all([read, repair, joined]);
  expect(provisionCalls).toEqual([false, true]);
  failure = new Error("source preparation failed");
  await expect(reconciler.reconcile(true)).rejects.toBe(failure);
  failure = undefined;
  await expect(reconciler.reconcile(true)).resolves.toBeUndefined();
  expect(provisionCalls).toEqual([false, true, true, true]);
});

test("an empty disabled-registry result does not retire legacy client state", async () => {
  const source = {
    id: "server-source",
    trash$: new LiveData(false),
    moveToTrash() {
      this.trash$.next(true);
    },
  };
  const legacyMap$ = new LiveData({ "meeting-notes": source.id });
  const createTemplateDoc = vi.fn();
  const reconciler = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      docsService: {
        createTemplateDoc,
        list: { doc$: () => new LiveData(source) },
      },
      workspaceService: { workspace: { id: "workspace", flavour: "cloud" } },
      workspaceServerService: {
        server: {
          gql: vi.fn(async () => ({ workspaceTemplateReconcileSlugs: [] })),
        },
      },
      guardService: { can: vi.fn(async () => true) },
      setting: {
        builtinTemplateInstanceDocIds$: legacyMap$,
        userTrashedBuiltinSlugs$: new LiveData(["meeting-notes"]),
      },
      bindings$: new LiveData({}),
    },
  ) as BuiltinTemplateReconcilerService;

  await (reconciler as any).runReconcile();

  expect(source.trash$.value).toBe(false);
  expect(legacyMap$.value).toEqual({ "meeting-notes": source.id });
  expect(createTemplateDoc).not.toHaveBeenCalled();
});

// Legacy instance presence controls binding readback, never cloud content writes.
test.each(["Ok"])(
  "cloud reconcile preserves content for legacy state %s without a builder completion",
  async (instanceState) => {
    const source = {
      id: "existing-source",
      trash$: new LiveData(false),
      moveToTrash: vi.fn(),
    };
    const createDoc = vi.fn(),
      createTemplateDoc = vi.fn(),
      importNativeTemplateDoc = vi.fn();
    const entry = {
      slug: "personal-journal",
      builderVersion: 999,
      expectedHash: "changed",
      appliedHash: "old",
      workspaceDocId: source.id,
      instanceState,
      hasInstance: instanceState !== null,
    };
    const gql = vi.fn(
      async (_input: { variables?: { input?: { appliedHash?: string } } }) => ({
        workspaceTemplateReconcileSlugs: [entry],
        workspace: { templateSuggestions: { pageDefaultReplacements: [] } },
      }),
    );
    const bindings$ = new LiveData({});
    const service = Object.assign(
      Object.create(BuiltinTemplateReconcilerService.prototype),
      {
        workspaceService: { workspace: { id: "workspace", flavour: "cloud" } },
        workspaceServerService: { server: { gql } },
        bindings$,
        setting: { loading$: new LiveData(false) },
        docsService: {
          createDoc,
          createTemplateDoc,
          importNativeTemplateDoc,
          list: { doc$: () => new LiveData(source) },
        },
      },
    );
    await service.runReconcile();
    expect(createDoc).not.toHaveBeenCalled();
    expect(createTemplateDoc).not.toHaveBeenCalled();
    expect(importNativeTemplateDoc).not.toHaveBeenCalled();
    expect(source.moveToTrash).not.toHaveBeenCalled();
    expect(
      gql.mock.calls.every(
        ([input]) => !(input as any).variables?.input?.appliedHash,
      ),
    ).toBe(true);
    expect(Object.keys(bindings$.value)).toEqual(
      instanceState ? [source.id] : [],
    );
  },
);

test("a corrupt offline asset cannot fall back to a builder or change retained bindings", async () => {
  const ids$ = new LiveData({ custom: "retained" });
  const importNativeTemplateDoc = vi.fn(),
    createTemplateDoc = vi.fn();
  const service = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      workspaceService: {
        workspace: {
          flavour: "local",
          meta: {
            initialContentPolicy: WorkspaceInitialContentPolicy.LegacyDefaults,
          },
        },
      },
      workspaceServerService: { server: undefined },
      setting: {
        loading$: new LiveData(false),
        builtinTemplateInstanceDocIds$: ids$,
        setBuiltinTemplateInstanceDocIds: vi.fn(),
      },
      docsService: {
        importNativeTemplateDoc,
        createTemplateDoc,
        list: { doc$: () => new LiveData(undefined) },
      },
    },
  );
  vi.stubGlobal("environment", { publicPath: "/" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  try {
    await expect(
      service.ensureBuiltinTemplatesSeeded(["personal-journal"]),
    ).rejects.toThrow("checksum mismatch");
    expect(importNativeTemplateDoc).not.toHaveBeenCalled();
    expect(createTemplateDoc).not.toHaveBeenCalled();
    expect(
      service.setting.setBuiltinTemplateInstanceDocIds,
    ).not.toHaveBeenCalled();
    expect(ids$.value).toEqual({ custom: "retained" });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("direct cold reconcile waits for persisted local delivery bindings", async () => {
  const loading$ = new LiveData(true);
  const bindings$ = new LiveData<Record<string, string>>({});
  const importNativeTemplateDoc = vi.fn();
  const savedBindings = Object.fromEntries(
    nativeDocumentBundles.map((bundle) => [
      bundle.template_id,
      `saved-${bundle.template_id}`,
    ]),
  );
  const service = Object.assign(
    Object.create(BuiltinTemplateReconcilerService.prototype),
    {
      workspaceServerService: { server: undefined },
      workspaceService: {
        workspace: {
          flavour: "local",
          meta: {
            initialContentPolicy: WorkspaceInitialContentPolicy.LegacyDefaults,
          },
        },
      },
      docsService: {
        importNativeTemplateDoc,
        list: {
          doc$: (id: string) =>
            new LiveData({ id, trash$: new LiveData(false) }),
        },
      },
      setting: {
        loading$,
        builtinTemplateInstanceDocIds$: bindings$,
        setBuiltinTemplateInstanceDocIds: (ids: Record<string, string>) =>
          bindings$.next(ids),
      },
    },
  ) as BuiltinTemplateReconcilerService;
  const pending = service.reconcile();
  await Promise.resolve();
  expect(importNativeTemplateDoc).not.toHaveBeenCalled();
  bindings$.next(savedBindings);
  loading$.next(false);
  await pending;
  expect(importNativeTemplateDoc).not.toHaveBeenCalled();
  expect(bindings$.value).toEqual(savedBindings);
});

test("permanent native Empty policy prevents implicit seeding across repeated reconcile and reopen", async () => {
  for (let opening = 0; opening < 2; opening++) {
    const seed = vi.fn(async () => {});
    const records = new LiveData<Record<string, string>>({});
    const reconciler = Object.assign(
      Object.create(BuiltinTemplateReconcilerService.prototype),
      {
        workspaceServerService: { server: undefined },
        workspaceService: {
          workspace: {
            id: "native-empty",
            flavour: "local",
            meta: { initialContentPolicy: WorkspaceInitialContentPolicy.Empty },
          },
        },
        setting: {
          loading$: new LiveData(false),
          builtinTemplateInstanceDocIds$: records,
        },
        seedLocalBuiltinTemplates: seed,
      },
    ) as BuiltinTemplateReconcilerService;
    await reconciler.reconcile();
    await reconciler.reconcile();
    expect(
      await reconciler.ensureBuiltinTemplatesSeeded(["meeting-notes"]),
    ).toEqual({});
    expect(seed).not.toHaveBeenCalled();
    expect(records.value).toEqual({});
  }
});
