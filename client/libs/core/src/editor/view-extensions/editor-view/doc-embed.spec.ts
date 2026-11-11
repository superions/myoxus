import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import { GuardService } from "@myoxus/core/modules/permissions";
import { LiveData, type FrameworkProvider } from "@myoxus/infra";
import { Container } from "@virgultum/editor/global/di";
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
import {
  type BlockStdScope,
  LifeCycleWatcherIdentifier,
  StdIdentifier,
} from "@virgultum/editor/std";
import { describe, expect, test, vi } from "vitest";
import { patchDocEmbedService } from "./doc-embed";
import {
  render,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { JournalService } from "@myoxus/core/modules/journal";
import { PeekViewService } from "@myoxus/core/modules/peek-view/services/peek-view";
import {
  MyoxusPageReference,
  MyoxusSharedPageReference,
} from "@myoxus/core/components/myoxus/reference-link";
import { Text } from "@virgultum/editor/store";
import type { ParagraphBlockModel } from "@virgultum/editor/model";
import { TestWorkspace } from "@virgultum/editor/store/test";
import { getStoreManager } from "../../manager/store";

const referenceServices = vi.hoisted(() => new Map<unknown, unknown>());
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: (service: unknown) => referenceServices.get(service),
}));
vi.mock("@myoxus/core/modules/workbench", async (original) => ({
  ...(await original<typeof import("@myoxus/core/modules/workbench")>()),
  WorkbenchLink: (await import("react-router")).Link,
}));
vi.mock("@myoxus/core/modules/peek-view/view/modal-container", () => ({
  useInsidePeekView: () => false,
}));

function referenceFixture(
  shared: boolean,
  params = new URLSearchParams({
    mode: "page",
    blockIds: "instruction",
  }),
  initiallyReadable: boolean | null = true,
) {
  const workspace = new TestWorkspace({ id: "reference-workspace" });
  workspace.storeExtensions = getStoreManager()
    .config.init()
    .value.get("store");
  workspace.meta.initialize();
  const doc = workspace.createDoc("target");
  doc.load();
  const store = doc.getStore();
  const root = store.addBlock("myoxus:page", { title: new Text("Target") });
  const note = store.addBlock("myoxus:note", {}, root);
  store.addBlock(
    "myoxus:paragraph",
    { id: "instruction", text: new Text("Instruction") },
    note,
  );
  store.resetHistory();
  const permission = new LiveData<boolean | undefined>(
    initiallyReadable ?? undefined,
  );
  const trash = new LiveData(false);
  const record = new LiveData<
    { id: string; trash$: LiveData<boolean> } | undefined
  >({ id: "target", trash$: trash });
  const list = { doc$: vi.fn(() => record), isReady$: new LiveData(true) };
  const reference = {
    doc: {
      virgultumDoc: store,
      waitForSyncReady: vi.fn(async (_signal: AbortSignal) => {}),
    },
    release: vi.fn(),
  };
  const docs = { list, open: vi.fn(() => reference) };
  const guard = {
    can$: vi.fn(() => permission),
    can: vi.fn(async () => permission.value === true),
    revalidateDocPermissionIfMissing: vi.fn(),
  };
  const display = {
    title$: vi.fn(() => new LiveData("Target instruction")),
    icon$: vi.fn(() => new LiveData(() => null)),
  };
  const journal = { journalDate$: vi.fn(() => new LiveData(undefined)) };
  const peekView = { open: vi.fn(async () => {}), close: vi.fn() };
  referenceServices.set(WorkspaceService, { workspace: { id: workspace.id } });
  referenceServices.set(JournalService, journal);
  referenceServices.set(DocsService, docs);
  referenceServices.set(GuardService, guard);
  referenceServices.set(DocDisplayMetaService, display);
  referenceServices.set(PeekViewService, { peekView });
  const onClick = vi.fn((event) => event.preventDefault());
  const props = { pageId: "target", params, onClick };
  const mounted = render(
    createElement(
      MyoxusUIProvider,
      { env: "test" },
      createElement(
        MemoryRouter,
        {},
        shared
          ? createElement(MyoxusSharedPageReference, {
              ...props,
              docCollection: workspace,
            })
          : createElement(MyoxusPageReference, props),
      ),
    ),
  );
  return {
    ...mounted,
    workspace,
    store,
    note,
    permission,
    trash,
    record,
    docs,
    reference,
    guard,
    display,
    journal,
    peekView,
    onClick,
    dispose: () => {
      cleanup();
      referenceServices.clear();
      workspace.dispose();
    },
  };
}

test.each([false, true])(
  "focused native reference Enter does not reach retained editor selection (shared=%s)",
  async (shared) => {
    const mounted = referenceFixture(shared);
    const editorKey = vi.fn();
    document.addEventListener("keydown", editorKey);
    try {
      const link = await mounted.findByRole("link", {
        name: "Target instruction",
      });
      expect(
        new URL(
          link.getAttribute("href")!,
          "https://myoxus.example",
        ).searchParams.get("blockIds"),
      ).toBe("instruction");
      link.focus();
      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      fireEvent(link, enter);
      expect(editorKey).not.toHaveBeenCalled();
      expect(enter.defaultPrevented).toBe(false);
      fireEvent.keyDown(link, { key: "ArrowLeft" });
      expect(editorKey).toHaveBeenCalledOnce();
    } finally {
      document.removeEventListener("keydown", editorKey);
      mounted.dispose();
    }
  },
);

test.each([false, true])(
  "native reference reacts to rename, move, deletion and undo without changing identity (shared=%s)",
  async (shared) => {
    const fixture = referenceFixture(shared);
    try {
      const link = await fixture.findByRole("link", {
        name: "Target instruction",
      });
      const href = link.getAttribute("href");
      const model = fixture.store.getModelById(
        "instruction",
      )! as ParagraphBlockModel;
      act(() => {
        (model.props.text as Text).replace(
          0,
          "Instruction".length,
          "Renamed instruction",
        );
      });
      const nextNote = fixture.store.addBlock(
        "myoxus:note",
        {},
        fixture.store.root!.id,
      );
      act(() =>
        fixture.store.moveBlocks(
          [model],
          fixture.store.getModelById(nextNote)!,
        ),
      );
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("aria-disabled")).toBe("false");
      fixture.store.captureSync();
      act(() => fixture.store.deleteBlock(model));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("unavailable"),
      );
      expect(link.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(link, { shiftKey: true });
      expect(fixture.onClick).not.toHaveBeenCalled();
      expect(fixture.peekView.open).not.toHaveBeenCalled();
      fixture.store.captureSync();
      act(() => fixture.store.undo());
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("ready"),
      );
      expect(link.getAttribute("href")).toBe(href);
      fireEvent.click(link);
      expect(fixture.onClick).toHaveBeenCalledOnce();
    } finally {
      fixture.dispose();
    }
    expect(fixture.reference.release).toHaveBeenCalledOnce();
  },
);

test.each([false, true])(
  "pending and denied reference access never exposes cached metadata or loads a body (shared=%s)",
  async (shared) => {
    const fixture = referenceFixture(shared, undefined, null);
    try {
      const link = fixture.getByRole("link");
      expect(link.getAttribute("data-reference-state")).toBe("checking");
      expect(fixture.docs.list.doc$).not.toHaveBeenCalled();
      expect(fixture.docs.open).not.toHaveBeenCalled();
      expect(fixture.display.title$).not.toHaveBeenCalled();
      expect(fixture.display.icon$).not.toHaveBeenCalled();
      expect(fixture.journal.journalDate$).not.toHaveBeenCalled();
      act(() => fixture.permission.next(false));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("unavailable"),
      );
      fireEvent.click(link);
      expect(fixture.onClick).not.toHaveBeenCalled();
      expect(fixture.docs.open).not.toHaveBeenCalled();
      act(() => fixture.permission.next(true));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("ready"),
      );
      act(() => fixture.permission.next(false));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("unavailable"),
      );
      expect(link.textContent).not.toContain("Target instruction");
      expect(fixture.reference.release).toHaveBeenCalledOnce();
    } finally {
      fixture.dispose();
    }
  },
);

test.each([
  "blockIds=missing",
  "blockIds=",
  "blockIds=instruction&blockIds=other",
])(
  "missing or malformed precise targets never degrade into whole-document navigation (%s)",
  async (query) => {
    const fixture = referenceFixture(false, new URLSearchParams(query));
    try {
      const link = fixture.getByRole("link");
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("unavailable"),
      );
      fireEvent.click(link);
      expect(fixture.onClick).not.toHaveBeenCalled();
      expect(fixture.display.title$).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  },
);

test.each([false, true])(
  "whole-document references do not load bodies and react to trash (shared=%s)",
  async (shared) => {
    const fixture = referenceFixture(shared, new URLSearchParams());
    try {
      const link = await fixture.findByRole("link", {
        name: "Target instruction",
      });
      expect(fixture.docs.open).not.toHaveBeenCalled();
      act(() => fixture.trash.next(true));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("unavailable"),
      );
      fireEvent.click(link);
      expect(fixture.onClick).not.toHaveBeenCalled();
      act(() => fixture.trash.next(false));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("ready"),
      );
      act(() => fixture.record.next(undefined));
      await waitFor(() =>
        expect(link.getAttribute("data-reference-state")).toBe("unavailable"),
      );
    } finally {
      fixture.dispose();
    }
  },
);

test.each([false, true])(
  "access loss while a target loads cannot expose its title and releases its retained body (shared=%s)",
  async (shared) => {
    // Hold the first authority check so the real hook reaches the loading owner
    // only after this fixture has installed the pending synchronization boundary.
    const fixture = referenceFixture(shared, undefined, null);
    let complete!: () => void;
    fixture.reference.doc.waitForSyncReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    try {
      act(() => fixture.permission.next(true));
      await waitFor(() => expect(fixture.docs.open).toHaveBeenCalledOnce());
      expect(fixture.display.title$).not.toHaveBeenCalled();
      act(() => fixture.permission.next(false));
      expect(fixture.reference.release).toHaveBeenCalledOnce();
      await act(async () => complete());
      expect(
        fixture.getByRole("link").getAttribute("data-reference-state"),
      ).toBe("unavailable");
      expect(fixture.display.title$).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
    expect(fixture.reference.release).toHaveBeenCalledOnce();
  },
);

function setup(mounted: boolean) {
  const permission = new LiveData<boolean | undefined>(undefined);
  const guard = {
    can$: vi.fn(() => permission),
    can: vi.fn(async () => permission.value === true),
    revalidateDocPermissionIfMissing: vi.fn(),
  };
  const reference = {
    doc: {
      virgultumDoc: { load: vi.fn() },
      waitForSyncReady: vi.fn(async (_signal: AbortSignal) => {}),
    },
    release: vi.fn(),
  };
  const title = new LiveData("Current title");
  const trash = new LiveData(false);
  const docs = {
    open: vi.fn(() => reference),
    list: { doc$: vi.fn(() => new LiveData({ title$: title, trash$: trash })) },
  };
  const framework = {
    get: (service: unknown) =>
      service === GuardService
        ? guard
        : service === DocsService
          ? docs
          : service === WorkspaceService
            ? { workspace: { id: "test-workspace" } }
            : undefined,
  } as unknown as FrameworkProvider;
  if (!mounted) {
    const service = new CoreDocEmbedProvider(
      framework.get(GuardService),
      framework.get(DocsService),
      framework.get(WorkspaceService).workspace,
    );
    return {
      service,
      dispose: () => service.dispose(),
      permission,
      guard,
      docs,
      reference,
      title,
      trash,
    };
  }
  const Extension = patchDocEmbedService(framework);
  // Reproduce the production optimizer's anonymous returned class expression.
  Object.defineProperty(Extension, "name", { value: "" });
  const container = new Container();
  container.addImpl(StdIdentifier, () => ({}) as BlockStdScope);
  Extension.setup(container);
  const provider = container.provider();
  const service = provider.get(DocEmbedProvider);
  const lifecycle = provider.get(
    LifeCycleWatcherIdentifier("myoxus-doc-embed"),
  );
  expect(service).toBe(lifecycle);
  return {
    service: lifecycle as typeof lifecycle & DocEmbedProvider,
    dispose: () => lifecycle.unmounted(),
    permission,
    guard,
    docs,
    reference,
    title,
    trash,
  };
}

describe("host-owned document embed access and load lifecycle", () => {
  test.each([true, false])(
    "observing a fresh read grant does not repeat its request and still follows revocation (editor=%s)",
    async (mounted) => {
      const { service, permission, guard, docs, dispose } = setup(mounted);
      permission.next(true);
      try {
        expect(await service.canRead("read-only-copy")).toBe(true);
        const readable = service.readable("read-only-copy");
        expect(readable.value).toBe(true);
        expect(service.readable("read-only-copy")).toBe(readable);
        expect(guard.can).toHaveBeenCalledTimes(1);
        expect(guard.can).toHaveBeenCalledWith("Doc_Read", "read-only-copy");
        expect(guard.revalidateDocPermissionIfMissing).not.toHaveBeenCalled();
        permission.next(false);
        expect(readable.value).toBe(false);
        expect(await service.canRead("read-only-copy")).toBe(false);
        expect(guard.can).toHaveBeenCalledTimes(2);
        expect(docs.open).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
    },
  );
  test.each([true, false])(
    "a read finishing after host disposal cannot revive a grant or subscription (editor=%s)",
    async (mounted) => {
      const { service, guard, dispose } = setup(mounted);
      let finish!: (value: boolean) => void;
      guard.can.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finish = resolve)),
      );
      const pending = service.canRead("disposed-copy");
      dispose();
      finish(true);
      expect(await pending).toBe(false);
      expect(guard.can$).not.toHaveBeenCalled();
      expect(service.readable("disposed-copy").value).toBe(false);
    },
  );
  test.each([true])(
    "metadata read checks use the authoritative guard without opening a body (editor=%s)",
    async (mounted) => {
      const { service, permission, guard, docs, title, trash, dispose } =
        setup(mounted);
      try {
        expect(await service.canRead("opaque-key")).toBe(false);
        permission.next(true);
        expect(await service.canRead("opaque-key")).toBe(true);
        permission.next(false);
        expect(await service.canRead("opaque-key")).toBe(false);
        expect(guard.can).toHaveBeenCalledTimes(3);
        expect(guard.can).toHaveBeenCalledWith("Doc_Read", "opaque-key");
        expect(await service.referenceTitle!("opaque-key")).toBeUndefined();
        expect(docs.list.doc$).not.toHaveBeenCalled();
        permission.next(true);
        expect(await service.referenceTitle!("opaque-key")).toBe(
          "Current title",
        );
        title.next("Renamed title");
        expect(await service.referenceTitle!("opaque-key")).toBe(
          "Renamed title",
        );
        trash.next(true);
        expect(await service.referenceTitle!("opaque-key")).toBeUndefined();
        expect(docs.open).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
    },
  );
  test.each([true])(
    "pending and denied access never loads cached target content; revocation is reactive (editor=%s)",
    async (mounted) => {
      const { service, permission, docs, dispose } = setup(mounted);
      try {
        const readable = service.readable("opaque-key");
        expect(readable.value).toBeUndefined();
        expect(service.readable("opaque-key")).toBe(readable);
        await expect(
          service.waitForLoaded("opaque-key", new AbortController().signal),
        ).rejects.toThrow("access denied");
        expect(docs.open).not.toHaveBeenCalled();
        permission.next(true);
        expect(readable.value).toBe(true);
        permission.next(false);
        expect(readable.value).toBe(false);
      } finally {
        dispose();
      }
    },
  );
  test.each([true])(
    "existing document loading receives cancellation and releases ownership after access loss (editor=%s)",
    async (mounted) => {
      const { service, permission, reference, guard, dispose } = setup(mounted);
      permission.next(true);
      const controller = new AbortController();
      reference.doc.waitForSyncReady.mockImplementationOnce(async (signal) => {
        expect(signal).toBe(controller.signal);
        permission.next(false);
      });
      try {
        await expect(
          service.waitForLoaded("opaque-key", controller.signal),
        ).rejects.toThrow("access denied");
        expect(reference.doc.virgultumDoc.load).toHaveBeenCalledOnce();
        expect(reference.release).toHaveBeenCalledOnce();
        expect(guard.can).toHaveBeenCalledTimes(2);
        permission.next(true);
        controller.abort();
        await expect(
          service.waitForLoaded("opaque-key", controller.signal),
        ).rejects.toThrow();
        expect(reference.doc.virgultumDoc.load).toHaveBeenCalledOnce();
      } finally {
        dispose();
      }
    },
  );
});

test("qualified embed scopes use the existing pool, isolate same-key metadata and release each lease once", async () => {
  const local = setup(false);
  const foreign = setup(false);
  local.permission.next(true);
  foreign.permission.next(true);
  local.title.next("Local same-key title");
  foreign.title.next("Foreign same-key title");
  const release = vi.fn();
  const localRecord = new LiveData<
    { title$: LiveData<string>; trash$: LiveData<boolean> } | undefined
  >({ title$: local.title, trash$: local.trash });
  local.docs.list.doc$.mockReturnValue(localRecord as never);
  const resolveRedirect = vi.fn(async () => ({
    workspaceId: "foreign-workspace",
    id: "canonical-key",
  }));
  const foreignWorkspace = {
    id: "foreign-workspace",
    docCollection: {},
    scope: {
      get: (service: unknown) =>
        service === GuardService ? foreign.guard : foreign.docs,
    },
  };
  const pool = {
    openByWorkspaceId: vi.fn((id: string) =>
      id === foreignWorkspace.id
        ? { workspace: foreignWorkspace, dispose: release }
        : undefined,
    ),
  };
  const workspace = {
    id: "source-workspace",
    docCollection: {},
    scope: {
      get: (service: unknown) =>
        service === WorkspacesService
          ? pool
          : service === WorkspaceContentOperationService
            ? { resolveRedirect }
            : undefined,
    },
  };
  const host = new CoreDocEmbedProvider(
    local.guard as unknown as GuardService,
    local.docs as unknown as DocsService,
    workspace as never,
  );
  try {
    expect(await host.referenceTitle("same-key")).toBe("Local same-key title");
    const target = host.inWorkspace("foreign-workspace")!;
    expect(target.collection).toBe(foreignWorkspace.docCollection);
    expect(await target.access.referenceTitle!("same-key")).toBe(
      "Foreign same-key title",
    );
    foreign.permission.next(false);
    expect(await target.access.referenceTitle!("same-key")).toBeUndefined();
    expect(await host.referenceTitle("same-key")).toBe("Local same-key title");
    expect(host.inWorkspace("unknown-workspace")).toBeUndefined();
    target.dispose();
    target.dispose();
    expect(release).toHaveBeenCalledOnce();
    host.inWorkspace("foreign-workspace");
    const binding = host.openReference(undefined, "same-key");
    expect(binding.target.value?.collection).toBe(workspace.docCollection);
    local.permission.next(false);
    expect(
      await binding.target.value!.access.referenceTitle!("same-key"),
    ).toBeUndefined();
    expect(resolveRedirect).not.toHaveBeenCalled(); // A denied live source never falls through.
    foreign.permission.next(true);
    localRecord.next(undefined);
    await waitFor(() =>
      expect(binding.target.value?.docId).toBe("canonical-key"),
    );
    expect(binding.target.value!.collection).toBe(
      foreignWorkspace.docCollection,
    );
    expect(
      await binding.target.value!.access.referenceTitle!("canonical-key"),
    ).toBe("Foreign same-key title");
    foreign.permission.next(false);
    expect(
      await binding.target.value!.access.referenceTitle!("canonical-key"),
    ).toBeUndefined();
    localRecord.next({ title$: local.title, trash$: local.trash });
    let finish!: (address: { workspaceId: string; id: string }) => void;
    resolveRedirect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    localRecord.next(undefined);
    const leases = pool.openByWorkspaceId.mock.calls.length;
    binding.dispose();
    finish({ workspaceId: foreignWorkspace.id, id: "canonical-key" });
    await Promise.resolve();
    expect(pool.openByWorkspaceId).toHaveBeenCalledTimes(leases);
    expect(binding.target.value).toBeUndefined(); // Late results cannot recreate a disposed scope.
  } finally {
    host.dispose();
    local.dispose();
    foreign.dispose();
  }
  expect(release).toHaveBeenCalledTimes(3);
});

test.each(["root", "abort"])(
  "embed loading retains its lease until remote materialization or cancellation (%s)",
  async (outcome) => {
    const workspace = new TestWorkspace({ id: "embed-load-readiness" });
    workspace.storeExtensions = getStoreManager()
      .config.init()
      .value.get("store");
    workspace.meta.initialize();
    const doc = workspace.createDoc("target");
    doc.load();
    const store = doc.getStore();
    const reference = {
      doc: { virgultumDoc: store, waitForSyncReady: vi.fn(async () => {}) },
      release: vi.fn(),
    };
    const guard = {
      can: vi.fn(async () => true),
      can$: () => new LiveData(true),
    };
    const host = new CoreDocEmbedProvider(
      guard as unknown as GuardService,
      { open: () => reference } as unknown as DocsService,
      { id: workspace.id } as never,
    );
    const abort = new AbortController();
    try {
      const waiting = host.waitForLoaded("target", abort.signal);
      await waitFor(() =>
        expect(reference.doc.waitForSyncReady).toHaveBeenCalledOnce(),
      );
      expect(
        await Promise.race([
          waiting.then(() => "loaded"),
          new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
        ]),
      ).toBe("pending");
      expect(reference.release).not.toHaveBeenCalled();
      if (outcome === "root") {
        store.addBlock("myoxus:page", {
          title: new Text("Loaded remote root"),
        });
        await waiting;
      } else {
        abort.abort();
        await expect(waiting).rejects.toThrow();
      }
      expect(reference.release).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      host.dispose();
      workspace.dispose();
    }
  },
);
