// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BpmnCommandState,
  BpmnEditorRef,
  BpmnSnapshot,
  BpmnSourceRevision,
  BpmnReadiness,
} from "@myoxus/bpmn-editor";
import {
  inspectBpmnBytes,
  inspectBpmnSource,
  type BpmnByteInspection,
} from "@myoxus/bpmn-editor/source";
import { prepareBpmnPreviewSvg } from "@myoxus/bpmn-editor/preview";
import { LiveData, Service } from "@myoxus/infra";
import {
  commitBpmnSourceRevision,
  readBpmnSourceRevisions,
  isBpmnBlockModel,
  coerceBpmnBlockText,
  BPMN_SOURCE_TRANSACTION_ORIGIN,
} from "@virgultum/block-bpmn";
import type { BpmnBlockModel } from "@virgultum/model";
import type {
  MyoxusBpmnEditorRequest,
  MyoxusBpmnEditorCloseResult,
} from "@virgultum/shared/services";
import { mergeUpdates } from "yjs";
import type { Doc, DocsService } from "../doc";
import type { WorkspaceDialogService } from "../dialogs";
import type { GuardService } from "../permissions";
import type { WorkspaceService } from "../workspace";
import type { View } from "../workbench/entities/view";
import { materializeDiagramExportSvg } from "../../components/hooks/myoxus/diagram-export-svg";

/** The phase is a projection of live guards and revision-correlated operations,
 * not an independent flag the dialog may advance. Dirty outranks an older sync
 * ACK; deleted/fatal guards cannot be cleared by asynchronous completions. */
export type BpmnSessionPhase =
  | "loading"
  | "ready-clean"
  | "ready-dirty"
  | "saving-local"
  | "awaiting-remote"
  | "saved"
  | "conflict"
  | "source-error"
  | "save-error"
  | "access-lost"
  | "deleted"
  | "fatal";
type SessionState = {
  phase: BpmnSessionPhase;
  blockTitle: string;
  source: BpmnSourceRevision | null;
  readOnly: boolean;
  conflict: boolean;
  /** Live terminal heads only. A resolution must capture and recheck these IDs;
   * the LWW selection hint is never authority during a conflict. */
  heads: ReadonlyMap<string, string>;
  missing: boolean;
  busy: boolean;
  error: boolean;
  command: BpmnCommandState;
  /** The locally durable candidate and persisted head are different identities.
   * A remote confirmation belongs to both, never to a generic idle indicator. */
  durability: { revision: string; head: string; remote: boolean } | null;
  syncError: boolean;
};
type CapturedSave = {
  snapshot: BpmnSnapshot;
  id: string;
  update?: Uint8Array;
  replacementBase?: string;
};
type ConflictResolution = { parent: string; heads: readonly string[] };
export type BpmnImportCandidate = {
  inspection: BpmnByteInspection;
  base: string | null;
  /** Importing a manual merge is an explicit resolution of this observed set. */
  conflictHeads: readonly string[];
};

/** Owns the leased live block and its source-revision writes; the dialog only renders this controller. */
export class BpmnEditorSession {
  readonly state$: LiveData<SessionState>;
  readonly focus$ = new LiveData(0);
  readonly closePrompt$ = new LiveData(false);
  closeResult: MyoxusBpmnEditorCloseResult | undefined;
  private closeDecision: {
    promise: Promise<boolean>;
    resolve: (allowed: boolean) => void;
  } | null = null;
  private editor: BpmnEditorRef | null = null;
  private disposed = false;
  private readonly abort = new AbortController();
  private readonly revisions = new Map<string, string>();
  private readonly saves = new Map<string, Promise<void>>();
  private tail = Promise.resolve();
  private failed: CapturedSave | null = null;
  private writerTip: string | null = null;
  private readonly writerParents = new Map<string, string>();
  private ownWrite = false;
  private block: BpmnBlockModel;
  private readonly permissionSubscription;
  private readonly trashSubscription;
  private syncWait: AbortController | null = null;
  private readiness: BpmnReadiness | null = null;
  private fatal = false;
  private accessLost = false;
  private accessGeneration = 0;
  private permissionDenials = 0;
  private checkingAccess = false;
  private accessCheck: Promise<void> | null = null;
  private unloadBound = false;
  private previewWanted: { source: BpmnSourceRevision; head: string } | null =
    null;
  private previewTask: Promise<void> | null = null;

  constructor(
    readonly request: MyoxusBpmnEditorRequest,
    private readonly doc: Doc,
    private readonly workspace: WorkspaceService,
    private readonly guard: GuardService,
    readOnly: boolean,
    private readonly hostReadOnly = false,
  ) {
    const block = doc.virgultumDoc.getBlock(request.blockId)?.model;
    if (!isBpmnBlockModel(block)) throw new Error("BPMN_BLOCK_NOT_FOUND");
    this.block = block;
    const state = readBpmnSourceRevisions(block.yBlock);
    const source = state.selected
      ? { revision: state.selected, xml: state.heads.get(state.selected)! }
      : null;
    if (source) this.revisions.set(source.revision, source.revision);
    this.state$ = new LiveData<SessionState>({
      phase: "loading",
      blockTitle: coerceBpmnBlockText(block.props.title),
      source,
      readOnly,
      conflict: state.status === "conflict",
      heads: state.heads,
      missing: false,
      busy: false,
      error: false,
      durability: null,
      syncError: false,
      command: {
        dirty: false,
        pendingFields: false,
        canUndo: false,
        canRedo: false,
      },
    });
    block.yBlock.observeDeep(this.observe);
    doc.yDoc.on("afterTransaction", this.observe);
    this.permissionSubscription = guard
      .can$("Doc_Update", doc.id)
      .subscribe((allowed) => {
        if (allowed !== true) {
          this.permissionDenials++;
          this.accessLost = !this.hostReadOnly;
        }
        this.patch({
          readOnly:
            this.checkingAccess ||
            this.hostReadOnly ||
            this.accessLost ||
            allowed !== true ||
            this.state$.value.missing ||
            this.fatal ||
            doc.virgultumDoc.readonly,
        });
        if (allowed === true) {
          // GuardService also publishes replies from outside this session.
          // After a denial, an uncorrelated positive may be an older reply;
          // confirm it without briefly reopening the command gate.
          if (this.accessLost && !this.checkingAccess) this.refreshAccess();
          else if (!this.state$.value.readOnly) this.queuePreview();
        }
      });
    this.trashSubscription = doc.trash$.subscribe((trashed) => {
      if (trashed) this.patch({ missing: true, readOnly: true });
    });
    if (source) this.trackDurability(source.revision, source.revision);
    if (!BUILD_CONFIG.isElectron && typeof window !== "undefined") {
      window.addEventListener("pagehide", this.pageHide);
      window.addEventListener("pageshow", this.pageShow);
      window.addEventListener("focus", this.refreshAccess);
      window.addEventListener("online", this.refreshAccess);
    }
  }
  private patch(value: Partial<SessionState>) {
    if (this.disposed) return;
    const next = { ...this.state$.value, ...value };
    next.phase = this.phase(next);
    this.state$.next(next);
    this.updateUnloadGuard();
  }
  /** Browser unload cannot await custom UI or local storage. Warn only for
   * unacknowledged local work; an already durable pending-sync head is safe to
   * leave. Never flush/dispose here: Cancel must keep the editor and ports live. */
  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.disposed || !this.hasUncommittedWork()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  private hasUncommittedWork() {
    return (
      this.state$.value.command.dirty ||
      this.failed !== null ||
      this.saves.size > 0
    );
  }
  private updateUnloadGuard() {
    if (BUILD_CONFIG.isElectron || typeof window === "undefined") return;
    const dirty = !this.disposed && this.hasUncommittedWork();
    if (dirty === this.unloadBound) return;
    this.unloadBound = dirty;
    if (dirty) window.addEventListener("beforeunload", this.beforeUnload);
    else window.removeEventListener("beforeunload", this.beforeUnload);
  }
  /** pagehide is an actual leave, not a canceled beforeunload. BFCache retains
   * this controller and its dirty model; pause only the replaceable sync wait. */
  private readonly pageHide = () => {
    const wait = this.syncWait;
    this.syncWait = null;
    wait?.abort();
  };
  private readonly pageShow = (event: PageTransitionEvent) => {
    if (!event.persisted || this.disposed) return;
    this.refreshAccess();
    this.observe();
    this.retrySync();
  };
  /** Browser focus/reconnect and BFCache resume must refresh the live grant.
   * Lock commands during the check; an unchanged positive value may not emit
   * again through can$, so explicitly settle the lock from the awaited result.
   * Newer checks/live denials and teardown win over an older completion. */
  private readonly refreshAccess = () => {
    if (this.disposed) return;
    const generation = ++this.accessGeneration;
    const denials = this.permissionDenials;
    this.checkingAccess = true;
    this.patch({ readOnly: true });
    const check = this.guard.can("Doc_Update", this.doc.id).then(
      (allowed) => {
        if (this.disposed || generation !== this.accessGeneration) return;
        this.checkingAccess = false;
        this.accessLost =
          !this.hostReadOnly &&
          (!allowed ||
            denials !== this.permissionDenials ||
            this.guard.can$("Doc_Update", this.doc.id).value !== true);
        this.patch({
          readOnly:
            this.hostReadOnly ||
            this.accessLost ||
            this.state$.value.missing ||
            this.fatal ||
            this.doc.virgultumDoc.readonly,
        });
        if (!this.state$.value.readOnly) this.queuePreview();
        this.retrySync();
      },
      () => {
        if (this.disposed || generation !== this.accessGeneration) return;
        this.checkingAccess = false;
        this.accessLost = !this.hostReadOnly;
        this.patch({ readOnly: true });
      },
    );
    this.accessCheck = check;
    void check.finally(() => {
      if (this.accessCheck === check) this.accessCheck = null;
    });
  };
  private phase(next: SessionState): BpmnSessionPhase {
    if (next.missing) return "deleted";
    if (this.fatal || this.readiness?.status === "render-error") return "fatal";
    if (this.accessLost) return "access-lost";
    if (next.conflict) return "conflict";
    if (this.readiness && this.readiness.status !== "ready")
      return "source-error";
    if (next.error) return "save-error";
    if (next.busy) return "saving-local";
    if (!this.readiness) return "loading";
    if (next.command.dirty) return "ready-dirty";
    if (next.durability && !next.durability.remote) return "awaiting-remote";
    return next.durability ? "saved" : "ready-clean";
  }

  /** Mount/read admission comes from the fork; rejected sources remain available
   * for exact download/import recovery, never a partially editable model. */
  reportReadiness(readiness: BpmnReadiness) {
    this.readiness = readiness;
    this.patch({});
    if (readiness.status === "ready") this.queuePreview();
  }

  /** Only the selected locally durable source produces a preview. One active
   * job plus one latest intent coalesces bursts without rendering historical
   * heads. There is no persisted generating marker to strand at teardown. */
  private queuePreview() {
    const state = this.state$.value,
      source = state.source;
    if (
      this.disposed ||
      !this.editor ||
      this.readiness?.status !== "ready" ||
      state.readOnly ||
      state.missing ||
      state.conflict ||
      !source
    )
      return;
    const head = this.revisions.get(source.revision);
    if (!head || readBpmnSourceRevisions(this.block.yBlock).selected !== head)
      return;
    this.previewWanted = { source, head };
    if (this.previewTask) return;
    // Start after the synchronous ref/effect handoff (including StrictMode's
    // mount replay), not from inside a retained command's installation effect.
    this.previewTask = Promise.resolve()
      .then(async () => {
        while (this.previewWanted && !this.disposed) {
          const target = this.previewWanted;
          this.previewWanted = null;
          const editor = this.editor;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let expired = false;
          const stopped = Promise.withResolvers<never>();
          const rendering = new AbortController();
          const stop = () => {
            expired = true;
            rendering.abort(new Error("BPMN_PREVIEW_STOPPED"));
            stopped.reject(new Error("BPMN_PREVIEW_STOPPED"));
          };
          this.abort.signal.addEventListener("abort", stop, { once: true });
          const current = () =>
            !expired &&
            !this.disposed &&
            this.editor === editor &&
            this.readiness?.status === "ready" &&
            !this.state$.value.readOnly &&
            !this.state$.value.missing &&
            readBpmnSourceRevisions(this.block.yBlock).selected === target.head;
          try {
            const work = async () => {
              const previous = this.block.props.preview;
              if (
                previous?.revision === target.head &&
                typeof previous.sourceId === "string" &&
                this.block.props.previewErrorRevision !== target.head
              ) {
                const blob = await this.doc.virgultumDoc.blobSync.get(
                  previous.sourceId,
                );
                if (blob) {
                  try {
                    prepareBpmnPreviewSvg(
                      await blob.text(),
                      target.head,
                      target.head,
                    );
                    return;
                  } catch {
                    /* Rebuild corrupt derived bytes from canonical XML. */
                  }
                }
              }
              if (!current() || !editor) return;
              const exported = await editor.exportSvg(rendering.signal);
              if (
                !current() ||
                exported.revision !== target.source.revision ||
                exported.xml !== target.source.xml
              )
                return;
              const svg = prepareBpmnPreviewSvg(
                exported.svg,
                target.head,
                target.source.revision,
              );
              const sourceId = await this.doc.virgultumDoc.blobSync.set(
                new Blob([svg], { type: "image/svg+xml" }),
              );
              if (!current()) return;
              await this.workspace.workspace.engine.doc.updateAndWaitForSaved(
                this.doc.id,
                () => {
                  this.assertWriteAvailable();
                  if (!current()) return;
                  this.doc.yDoc.transact(() => {
                    this.block.yBlock.set("prop:preview", {
                      revision: target.head,
                      sourceId,
                    });
                    this.block.yBlock.set("prop:previewErrorRevision", null);
                  }, BPMN_SOURCE_TRANSACTION_ORIGIN);
                },
              );
            };
            timeout = setTimeout(stop, 30_000);
            await Promise.race([work(), stopped.promise]);
          } catch {
            // No XML rollback and no asset deletion: another client or retained
            // document history may still reference the same immutable blob.
            if (
              !this.hasPreviewIntent(target.head) &&
              !this.disposed &&
              !this.state$.value.readOnly &&
              readBpmnSourceRevisions(this.block.yBlock).selected ===
                target.head
            ) {
              try {
                const failureWrite =
                  this.workspace.workspace.engine.doc.updateAndWaitForSaved(
                    this.doc.id,
                    () => {
                      this.assertWriteAvailable();
                      if (
                        readBpmnSourceRevisions(this.block.yBlock).selected !==
                        target.head
                      )
                        return;
                      this.doc.yDoc.transact(
                        () =>
                          this.block.yBlock.set(
                            "prop:previewErrorRevision",
                            target.head,
                          ),
                        BPMN_SOURCE_TRANSACTION_ORIGIN,
                      );
                    },
                  );
                // Recording failure must not turn a renderer timeout into an
                // unbounded close. Storage's normal queue still owns emitted data.
                const deadline = AbortSignal.any([
                  this.abort.signal,
                  AbortSignal.timeout(5_000),
                ]);
                await new Promise<void>((resolve, reject) => {
                  const abort = () => reject(deadline.reason);
                  deadline.addEventListener("abort", abort, { once: true });
                  void failureWrite
                    .then(resolve, reject)
                    .finally(() =>
                      deadline.removeEventListener("abort", abort),
                    );
                  if (deadline.aborted) abort();
                });
              } catch {
                /* Storage/permission failure cannot undo already durable XML. */
              }
            }
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            this.abort.signal.removeEventListener("abort", stop);
          }
        }
      })
      .finally(() => {
        this.previewTask = null;
        if (this.previewWanted && !this.disposed) this.queuePreview();
      });
  }
  private hasPreviewIntent(head: string) {
    return this.previewWanted?.head === head;
  }

  /** Local ACK never waits for a network round trip. The separate bounded sync
   * operation uses the existing document/root waits and rechecks the exact head
   * afterwards. Replaced waits and teardown are aborted, not allowed to publish
   * Saved for a newer candidate; a timeout leaves durable work pending/retryable. */
  private trackDurability(
    revision: string,
    head: string,
    change: Partial<SessionState> = {},
  ) {
    this.syncWait?.abort();
    this.syncWait = null;
    const local = this.workspace.workspace.flavour === "local";
    this.patch({
      ...change,
      durability: { revision, head, remote: local },
      syncError: false,
    });
    if (local || this.disposed) return;
    const wait = new AbortController();
    this.syncWait = wait;
    const timeout = setTimeout(() => wait.abort(), 30_000);
    const cancelTimeout = () => clearTimeout(timeout);
    wait.signal.addEventListener("abort", cancelTimeout, { once: true });
    const signal = AbortSignal.any([this.abort.signal, wait.signal]);
    void (async () => {
      try {
        const storage = this.workspace.workspace.engine.doc;
        await storage.waitForSynced(this.workspace.workspace.id, signal);
        await storage.waitForSynced(this.doc.id, signal);
        if (this.disposed || this.syncWait !== wait || signal.aborted) return;
        const state = readBpmnSourceRevisions(this.block.yBlock);
        if (
          state.selected !== head ||
          this.state$.value.durability?.revision !== revision
        )
          return;
        this.patch({
          durability: { revision, head, remote: true },
          syncError: false,
        });
      } catch {
        if (!this.disposed && this.syncWait === wait)
          this.patch({ syncError: true });
      } finally {
        clearTimeout(timeout);
        wait.signal.removeEventListener("abort", cancelTimeout);
      }
    })();
  }

  retrySync() {
    const durable = this.state$.value.durability;
    if (!this.disposed && durable && !durable.remote)
      this.trackDurability(durable.revision, durable.head);
  }
  /** Revalidate synchronous gates after the asynchronous permission result.
   * A live denial, deletion or teardown during that await wins over a stale
   * positive response. Call immediately before the storage/transaction boundary. */
  private async assertWritable() {
    // A temporary focus/resume lock is not a failed save. Let the existing
    // serial writer wait for the newest check before inspecting live gates.
    while (this.accessCheck) await this.accessCheck;
    this.assertWriteAvailable();
    const allowed = await this.guard.can("Doc_Update", this.doc.id);
    if (!allowed) throw new Error("BPMN_READ_ONLY");
    this.assertWriteAvailable();
  }
  private assertWriteAvailable() {
    if (this.readiness?.status === "render-error")
      throw new Error("BPMN_NOT_READY");
    if (
      this.disposed ||
      this.state$.value.readOnly ||
      this.state$.value.missing ||
      this.doc.virgultumDoc.readonly
    )
      throw new Error("BPMN_READ_ONLY");
    if (
      this.doc.trash$.value ||
      this.doc.virgultumDoc.getBlock(this.block.id)?.model !== this.block
    )
      throw new Error("BPMN_BLOCK_NOT_FOUND");
  }
  /** Display context only: the document's existing title service owns its name.
   * Neither the block title nor BPMN process name is an alias or rename command. */
  get documentTitle$() {
    return this.doc.title$;
  }
  private readonly observe = () => {
    if (this.ownWrite || this.disposed) return;
    if (
      this.doc.virgultumDoc.getBlock(this.block.id)?.model !== this.block ||
      this.doc.trash$.value
    ) {
      this.patch({ missing: true, readOnly: true });
      return;
    }
    try {
      const state = readBpmnSourceRevisions(this.block.yBlock);
      this.patch({
        conflict: state.status === "conflict",
        heads: state.heads,
        blockTitle: coerceBpmnBlockText(this.block.props.title),
      });
      // A dirty working copy belongs to its original base. Never reset it to a
      // remote winner; its next save must expose a competing head instead.
      if (
        state.selected &&
        !this.state$.value.command.dirty &&
        !this.failed &&
        !this.state$.value.busy
      ) {
        const xml = state.heads.get(state.selected)!;
        if (state.selected !== this.state$.value.durability?.head) {
          this.revisions.set(state.selected, state.selected);
          this.trackDurability(state.selected, state.selected, {
            source: { revision: state.selected, xml },
          });
        }
      }
    } catch {
      this.fatal = true;
      this.patch({ error: true, readOnly: true });
    }
  };
  attach(editor: BpmnEditorRef | null) {
    this.editor = editor;
    if (editor) this.queuePreview();
  }
  report(command: BpmnCommandState) {
    const wasDirty = this.state$.value.command.dirty;
    this.patch({ command });
    if (wasDirty && !command.dirty) this.queuePreview();
  }
  focus() {
    this.focus$.next(this.focus$.value + 1);
  }
  flush() {
    if (!this.editor) throw new Error("BPMN_NOT_READY");
    return this.editor.flush();
  }
  /** Fonts and resolved presentation belong to the isolated downloaded image.
   * Recheck the candidate after that asynchronous materialization as well as the
   * fork's render stage; neither stage is a local-storage acknowledgement. */
  async exportSvg() {
    const editor = this.editor;
    if (!editor || this.disposed) throw new Error("BPMN_NOT_READY");
    const exported = await editor.exportSvg();
    if (this.disposed || this.editor !== editor)
      throw new Error("BPMN_STALE_SNAPSHOT");
    const svg = await materializeDiagramExportSvg(exported.svg);
    if (this.disposed || this.editor !== editor)
      throw new Error("BPMN_STALE_SNAPSHOT");
    const current = editor.flush();
    if (current.revision !== exported.revision || current.xml !== exported.xml)
      throw new Error("BPMN_STALE_SNAPSHOT");
    return { ...exported, svg };
  }
  downloadSources() {
    return readBpmnSourceRevisions(this.block.yBlock).heads;
  }
  prepareImport(
    bytes: Uint8Array,
    conflictHeads?: readonly string[],
  ): BpmnImportCandidate {
    const state = readBpmnSourceRevisions(this.block.yBlock);
    return {
      inspection: inspectBpmnBytes(bytes),
      base: state.selected,
      conflictHeads: conflictHeads
        ? [...conflictHeads]
        : state.status === "conflict"
          ? [...state.heads.keys()]
          : [],
    };
  }
  /** Rejected/stale files never enter history. An accepted local replacement is
   * one fork command, persisted against the observed live head; its verbatim
   * candidate ACK preserves Undo rather than invoking the remote-reset path. */
  replaceSource(candidate: BpmnImportCandidate): Promise<void> {
    if (
      candidate.inspection.status === "accepted" &&
      candidate.conflictHeads.length
    )
      return this.resolveConflict(candidate.conflictHeads, {
        source: candidate.inspection.source,
      });
    if (
      candidate.inspection.status !== "accepted" ||
      !candidate.base ||
      this.state$.value.command.dirty ||
      this.state$.value.busy ||
      this.state$.value.conflict ||
      this.state$.value.readOnly ||
      this.disposed
    )
      return Promise.reject(new Error("BPMN_REPLACE_UNAVAILABLE"));
    if (readBpmnSourceRevisions(this.block.yBlock).selected !== candidate.base)
      return Promise.reject(new Error("BPMN_REPLACE_STALE"));
    const source = this.state$.value.source;
    if (!source || !this.editor)
      return Promise.reject(new Error("BPMN_REPLACE_UNAVAILABLE"));
    // A rejected initial source has no mounted graph/history to replace. Keep
    // its explicit recovery path through normal source admission; only an
    // already editable model can own an undoable semantic import boundary.
    if (inspectBpmnSource(source.xml).status !== "accepted")
      return this.save(
        {
          revision: crypto.randomUUID(),
          baseRevision: source.revision,
          xml: candidate.inspection.source,
        },
        candidate.base,
      );
    try {
      return this.save(
        this.editor.replaceSource(candidate.inspection.source),
        candidate.base,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  /** Explicit choice/merge only: never infer a winner from the selected hint.
   * Recheck the exact observed set after authorization and in the atomic commit.
   * A later unseen branch still competes; this is not distributed compare-and-set.
   * Uncommitted local work must be stored/discarded before replacing its model. */
  resolveConflict(
    heads: readonly string[],
    choice: { head: string } | { source: string },
  ): Promise<void> {
    try {
      this.assertConflictAvailable(heads);
      const live = readBpmnSourceRevisions(this.block.yBlock);
      const parent = "head" in choice ? choice.head : heads[0]!;
      const xml =
        "head" in choice ? live.heads.get(choice.head) : choice.source;
      if (!xml || !live.heads.has(parent))
        throw new Error("BPMN_CONFLICT_CHANGED");
      return this.persist(
        { revision: crypto.randomUUID(), baseRevision: parent, xml },
        undefined,
        { parent, heads: [...heads] },
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private assertConflictAvailable(
    heads: readonly string[],
    pendingResolution = false,
  ) {
    this.assertWriteAvailable();
    const state = readBpmnSourceRevisions(this.block.yBlock);
    if (
      state.status !== "conflict" ||
      heads.length !== state.heads.size ||
      new Set(heads).size !== heads.length ||
      heads.some((id) => !state.heads.has(id))
    )
      throw new Error("BPMN_CONFLICT_CHANGED");
    if (
      this.state$.value.command.dirty ||
      this.failed ||
      // Admission excludes queued writers; after authorization this resolution
      // itself occupies that queue, but dirty/failed local work still vetoes it.
      this.saves.size > (pendingResolution ? 1 : 0)
    )
      throw new Error("BPMN_CONFLICT_LOCAL_CHANGES");
  }
  save(snapshot: BpmnSnapshot, replacementBase?: string): Promise<void> {
    return this.persist(snapshot, replacementBase);
  }
  private persist(
    snapshot: BpmnSnapshot,
    replacementBase?: string,
    resolution?: ConflictResolution,
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("BPMN_SESSION_CLOSED"));
    if (this.revisions.has(snapshot.revision)) return Promise.resolve();
    if (
      !resolution &&
      snapshot.xml === this.state$.value.source?.xml &&
      !this.failed
    )
      return Promise.resolve();
    const existing = this.saves.get(snapshot.revision);
    if (existing) return existing;
    const operation = this.tail.then(async () => {
      if (this.failed) throw new Error("BPMN_SAVE_RETRY_REQUIRED");
      let parent =
        resolution?.parent ?? this.revisions.get(snapshot.baseRevision);
      if (!parent) throw new Error("BPMN_REVISION_MISSING_BASE");
      // Commands made while an earlier save awaited storage already descend
      // from that working candidate. Advance only our own proven chain; an
      // independent remote head is never silently rebased or superseded.
      let ancestor = this.writerTip;
      while (ancestor && ancestor !== parent)
        ancestor = this.writerParents.get(ancestor) ?? null;
      if (!resolution && ancestor === parent && this.writerTip)
        parent = this.writerTip;
      const captured: CapturedSave = {
        snapshot,
        id: crypto.randomUUID(),
        replacementBase,
      };
      this.patch({ busy: true, error: false });
      try {
        await this.assertWritable();
        if (resolution) this.assertConflictAvailable(resolution.heads, true);
        if (
          replacementBase &&
          readBpmnSourceRevisions(this.block.yBlock).selected !==
            replacementBase
        )
          throw new Error("BPMN_REPLACE_STALE");
        const updates: Uint8Array[] = [];
        const capture = (update: Uint8Array) => updates.push(update.slice());
        try {
          await this.workspace.workspace.engine.doc.updateAndWaitForSaved(
            this.doc.id,
            () => {
              // Awaiting the helper also yields a microtask. Check at the
              // synchronous transaction itself, before its first Yjs write.
              this.assertWriteAvailable();
              if (resolution)
                this.assertConflictAvailable(resolution.heads, true);
              this.doc.yDoc.on("update", capture);
              this.ownWrite = true;
              try {
                commitBpmnSourceRevision(this.block.yBlock, {
                  id: captured.id,
                  parent,
                  source: snapshot.xml,
                  supersedes: resolution ? [...resolution.heads] : [],
                });
                this.writerParents.set(captured.id, parent);
                this.writerTip = captured.id;
              } finally {
                this.ownWrite = false;
                this.doc.yDoc.off("update", capture);
              }
            },
          );
        } finally {
          this.doc.yDoc.off("update", capture);
          if (updates.length) captured.update = mergeUpdates(updates);
        }
        this.acknowledge(captured);
      } catch (error) {
        // A stale review made no write and must be reviewed again, not retried
        // against a new head set. Applied-but-unsaved resolutions retain the
        // exact captured delta and use the ordinary local durability retry.
        if (!resolution || captured.update) {
          this.failed = captured;
          this.patch({ error: true });
        }
        throw error;
      } finally {
        this.patch({ busy: false });
      }
    });
    this.saves.set(snapshot.revision, operation);
    this.updateUnloadGuard();
    // Keep only in-flight promises: settled closures retain complete XML. The
    // compact revision map still deduplicates previously acknowledged candidates.
    this.tail = operation.then(
      () => {
        this.saves.delete(snapshot.revision);
        this.updateUnloadGuard();
      },
      () => {
        this.saves.delete(snapshot.revision);
        this.updateUnloadGuard();
      },
    );
    return operation;
  }
  private acknowledge(captured: CapturedSave) {
    if (this.disposed) return;
    this.revisions.set(captured.snapshot.revision, captured.id);
    const live = readBpmnSourceRevisions(this.block.yBlock);
    this.trackDurability(captured.snapshot.revision, captured.id, {
      source: {
        revision: captured.snapshot.revision,
        xml: captured.snapshot.xml,
      },
      conflict: live.status === "conflict",
      heads: live.heads,
      error: false,
    });
    this.queuePreview();
  }
  /** Retry the captured delta through storage; reapplying it in memory emits no update and proves nothing. */
  async retry() {
    const failed = this.failed;
    if (!failed) throw new Error("BPMN_SAVE_FAILED");
    if (!failed.update) {
      this.failed = null;
      this.saves.delete(failed.snapshot.revision);
      return this.save(failed.snapshot, failed.replacementBase);
    }
    await this.assertWritable();
    this.assertWriteAvailable();
    this.patch({ busy: true });
    try {
      await this.workspace.workspace.engine.doc.saveCapturedUpdateAndWaitForSaved(
        this.doc.id,
        failed.update,
      );
      this.failed = null;
      this.saves.delete(failed.snapshot.revision);
      this.acknowledge(failed);
    } finally {
      this.patch({ busy: false });
    }
  }
  discard() {
    if (this.failed?.update) throw new Error("BPMN_SAVE_RETRY_REQUIRED");
    this.editor?.discard();
  }
  /** Every public dialog close uses this same owner decision. A locally durable
   * pending head is not dirty and never offers to discard an accepted revision. */
  requestClose(): boolean | Promise<boolean> {
    if (this.disposed) return true;
    if (this.closeDecision) return this.closeDecision.promise;
    if (this.state$.value.busy || this.saves.size)
      return this.tail.then(() => this.requestClose());
    if (this.previewTask)
      return this.previewTask.then(() => this.requestClose());
    if (!this.state$.value.command.dirty && !this.state$.value.error)
      return true;
    const decision = Promise.withResolvers<boolean>();
    this.closeDecision = {
      promise: decision.promise,
      resolve: decision.resolve,
    };
    this.closePrompt$.next(true);
    return decision.promise;
  }
  hideClosePrompt() {
    this.closePrompt$.next(false);
  }
  /** Save is invoked after the confirmation focus trap exits. Reflush after
   * local durability so edits made during the await veto teardown rather than
   * disappearing. Cancel/discard never change persisted heads or remote edits. */
  async answerClose(answer: "save" | "discard" | "cancel") {
    const decision = this.closeDecision;
    if (!decision) return;
    this.closePrompt$.next(false);
    let allowed = false;
    try {
      if (answer === "save") {
        if (this.failed) await this.retry();
        const snapshot = this.flush();
        await this.save(snapshot);
        await this.previewTask;
        allowed = this.flush().xml === snapshot.xml;
      } else if (answer === "discard") {
        this.discard();
        await this.previewTask;
        allowed =
          this.readiness?.status !== "ready" ||
          this.flush().xml === this.state$.value.source?.xml;
      }
      if (allowed)
        this.closeResult = {
          status: answer === "discard" ? "discarded" : "closed",
          revision: this.state$.value.source?.revision ?? null,
        };
    } finally {
      this.closeDecision = null;
      decision.resolve(allowed && !this.disposed);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.previewWanted = null;
    this.updateUnloadGuard();
    if (!BUILD_CONFIG.isElectron && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.pageHide);
      window.removeEventListener("pageshow", this.pageShow);
      window.removeEventListener("focus", this.refreshAccess);
      window.removeEventListener("online", this.refreshAccess);
    }
    this.closeDecision?.resolve(false);
    this.closeDecision = null;
    this.closePrompt$.next(false);
    this.abort.abort();
    this.block.yBlock.unobserveDeep(this.observe);
    this.doc.yDoc.off("afterTransaction", this.observe);
    this.permissionSubscription.unsubscribe();
    this.trashSubscription.unsubscribe();
    this.syncWait?.abort();
    this.syncWait = null;
    this.editor = null;
    this.saves.clear();
  }
}

type OpenSession = {
  result: Promise<MyoxusBpmnEditorCloseResult>;
  abort: AbortController;
  session?: BpmnEditorSession;
  close?: () => void;
  finish?: () => void;
  requestClose?: () => boolean | Promise<boolean>;
  views: Map<View, (() => void) | null>;
};
/** Workspace-local ownership is reserved before loading, so simultaneous opens share one lease/dialog. */
export class BpmnEditorService extends Service {
  private readonly sessions = new Map<string, OpenSession>();
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly docs: DocsService,
    private readonly guard: GuardService,
    private readonly dialogs: WorkspaceDialogService,
  ) {
    super();
  }
  open(
    request: MyoxusBpmnEditorRequest,
    hostReadOnly = false,
    originView?: View,
  ): Promise<MyoxusBpmnEditorCloseResult> {
    if (request.workspaceId !== this.workspace.workspace.id)
      return Promise.reject(new Error("BPMN_WORKSPACE_MISMATCH"));
    const key = JSON.stringify([request.docId, request.blockId]);
    const existing = this.sessions.get(key);
    if (existing) {
      if (originView && !existing.views.has(originView))
        existing.views.set(
          originView,
          existing.requestClose
            ? originView.registerCloseGuard(existing.requestClose)
            : null,
        );
      existing.session?.focus();
      return existing.result;
    }
    let resolve!: (result: MyoxusBpmnEditorCloseResult) => void;
    let reject!: (error: unknown) => void;
    const entry: OpenSession = {
      result: new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      abort: new AbortController(),
      views: new Map(originView ? [[originView, null]] : []),
    };
    this.sessions.set(key, entry);
    void (async () => {
      let release: (() => void) | undefined;
      try {
        if (!(await this.guard.can("Doc_Read", request.docId)))
          throw new Error("BPMN_READ_DENIED");
        entry.abort.signal.throwIfAborted();
        const lease = this.docs.open(request.docId);
        if (!lease) throw new Error("BPMN_DOCUMENT_NOT_FOUND");
        release = lease.release;
        await lease.doc.waitForSyncReady(entry.abort.signal);
        if (this.sessions.get(key) !== entry)
          throw new Error("BPMN_SESSION_CLOSED");
        const readOnly =
          !(await this.guard.can("Doc_Update", request.docId)) ||
          lease.doc.virgultumDoc.readonly;
        entry.abort.signal.throwIfAborted();
        const session = new BpmnEditorSession(
          request,
          lease.doc,
          this.workspace,
          this.guard,
          readOnly || hostReadOnly,
          hostReadOnly,
        );
        entry.session = session;
        let finished = false;
        const finish = (result?: MyoxusBpmnEditorCloseResult) => {
          if (finished) return;
          finished = true;
          for (const remove of entry.views.values()) remove?.();
          entry.views.clear();
          entry.abort.abort();
          session.dispose();
          release?.();
          release = undefined;
          this.sessions.delete(key);
          resolve(
            session.closeResult ??
              result ?? {
                status: "closed",
                revision: session.state$.value.source?.revision ?? null,
              },
          );
        };
        entry.finish = () => finish();
        const id = this.dialogs.open("bpmn-editor", { session }, finish, {
          beforeClose: () => session.requestClose(),
        });
        // Every originating pane shares the public dialog's once-only decision.
        // The session/lease, not a disappearing Page/Edgeless renderer, removes
        // these registrations when the accepted close actually finishes.
        entry.requestClose = () => this.dialogs.close(id);
        for (const view of entry.views.keys())
          entry.views.set(view, view.registerCloseGuard(entry.requestClose));
        entry.close = () => {
          const result = this.dialogs.close(id);
          // A scope teardown can cancel an already pending user decision. Once
          // that veto settles, remove the now-disposed shell too; finish is
          // idempotent and has already released its lease synchronously.
          if (typeof result !== "boolean")
            void result.then((allowed) => {
              if (!allowed && entry.abort.signal.aborted)
                this.dialogs.close(id);
            });
        };
      } catch (error) {
        entry.abort.abort();
        entry.session?.dispose();
        for (const remove of entry.views.values()) remove?.();
        entry.views.clear();
        release?.();
        this.sessions.delete(key);
        reject(error);
      }
    })();
    return entry.result;
  }
  override dispose() {
    for (const entry of this.sessions.values()) {
      entry.abort.abort();
      // Scope disposal is terminal cleanup, not a cancelable user intent.
      // Navigation/workspace owners must obtain their veto before disposing.
      entry.session?.dispose();
      entry.finish?.();
      entry.close?.();
    }
    this.sessions.clear();
    super.dispose();
  }
}
