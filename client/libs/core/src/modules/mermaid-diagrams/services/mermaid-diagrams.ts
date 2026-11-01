import { LiveData, Service } from "@myoxus/infra";
import type { Store } from "@virgultum/editor/store";
import { nanoid } from "nanoid";
import { readBpmnSourceRevisions } from "@virgultum/block-bpmn";
import { encodeStateAsUpdate } from "yjs";
import { firstValueFrom, from, timeout } from "rxjs";

import type { DocsService } from "../../doc";
import type { WorkspaceService } from "../../workspace";
import type { MermaidDiagramsStore } from "../store/mermaid-diagrams";
import {
  initializeBpmnDocument,
  prepareBpmnInitialization,
  type BpmnInitialization,
  type BpmnInitializationResult,
} from "./bpmn-initialization";

export type DiagramCreationInput =
  | {
      format: "bpmn";
      title: string;
      type: "bpmn";
      /** Exact decoded file source, including BOM/EOL. Never Markdown-normalize. */
      source?: string;
      preserveUnsupported?: boolean;
    }
  | {
      format: "mermaid";
      source: string;
      title: string;
      type: string;
      /** Creation intent only; existing blocks retain their persisted parent. */
      edgelessPlacement?: "native";
    };

type CreationStage =
  "creation" | "content" | "registration" | "presentation" | "classification";
export type DiagramCreationResult =
  | { status: "ready"; docId: string }
  | { status: "failed"; docId: string; stage: CreationStage };
export type DiagramCreationState = {
  docId: string;
  /** Import results own their own completion UI; a mounted catalog must not
   * redirect midway through a multi-file attempt. */
  origin?: "catalog" | "import";
  title?: string;
  busy: boolean;
  stage: CreationStage;
  failed: boolean;
};
type InitialDiagram = DiagramCreationInput & {
  initialization?: BpmnInitialization;
  /** Only this provisioned Note may be removed if it is still empty at insert. */
  bootstrapNoteId?: string;
};

export function hasInitializedDiagramContent(doc: Store) {
  return (
    doc.getBlocksByFlavour("myoxus:mermaid").length > 0 ||
    // Historical diagram documents may already contain a database block from
    // the retired Kanban bridge. Treat it as initialized without implying that
    // newly created Mermaid Kanban diagrams use that unverified surface.
    doc.getBlocksByFlavour("myoxus:database" as never).length > 0 ||
    doc.getBlocksByFlavour("myoxus:bpmn" as never).length > 0
  );
}

export class MermaidDiagramsService extends Service {
  private readonly claimedInitialDiagramIds = new Map<string, symbol>();
  private readonly pendingInitialDiagrams = new Map<string, InitialDiagram>();
  /** Workspace-scoped operation state survives catalog remounts. A settled
   * success stays observable so the mounted catalog can own navigation. */
  readonly creation$ = new LiveData<DiagramCreationState | null>(null);
  private creating: Promise<DiagramCreationResult> | null = null;

  constructor(
    private readonly store: MermaidDiagramsStore,
    private readonly docsService: DocsService,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
  }

  diagramDocs$ = this.store.diagramDocs$;
  diagramIds$ = this.store.diagramIds$;

  diagramDoc$(docId: string) {
    return this.store.diagramDoc$(docId);
  }

  isDiagramDoc$(docId: string) {
    return this.store.isDiagramDoc$(docId);
  }

  isDiagramDoc(docId: string) {
    return this.store.isDiagramDoc(docId);
  }

  getDiagramDocs() {
    return this.store.getDiagramDocs();
  }

  getDiagramDocIds() {
    return this.store.getDiagramDocIds();
  }

  markDiagramDoc(
    docId: string,
    format?: "bpmn" | "mermaid",
    diagramType?: string,
  ) {
    return this.store.setDiagramDocKind(docId, format, diagramType);
  }

  unmarkDiagramDoc(docId: string) {
    this.store.removeDiagramDocKind(docId);
  }

  createDiagram(
    input: DiagramCreationInput,
    options?: { origin: "import" },
  ): Promise<DiagramCreationResult> {
    if (this.creating) return this.creating;
    const failed = this.creation$.value;
    if (failed?.failed)
      return Promise.resolve({
        status: "failed",
        docId: failed.docId,
        stage: failed.stage,
      });
    const docId = nanoid();
    this.pendingInitialDiagrams.set(docId, {
      ...input,
      ...(input.format === "bpmn"
        ? {
            initialization: prepareBpmnInitialization(
              input.source,
              input.preserveUnsupported,
            ),
          }
        : {}),
    });
    return this.runCreation(docId, false, options?.origin ?? "catalog");
  }

  /** The catalog URL retains this target across reload. Restoring its recovery
   * UI is not creation authority and performs no write or automatic retry. */
  restoreCreation(docId: string) {
    if (!this.creating && this.creation$.value?.docId !== docId)
      this.creation$.next({
        docId,
        title: this.docsService.list.doc$(docId).value?.title$.value,
        busy: false,
        failed: true,
        stage: "registration",
      });
  }

  retryCreation(docId: string) {
    return this.creating ?? this.runCreation(docId, true);
  }

  discardCreation(docId: string) {
    if (this.creating) return;
    if (!this.docsService.list.doc$(docId).value)
      throw new Error("DIAGRAM_RECORD_UNAVAILABLE");
    this.docsService.moveManyToTrash([docId]);
    this.pendingInitialDiagrams.delete(docId);
    this.claimedInitialDiagramIds.delete(docId);
    if (this.creation$.value?.docId === docId) this.creation$.next(null);
  }

  private runCreation(
    docId: string,
    retry: boolean,
    origin = this.creation$.value?.origin ?? "catalog",
  ): Promise<DiagramCreationResult> {
    const stage = (value: CreationStage) =>
      this.creation$.next({
        docId,
        origin,
        title:
          this.pendingInitialDiagrams.get(docId)?.title ??
          this.docsService.list.doc$(docId).value?.title$.value,
        busy: true,
        failed: false,
        stage: value,
      });
    stage("creation");
    const operation = (async (): Promise<DiagramCreationResult> => {
      let release: (() => void) | undefined;
      const signal = AbortSignal.timeout(30_000);
      const step = <T>(pending: Promise<T>) =>
        firstValueFrom(from(pending).pipe(timeout(30_000)));
      try {
        let input = this.pendingInitialDiagrams.get(docId);
        if (!retry) {
          if (!input) throw new Error("DIAGRAM_INTENT_UNAVAILABLE");
          const initialization = input.initialization;
          const nativeInput =
            input.format === "mermaid" && input.edgelessPlacement === "native"
              ? input
              : undefined;
          stage("registration");
          await step(
            this.docsService.createProvisionedDoc(
              {
                id: docId,
                title: input.title,
                ...(initialization
                  ? {
                      docProps: {
                        atomic: true,
                        onStoreLoad: (doc: Store) => {
                          if (
                            initializeBpmnDocument(doc, initialization)
                              .status !== "initialized"
                          )
                            throw new Error(
                              "DIAGRAM_INITIALIZATION_INCOMPLETE",
                            );
                        },
                      },
                    }
                  : nativeInput
                    ? {
                        docProps: {
                          onStoreLoad: (
                            _doc: Store,
                            { noteId }: { noteId: string },
                          ) => {
                            nativeInput.bootstrapNoteId = noteId;
                          },
                        },
                      }
                    : {}),
              },
              { retainOnFailure: true },
            ),
          );
        }
        const workspace = this.workspaceService.workspace;
        let lease = this.docsService.open(docId);
        if (!lease && retry && workspace.flavour !== "local") {
          stage("registration");
          await step(this.docsService.recoverDocRegistration(docId));
          lease = this.docsService.open(docId);
        }
        if (!lease) throw new Error("DIAGRAM_RECORD_UNAVAILABLE");
        release = lease.release;
        const doc = lease.doc;
        stage("content");
        await doc.waitForSyncReady(signal);
        const page = doc.virgultumDoc;
        if (!input) {
          const record = this.docsService.list.doc$(docId).value;
          // Explicit recovery reads persisted content. Unknown/empty documents
          // are not permission to manufacture a blank BPMN or Mermaid source.
          if (page.getBlocksByFlavour("myoxus:bpmn").length !== 1)
            throw new Error("DIAGRAM_SOURCE_UNAVAILABLE");
          input = {
            format: "bpmn",
            type: "bpmn",
            title: record?.title$.value ?? "",
          };
        }
        if (input.format === "bpmn" && input.initialization) {
          if (
            initializeBpmnDocument(page, input.initialization).status !==
            "initialized"
          )
            throw new Error("DIAGRAM_INITIALIZATION_INCOMPLETE");
        }
        const block =
          input.format === "bpmn"
            ? page.getBlocksByFlavour("myoxus:bpmn")[0]?.model
            : undefined;
        if (
          input.format === "bpmn" &&
          (!block || page.getBlocksByFlavour("myoxus:bpmn").length !== 1)
        )
          throw new Error("DIAGRAM_SOURCE_UNAVAILABLE");
        const before = block
          ? [...readBpmnSourceRevisions(block.yBlock).heads]
          : undefined;
        if (block && before?.length === 0)
          throw new Error("DIAGRAM_SOURCE_UNAVAILABLE");
        // Save the complete real leaf bytes. A no-op transaction or local
        // workspace's early-returning remote wait cannot prove this durability.
        await step(
          workspace.engine.doc.saveCapturedUpdateAndWaitForSaved(
            docId,
            encodeStateAsUpdate(doc.yDoc),
          ),
        );
        stage("registration");
        if (workspace.flavour !== "local") {
          const state = await firstValueFrom(
            workspace.engine.doc.docState$(docId).pipe(timeout(30_000)),
          );
          if (retry && state.pageRegistration !== "registered")
            await step(this.docsService.recoverDocRegistration(docId));
          await this.docsService.waitForCreateAcknowledgement(
            docId,
            signal,
            true,
          );
          await this.docsService.waitForDocSynced(docId, signal);
        }
        const record = this.docsService.list.doc$(docId).value;
        if (!record || record.trash$.value)
          throw new Error("DIAGRAM_RECORD_UNAVAILABLE");
        stage("presentation");
        signal.throwIfAborted();
        await step(record.setPrimaryMode("edgeless"));
        stage("classification");
        signal.throwIfAborted();
        await step(this.markDiagramDoc(docId, input.format, input.type));
        if (
          block &&
          JSON.stringify(before) !==
            JSON.stringify([...readBpmnSourceRevisions(block.yBlock).heads])
        )
          throw new Error("DIAGRAM_SOURCE_CHANGED");
        this.creation$.next({
          ...this.creation$.value,
          docId,
          stage: "classification",
          busy: false,
          failed: false,
        });
        if (input.format === "bpmn")
          this.completeInitialDiagramForEditor(docId);
        return { status: "ready", docId };
      } catch {
        const failedAt = this.creation$.value?.stage ?? "creation";
        this.creation$.next({
          ...this.creation$.value,
          docId,
          busy: false,
          failed: true,
          stage: failedAt,
        });
        return { status: "failed", docId, stage: failedAt };
      } finally {
        release?.();
      }
    })();
    this.creating = operation;
    void operation.finally(() => {
      if (this.creating === operation) this.creating = null;
    });
    return operation;
  }

  /** Revalidate after asynchronous preparation; an unmounted editor's lease
   * must not consume intent claimed by its replacement. This is local lifetime
   * control, not a lock against peer Yjs changes. */
  isInitialDiagramClaimCurrent(docId: string, claim: symbol) {
    return this.claimedInitialDiagramIds.get(docId) === claim;
  }

  initializeBpmnForEditor(docId: string, doc: Store): BpmnInitializationResult {
    const initialization =
      this.pendingInitialDiagrams.get(docId)?.initialization;
    return initialization
      ? initializeBpmnDocument(doc, initialization)
      : { status: "retryable" };
  }

  getInitialDiagramForEditor(docId: string, doc: Store) {
    const pending = this.pendingInitialDiagrams.get(docId);
    // Pending intent is a creation cache, never authority to replace persisted
    // content. Fully loaded existing blocks own their source after reload.
    if (!pending && !this.isDiagramDoc(docId)) return null;
    const metadata = this.docsService.list.doc$(docId).value?.meta$.value;
    const bpmnIntent =
      pending?.format === "bpmn" || metadata?.diagramFormat === "bpmn";
    if (
      doc.getBlocksByFlavour("myoxus:bpmn").length > 0 ||
      (!bpmnIntent && hasInitializedDiagramContent(doc))
    ) {
      this.pendingInitialDiagrams.delete(docId);
      this.claimedInitialDiagramIds.delete(docId);
      return null;
    }
    if (this.claimedInitialDiagramIds.has(docId)) return null;
    const initialDiagram =
      pending ??
      (metadata?.diagramFormat === "bpmn"
        ? {
            format: "bpmn" as const,
            title: metadata.title || "BPMN",
            type: "bpmn" as const,
          }
        : null);
    if (!initialDiagram) return null;
    const claim = Symbol(docId);
    this.claimedInitialDiagramIds.set(docId, claim);
    return { ...initialDiagram, claim };
  }

  completeInitialDiagramForEditor(docId: string, claim?: symbol) {
    if (claim && this.claimedInitialDiagramIds.get(docId) !== claim) return;
    this.pendingInitialDiagrams.delete(docId);
    this.claimedInitialDiagramIds.delete(docId);
  }

  releaseInitialDiagramForEditor(docId: string, claim?: symbol) {
    // An async continuation from an older mount cannot release a newer lease.
    if (!claim || this.claimedInitialDiagramIds.get(docId) === claim)
      this.claimedInitialDiagramIds.delete(docId);
  }
}
