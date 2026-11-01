// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { Framework, LiveData } from "@myoxus/infra";
import type { BpmnEditorRef, BpmnSnapshot } from "@myoxus/bpmn-editor";
import {
  createBpmnBlockInsertProps,
  commitBpmnSourceRevision,
  readBpmnSourceRevisions,
} from "@virgultum/block-bpmn";
import {
  BpmnBlockSchemaExtension,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
  type BpmnBlockModel,
} from "@virgultum/model";
import { TestWorkspace } from "@virgultum/store/test";
import { afterEach, expect, test, vi } from "vitest";
import { mergeUpdates } from "yjs";
import { BpmnEditorService } from "./session";
vi.mock("@myoxus/bpmn-editor/preview", () => ({
  prepareBpmnPreviewSvg: (svg: string, revision: string) =>
    svg.replace("<svg ", `<svg data-bpmn-source-revision="${revision}" `),
}));
import type { WorkspaceService } from "../workspace";
import type { DocsService, Doc } from "../doc";
import type { GuardService } from "../permissions";
import type { WorkspaceDialogService } from "../dialogs";
import type { MyoxusBpmnEditorCloseResult } from "@virgultum/shared/services";
import { MyoxusHostCapability } from "@virgultum/shared/services";
import {
  createMyoxusHostServiceAdapter,
  type MyoxusHostAdapterDeps,
} from "../../editor/virgultum/doc-editor/myoxus-host-adapter";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
});
function fixture() {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  const doc = workspace.createDoc();
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      BpmnBlockSchemaExtension,
    ],
  });
  const page = store.addBlock("myoxus:page");
  const note = store.addBlock("myoxus:note", {}, page);
  const blockId = store.addBlock(
    "myoxus:bpmn",
    createBpmnBlockInsertProps(),
    note,
  );
  const block = store.getBlock(blockId)!.model as BpmnBlockModel;
  const permission = new LiveData<boolean | undefined>(true);
  const guard = {
    can: vi.fn(async () => true),
    can$: () => permission,
  };
  const liveDoc = {
    id: doc.id,
    yDoc: doc.spaceDoc,
    virgultumDoc: store,
    trash$: new LiveData(false),
    waitForSyncReady: vi.fn(async () => {}),
  } as unknown as Doc;
  const release = vi.fn();
  const docs = { open: vi.fn(() => ({ doc: liveDoc, release })) };
  const storage = {
    updateAndWaitForSaved: vi.fn(async (_id: string, write: () => void) => {
      write();
    }),
    saveCapturedUpdateAndWaitForSaved: vi.fn(async () => {}),
    waitForSynced: vi.fn(async (_id: string, _signal?: AbortSignal) => {}),
  };
  let session: import("./session").BpmnEditorSession | undefined;
  let finish: ((result?: MyoxusBpmnEditorCloseResult) => void) | undefined;
  let beforeClose: (() => boolean | Promise<boolean>) | undefined;
  const dialogs = {
    open: vi.fn(
      (
        _type: string,
        props: { session: typeof session },
        callback: typeof finish,
        options?: { beforeClose?: () => boolean | Promise<boolean> },
      ) => {
        session = props.session;
        finish = callback;
        beforeClose = options?.beforeClose;
        return "dialog";
      },
    ),
    close: vi.fn(() => {
      const result = beforeClose?.() ?? true;
      if (typeof result === "boolean") {
        if (result) finish?.();
        return result;
      }
      return result.then((allowed) => {
        if (allowed) finish?.();
        return allowed;
      });
    }),
  };
  const framework = new Framework();
  framework.service(
    BpmnEditorService,
    () =>
      new BpmnEditorService(
        {
          workspace: {
            id: "workspace",
            flavour: "affine-cloud",
            engine: { doc: storage },
          },
        } as unknown as WorkspaceService,
        docs as unknown as DocsService,
        guard as unknown as GuardService,
        dialogs as unknown as WorkspaceDialogService,
      ),
  );
  const service = framework.provider().get(BpmnEditorService);
  cleanup.push(() => {
    service.dispose();
    store.dispose();
    doc.dispose();
    workspace.dispose();
    workspace.doc.destroy();
  });
  const request = {
    workspaceId: "workspace",
    docId: doc.id,
    blockId,
    editorHostId: "host",
  };
  return {
    service,
    request,
    docs,
    release,
    dialogs,
    storage,
    block,
    permission,
    guard,
    store,
    session: () => session!,
    finish: () => finish!(),
  };
}
test("preview publication follows only the latest durable head and close waits for its derived artifact", async () => {
  const f = fixture();
  const opened = f.service.open(f.request);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledOnce());
  const session = f.session(),
    initial = session.state$.value.source!;
  const first = Promise.withResolvers<BpmnSnapshot & { svg: string }>();
  const latest = Promise.withResolvers<BpmnSnapshot & { svg: string }>();
  const exportSvg = vi
    .fn<BpmnEditorRef["exportSvg"]>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  let working: BpmnSnapshot = { ...initial, baseRevision: initial.revision };
  session.attach({
    flush: () => working,
    exportSvg,
    replaceSource: vi.fn(),
    discard: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    fitToContent: vi.fn(),
  });
  session.reportReadiness({ status: "ready" });
  await vi.waitFor(() => expect(exportSvg).toHaveBeenCalledOnce());
  working = {
    revision: "preview-newer",
    baseRevision: initial.revision,
    xml: initial.xml.replace("<process", '<process name="newer"'),
  };
  await session.save(working);
  const head = readBpmnSourceRevisions(f.block.yBlock).selected!;
  const closing = f.dialogs.close();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><text x="4" y="20">Latest</text></svg>';
  first.resolve({ ...initial, baseRevision: initial.revision, svg });
  await vi.waitFor(() => expect(exportSvg).toHaveBeenCalledTimes(2));
  expect(f.block.props.preview).toBeNull();
  expect(f.release).not.toHaveBeenCalled();
  latest.resolve({ ...working, svg });
  await expect(closing).resolves.toBe(true);
  await opened;
  expect(f.block.props.preview?.revision).toBe(head);
  const blob = await f.store.blobSync.get(f.block.props.preview!.sourceId);
  expect(await blob!.text()).toContain(`data-bpmn-source-revision="${head}"`);
  expect([...readBpmnSourceRevisions(f.block.yBlock).heads.values()]).toEqual([
    working.xml,
  ]);
  expect(f.release).toHaveBeenCalledOnce();
});

test("a timed-out preview retains last-good metadata, settles close and rejects a late render", async () => {
  const f = fixture();
  const opened = f.service.open(f.request);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledOnce());
  const session = f.session(),
    source = session.state$.value.source!;
  const lastGood = { revision: "previous", sourceId: "last-good" };
  f.store.updateBlock(f.block, { preview: lastGood });
  const rendered = Promise.withResolvers<BpmnSnapshot & { svg: string }>();
  const exportSvg = vi.fn(() => rendered.promise);
  const setBlob = vi.spyOn(f.store.blobSync, "set");
  session.attach({
    flush: () => ({ ...source, baseRevision: source.revision }),
    exportSvg,
    replaceSource: vi.fn(),
    discard: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    fitToContent: vi.fn(),
  });
  vi.useFakeTimers();
  try {
    session.reportReadiness({ status: "ready" });
    await Promise.resolve();
    expect(exportSvg).toHaveBeenCalledOnce();
    const closing = f.dialogs.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(closing).resolves.toBe(true);
    await opened;
    expect(f.block.props.preview).toEqual(lastGood);
    expect(f.block.props.previewErrorRevision).toBe(
      readBpmnSourceRevisions(f.block.yBlock).selected,
    );
    rendered.resolve({
      ...source,
      baseRevision: source.revision,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    await Promise.resolve();
    expect(setBlob).not.toHaveBeenCalled();
    expect([...readBpmnSourceRevisions(f.block.yBlock).heads.values()]).toEqual(
      [source.xml],
    );
  } finally {
    vi.useRealTimers();
    setBlob.mockRestore();
  }
});
test("reserves one live lease/dialog before async resolution and refuses a missing block", async () => {
  const f = fixture();
  const removeGuard = vi.fn(),
    removeOtherGuard = vi.fn();
  let viewClose!: () => boolean | Promise<boolean>;
  const originView = {
    registerCloseGuard: vi.fn((guard: typeof viewClose) => {
      viewClose = guard;
      return removeGuard;
    }),
  };
  const otherView = { registerCloseGuard: vi.fn(() => removeOtherGuard) };
  const adapter = createMyoxusHostServiceAdapter({
    bpmnEditorService: f.service,
    bpmnEditorView: originView,
    store: f.store,
  } as unknown as MyoxusHostAdapterDeps);
  expect(adapter.capabilities.has(MyoxusHostCapability.BpmnEditorSession)).toBe(
    true,
  );
  const first = adapter.openBpmnEditor!(f.request);
  const second = f.service.open(
    { ...f.request, editorHostId: "another-host" },
    false,
    otherView as unknown as import("../workbench/entities/view").View,
  );
  expect(second).toBe(first);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledOnce());
  expect(f.docs.open).toHaveBeenCalledOnce();
  expect(originView.registerCloseGuard).toHaveBeenCalledOnce();
  expect(otherView.registerCloseGuard).toHaveBeenCalledOnce();
  expect(f.release).not.toHaveBeenCalled();
  const session = f.session();
  const original = session.state$.value.source!;
  let working: BpmnSnapshot = { ...original, baseRevision: original.revision };
  const discard = vi.fn();
  session.attach({
    flush: () => working,
    discard,
    replaceSource: vi.fn(),
    exportSvg: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    fitToContent: vi.fn(),
  });
  session.report({ ...session.state$.value.command, dirty: true });
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(false);
  const canceled = viewClose();
  expect(session.closePrompt$.value).toBe(true);
  expect(f.release).not.toHaveBeenCalled();
  await session.answerClose("cancel");
  await expect(canceled).resolves.toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  // Happy DOM aliases PageTransitionEvent to Event and drops its persisted init.
  const resumedPermission = Promise.withResolvers<boolean>();
  f.guard.can.mockReturnValueOnce(resumedPermission.promise);
  for (const type of ["pagehide", "pageshow"]) {
    const transition = new Event(type);
    Object.defineProperty(transition, "persisted", { value: true });
    window.dispatchEvent(transition);
  }
  expect(f.release).not.toHaveBeenCalled();
  expect(f.guard.can).toHaveBeenCalledWith("Doc_Update", f.request.docId);
  expect(session.state$.value.command.dirty).toBe(true);
  expect(session.state$.value.readOnly).toBe(true);
  resumedPermission.resolve(true);
  // No can$ change notification: an unchanged grant must still release the lock.
  await vi.waitFor(() => expect(session.state$.value.readOnly).toBe(false));
  const olderFocus = Promise.withResolvers<boolean>();
  f.guard.can
    .mockReturnValueOnce(olderFocus.promise)
    .mockResolvedValueOnce(false);
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(session.state$.value.phase).toBe("access-lost"),
  );
  f.permission.next(false);
  f.guard.can.mockResolvedValue(false);
  olderFocus.resolve(true);
  await olderFocus.promise;
  // A real GuardService publishes old replies to can$ as well as resolving
  // their promises. That stream must not reopen the gate before confirmation.
  f.permission.next(true);
  expect(session.state$.value.readOnly).toBe(true);
  await vi.waitFor(() =>
    expect(session.state$.value.phase).toBe("access-lost"),
  );
  expect(session.state$.value.command.dirty).toBe(true);
  expect(f.storage.updateAndWaitForSaved).not.toHaveBeenCalled();
  f.guard.can.mockResolvedValue(true);
  window.dispatchEvent(new Event("online"));
  await vi.waitFor(() => expect(session.state$.value.readOnly).toBe(false));
  working = {
    revision: "close-candidate",
    baseRevision: original.revision,
    xml: original.xml.replace("<process", '<process name="close candidate"'),
  };
  const captured = working;
  const local = Promise.withResolvers<void>();
  f.storage.updateAndWaitForSaved.mockImplementationOnce(async (_id, write) => {
    write();
    await local.promise;
  });
  const saveClosing = f.dialogs.close();
  const answering = session.answerClose("save");
  await vi.waitFor(() =>
    expect(f.storage.updateAndWaitForSaved).toHaveBeenCalledOnce(),
  );
  working = {
    ...working,
    revision: "new-close-candidate",
    xml: working.xml.replace('name="close candidate"', 'name="newer edit"'),
  };
  local.resolve();
  await answering;
  await expect(saveClosing).resolves.toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  expect(session.state$.value.source?.xml).toBe(captured.xml);
  const discarded = f.dialogs.close();
  await session.answerClose("discard");
  await expect(discarded).resolves.toBe(true);
  expect(discard).toHaveBeenCalledOnce();
  expect([...readBpmnSourceRevisions(f.block.yBlock).heads.values()]).toEqual([
    captured.xml,
  ]);
  await expect(first).resolves.toMatchObject({ status: "discarded" });
  expect(f.release).toHaveBeenCalledOnce();
  expect(removeGuard).toHaveBeenCalledOnce();
  expect(removeOtherGuard).toHaveBeenCalledOnce();
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(true);
  await expect(
    f.service.open({ ...f.request, blockId: "missing" }),
  ).rejects.toThrow("BPMN_BLOCK_NOT_FOUND");
  expect(f.dialogs.open).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledTimes(2);
  const teardown = f.service.open(f.request);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledTimes(2));
  f.session().report({ ...f.session().state$.value.command, dirty: true });
  const interrupted = f.dialogs.close();
  f.service.dispose();
  await expect(interrupted).resolves.toBe(false);
  await expect(teardown).resolves.toMatchObject({ status: "closed" });
  expect(f.release).toHaveBeenCalledTimes(3);
});
test("acknowledges only completed storage, advances queued own candidates, and preserves failed exact deltas for retry", async () => {
  const f = fixture();
  const result = f.service.open(f.request);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledOnce());
  const session = f.session();
  const source = session.state$.value.source!;
  session.reportReadiness({ status: "ready" });
  await vi.waitFor(() => expect(session.state$.value.phase).toBe("saved"));
  const firstRemote = Promise.withResolvers<void>();
  const secondRemote = Promise.withResolvers<void>();
  const remoteWaits = [firstRemote, secondRemote];
  const observedWaits: AbortSignal[] = [];
  f.storage.waitForSynced.mockImplementation(async (id, signal) => {
    if (id !== f.request.docId) return;
    const waiting = remoteWaits.shift();
    if (waiting) {
      observedWaits.push(signal!);
      // Completion can race cancellation; the controller must correlate the
      // selected revision even if an underlying promise completes afterwards.
      await waiting.promise;
    }
  });
  let complete!: () => void;
  f.storage.updateAndWaitForSaved.mockImplementationOnce(async (_id, write) => {
    write();
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  const first = {
    revision: "candidate-1",
    baseRevision: source.revision,
    xml: source.xml.replace("<process", '<process name="first"'),
  };
  const saving = session.save(first);
  await vi.waitFor(() =>
    expect(f.storage.updateAndWaitForSaved).toHaveBeenCalledOnce(),
  );
  expect(session.state$.value.source).toEqual(source);
  expect(session.state$.value.phase).toBe("saving-local");
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(false);
  const second = {
    revision: "candidate-2",
    baseRevision: source.revision,
    xml: source.xml.replace("<process", '<process name="second"'),
  };
  const queued = session.save(second);
  complete();
  await saving;
  await queued;
  await vi.waitFor(() => expect(observedWaits).toHaveLength(2));
  expect(session.state$.value.phase).toBe("awaiting-remote");
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(true);
  expect(observedWaits[0].aborted).toBe(true);
  firstRemote.resolve();
  await Promise.resolve();
  expect(session.state$.value.phase).toBe("awaiting-remote");
  session.report({ ...session.state$.value.command, dirty: true });
  session.reportReadiness({ status: "render-error" });
  secondRemote.resolve();
  await vi.waitFor(() =>
    expect(session.state$.value.durability?.remote).toBe(true),
  );
  expect(session.state$.value.phase).toBe("fatal");
  session.reportReadiness({ status: "ready" });
  expect(session.state$.value.phase).toBe("ready-dirty");
  session.report({ ...session.state$.value.command, dirty: false });
  expect(session.state$.value.phase).toBe("saved");
  expect(readBpmnSourceRevisions(f.block.yBlock).heads.size).toBe(1);
  expect(session.state$.value.source?.xml).toBe(second.xml);
  f.storage.updateAndWaitForSaved.mockImplementationOnce(async (_id, write) => {
    write();
    throw new Error("storage failure");
  });
  const failed = {
    revision: "candidate-3",
    baseRevision: second.revision,
    xml: source.xml.replace("<process", '<process name="recoverable"'),
  };
  const failedUpdates: Uint8Array[] = [];
  const capture = (update: Uint8Array) => failedUpdates.push(update.slice());
  const yDoc = f.block.yBlock.doc!;
  yDoc.on("update", capture);
  try {
    await expect(session.save(failed)).rejects.toThrow("storage failure");
  } finally {
    yDoc.off("update", capture);
  }
  expect(session.state$.value.source?.xml).toBe(second.xml);
  const retryLocal = Promise.withResolvers<void>();
  const retryRemote = Promise.withResolvers<void>();
  remoteWaits.push(retryRemote);
  f.storage.saveCapturedUpdateAndWaitForSaved.mockImplementationOnce(
    async () => {
      await retryLocal.promise;
    },
  );
  const retrying = session.retry();
  await vi.waitFor(() =>
    expect(f.storage.saveCapturedUpdateAndWaitForSaved).toHaveBeenCalledOnce(),
  );
  expect(f.storage.saveCapturedUpdateAndWaitForSaved).toHaveBeenCalledWith(
    f.request.docId,
    mergeUpdates(failedUpdates),
  );
  expect(session.state$.value.source?.xml).toBe(second.xml);
  retryLocal.resolve();
  await retrying;
  await vi.waitFor(() => expect(observedWaits).toHaveLength(3));
  expect(session.state$.value.phase).toBe("awaiting-remote");
  expect(readBpmnSourceRevisions(f.block.yBlock).heads.size).toBe(1);
  expect(session.state$.value.source?.xml).toBe(failed.xml);
  retryRemote.resolve();
  const storageWrites = f.storage.updateAndWaitForSaved.mock.calls.length;
  const permissionStarted = Promise.withResolvers<void>();
  const stalePermission = Promise.withResolvers<boolean>();
  f.guard.can.mockImplementationOnce(() => {
    permissionStarted.resolve();
    return stalePermission.promise;
  });
  const denied = {
    revision: "permission-race",
    baseRevision: failed.revision,
    xml: failed.xml.replace('name="recoverable"', 'name="must not persist"'),
  };
  session.report({ ...session.state$.value.command, dirty: true });
  const savingAfterRevocation = session.save(denied);
  await permissionStarted.promise;
  f.permission.next(false);
  stalePermission.resolve(true);
  await expect(savingAfterRevocation).rejects.toThrow("BPMN_READ_ONLY");
  expect(session.state$.value.readOnly).toBe(true);
  expect(session.state$.value.phase).toBe("access-lost");
  expect(session.state$.value.command.dirty).toBe(true);
  expect(f.storage.updateAndWaitForSaved).toHaveBeenCalledTimes(storageWrites);
  expect([...readBpmnSourceRevisions(f.block.yBlock).heads.values()]).toEqual([
    failed.xml,
  ]);
  f.finish();
  await result;
});
test("stages exact file bytes without mutation and never replaces an unseen concurrent source", async () => {
  const f = fixture();
  const result = f.service.open(f.request);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledOnce());
  const session = f.session();
  const original = session.state$.value.source!;
  const before = f.block.yBlock.toJSON();
  const rejected = session.prepareImport(new Uint8Array([0xc0, 0xaf]));
  await expect(session.replaceSource(rejected)).rejects.toThrow(
    "BPMN_REPLACE_UNAVAILABLE",
  );
  expect(f.block.yBlock.toJSON()).toEqual(before);
  expect(session.state$.value.source).toEqual(original);
  expect(f.storage.updateAndWaitForSaved).not.toHaveBeenCalled();
  const exact =
    "\uFEFF" +
    original.xml
      .replace("<process", '<process name="file"')
      .replaceAll("\n", "\r\n");
  const candidate = session.prepareImport(new TextEncoder().encode(exact));
  const replaceSource = vi.fn((xml: string) => ({
    revision: "fork-import-command",
    baseRevision: original.revision,
    xml,
  }));
  session.attach({
    replaceSource,
    flush: () => ({ ...original, baseRevision: original.revision }),
    exportSvg: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    fitToContent: vi.fn(),
    discard: vi.fn(),
  });
  await session.replaceSource(candidate);
  expect(session.state$.value.source?.xml).toBe(exact);
  const staged = session.prepareImport(new TextEncoder().encode(original.xml));
  const state = readBpmnSourceRevisions(f.block.yBlock);
  if (!state.selected)
    throw new Error("Expected a single source before the competing write");
  commitBpmnSourceRevision(f.block.yBlock, {
    id: crypto.randomUUID(),
    parent: state.selected,
    source: exact.replace('name="file"', 'name="foreign"'),
    supersedes: [],
  });
  const remote = f.block.yBlock.toJSON();
  await expect(session.replaceSource(staged)).rejects.toThrow(
    "BPMN_REPLACE_STALE",
  );
  expect(replaceSource).toHaveBeenCalledOnce();
  await expect(session.retry()).rejects.toThrow("BPMN_SAVE_FAILED");
  expect(f.block.yBlock.toJSON()).toEqual(remote);
  commitBpmnSourceRevision(f.block.yBlock, {
    id: crypto.randomUUID(),
    parent: original.revision,
    source: original.xml,
    supersedes: [],
  });
  const reviewed = [...session.state$.value.heads.keys()];
  expect(reviewed).toHaveLength(2);
  const versions = new Map(session.downloadSources());
  session.report({
    dirty: true,
    pendingFields: false,
    canUndo: true,
    canRedo: false,
  });
  await expect(
    session.resolveConflict(reviewed, { head: reviewed[0]! }),
  ).rejects.toThrow("BPMN_CONFLICT_LOCAL_CHANGES");
  session.report({
    dirty: false,
    pendingFields: false,
    canUndo: false,
    canRedo: false,
  });
  const permission = Promise.withResolvers<boolean>();
  f.guard.can.mockReturnValueOnce(permission.promise);
  const stale = session.resolveConflict(reviewed, { head: reviewed[0]! });
  await vi.waitFor(() =>
    expect(f.guard.can).toHaveLastReturnedWith(permission.promise),
  );
  const delayed = crypto.randomUUID();
  commitBpmnSourceRevision(f.block.yBlock, {
    id: delayed,
    parent: original.revision,
    source: original.xml.replace("<process", '<process name="delayed"'),
    supersedes: [],
  });
  permission.resolve(true);
  await expect(stale).rejects.toThrow("BPMN_CONFLICT_CHANGED");
  expect(session.state$.value.error).toBe(false);
  expect(session.downloadSources().size).toBe(3);
  for (const [id, xml] of versions)
    expect(session.downloadSources().get(id)).toBe(xml);
  const observed = [...session.downloadSources().keys()],
    chosen = observed[0]!,
    chosenXml = session.downloadSources().get(chosen)!;
  const beforeAck = session.state$.value.source;
  f.storage.updateAndWaitForSaved.mockImplementationOnce(async (_id, write) => {
    write();
    throw new Error("disk unavailable");
  });
  await expect(
    session.resolveConflict(observed, { head: chosen }),
  ).rejects.toThrow("disk unavailable");
  const applied = readBpmnSourceRevisions(f.block.yBlock);
  expect([...applied.heads.values()]).toEqual([chosenXml]);
  f.block.yBlock.set(
    "prop:caption",
    "unrelated update while awaiting local retry",
  );
  expect(session.state$.value.source).toBe(beforeAck);
  await session.retry();
  expect(readBpmnSourceRevisions(f.block.yBlock).selected).toBe(
    applied.selected,
  );
  expect(session.state$.value.source?.xml).toBe(chosenXml);
  expect(session.state$.value.conflict).toBe(false);
  expect(session.state$.value.heads.size).toBe(1);
  commitBpmnSourceRevision(f.block.yBlock, {
    id: crypto.randomUUID(),
    parent: original.revision,
    source: original.xml,
    supersedes: [],
  });
  expect(session.state$.value.conflict).toBe(true);
  const merge = session.prepareImport(new TextEncoder().encode(exact));
  await session.replaceSource(merge);
  expect([...session.downloadSources().values()]).toEqual([exact]);
  expect(session.state$.value.source?.xml).toBe(exact);
  expect(replaceSource).toHaveBeenCalledOnce(); // Resolution resets via source props, not local import history.
  f.finish();
  await result;
});
test("rejects an SVG whose candidate changes while its isolated fonts are materialized", async () => {
  const f = fixture();
  const result = f.service.open(f.request);
  await vi.waitFor(() => expect(f.dialogs.open).toHaveBeenCalledOnce());
  const session = f.session();
  const source = session.state$.value.source!;
  let current: BpmnSnapshot = { ...source, baseRevision: source.revision };
  const fonts = Promise.withResolvers<void>();
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: fonts.promise },
  });
  const editor: BpmnEditorRef = {
    replaceSource: vi.fn(),
    flush: () => current,
    exportSvg: async () => ({
      ...current,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" data-bpmn-export-fixture="true" viewBox="0 0 100 40"><text x="2" y="20">Candidate</text></svg>',
    }),
    undo() {},
    redo() {},
    async fitToContent() {},
    discard() {},
  };
  session.attach(editor);
  try {
    const exporting = session.exportSvg();
    const rejected = expect(exporting).rejects.toThrow("BPMN_STALE_SNAPSHOT");
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-bpmn-export-fixture="true"]'),
      ).not.toBeNull(),
    );
    current = {
      ...current,
      revision: "new-candidate",
      xml: current.xml.replace("<process", '<process name="changed"'),
    };
    fonts.resolve();
    await rejected;
    expect(
      document.querySelector('[data-bpmn-export-fixture="true"]'),
    ).toBeNull();
    expect(f.storage.updateAndWaitForSaved).not.toHaveBeenCalled();
  } finally {
    fonts.resolve();
    if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
    else Reflect.deleteProperty(document, "fonts");
    f.finish();
    await result;
  }
});
