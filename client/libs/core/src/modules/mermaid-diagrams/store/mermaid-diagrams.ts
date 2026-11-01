import { LiveData, Store } from "@myoxus/infra";
import { encodeStateAsUpdate } from "yjs";

import type { DocRecord, DocsService } from "../../doc";
import type { WorkspaceService } from "../../workspace";
import { DIAGRAM_DOC_KIND } from "../constants";

function isDiagramKind(value?: string) {
  return value === DIAGRAM_DOC_KIND;
}

function normalizeDocKind(value: string | null | undefined) {
  return value ?? undefined;
}

export class MermaidDiagramsStore extends Store {
  constructor(
    private readonly docsService: DocsService,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
  }

  private readonly nonTrashDocIds$ = LiveData.from(
    this.docsService.allNonTrashDocIds$(),
    [],
  );

  readonly diagramDocs$ = LiveData.computed((get) => {
    const nonTrashDocIds = get(this.nonTrashDocIds$);
    const docsMap = get(this.docsService.list.docsMap$);
    const docs: DocRecord[] = [];

    for (const docId of nonTrashDocIds) {
      const doc = docsMap.get(docId);
      if (doc && isDiagramKind(normalizeDocKind(get(doc.meta$).docKind))) {
        docs.push(doc);
      }
    }

    return docs;
  });

  readonly diagramIds$ = this.diagramDocs$.map((docs) =>
    docs.map((doc) => doc.id),
  );

  diagramDoc$(docId: string) {
    return LiveData.computed((get) => {
      const doc = get(this.docsService.list.doc$(docId));
      if (!doc) return undefined;
      const docKind = normalizeDocKind(get(doc.meta$).docKind);
      if (!isDiagramKind(docKind)) return undefined;
      return doc;
    });
  }

  isDiagramDoc$(docId: string) {
    return this.diagramDoc$(docId).map(Boolean);
  }

  getDiagramDocs() {
    return this.diagramDocs$.value;
  }

  getDiagramDocIds() {
    return this.diagramIds$.value;
  }

  isDiagramDoc(docId: string) {
    const doc = this.docsService.list.doc$(docId).value;
    return isDiagramKind(normalizeDocKind(doc?.meta$.value.docKind));
  }

  async setDiagramDocKind(
    docId: string,
    format?: "bpmn" | "mermaid",
    diagramType?: string,
  ) {
    const doc = this.docsService.list.doc$(docId).value;
    if (!doc) throw new Error("DIAGRAM_RECORD_UNAVAILABLE");
    const workspace = this.workspaceService.workspace;
    const meta = {
      docKind: DIAGRAM_DOC_KIND,
      diagramFormat: format,
      diagramType,
    };
    const matches = () =>
      Object.entries(meta).every(
        ([key, value]) => doc.meta$.value[key as keyof typeof meta] === value,
      );
    if (matches()) {
      // Retry must prove existing root bytes are saved, not acknowledge a no-op.
      await workspace.engine.doc.saveCapturedUpdateAndWaitForSaved(
        workspace.id,
        encodeStateAsUpdate(workspace.rootYDoc),
      );
    } else {
      await workspace.engine.doc.updateAndWaitForSaved(workspace.id, () =>
        doc.setMeta(meta),
      );
    }
    if (workspace.flavour !== "local")
      await workspace.engine.doc.waitForSynced(
        workspace.id,
        AbortSignal.timeout(30_000),
      );
    if (!matches()) throw new Error("DIAGRAM_CLASSIFICATION_CHANGED");
  }

  removeDiagramDocKind(docId: string) {
    const doc = this.docsService.list.doc$(docId).value;
    doc?.setMeta({
      docKind: undefined,
      diagramFormat: undefined,
      diagramType: undefined,
    });
  }
}
