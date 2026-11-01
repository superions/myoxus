/**
 * @vitest-environment happy-dom
 */

import { Framework, LiveData } from "@myoxus/infra";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Doc as YDoc } from "yjs";

import { DocsService } from "../../doc";
import { DIAGRAM_DOC_KIND } from "../constants";
import { MermaidDiagramsStore } from "../store/mermaid-diagrams";
import { WorkspaceService } from "../../workspace";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function docRecord(id: string, docKind?: string, trash = false) {
  const doc = {
    id,
    meta$: new LiveData({ id, docKind }),
    trash$: new LiveData(trash),
    setMeta: (value: { docKind?: string }) => {
      doc.meta$.next({ ...doc.meta$.value, ...value });
    },
  };
  return doc;
}

type TestDoc = ReturnType<typeof docRecord>;

function createStore(docs: TestDoc[]) {
  const docsMap$ = new LiveData(new Map(docs.map((doc) => [doc.id, doc])));
  const nonTrashDocIds$ = new LiveData(
    docs.filter((doc) => !doc.trash$.value).map((doc) => doc.id),
  );
  const docsService = {
    list: {
      docsMap$,
      doc$: (id: string) =>
        docsMap$.selector((docsById) => docsById.get(id) ?? undefined),
    },
    allNonTrashDocIds$: () => nonTrashDocIds$,
  } as unknown as DocsService;
  const framework = new Framework();
  const rootYDoc = new YDoc();
  const updateAndWaitForSaved = vi.fn(async (_id: string, write: () => void) =>
    write(),
  );
  const saveCapturedUpdateAndWaitForSaved = vi.fn(async () => {});
  framework.service(WorkspaceService, {
    workspace: {
      id: "root",
      flavour: "local",
      rootYDoc,
      engine: {
        doc: { updateAndWaitForSaved, saveCapturedUpdateAndWaitForSaved },
      },
    },
  } as unknown as WorkspaceService);
  framework.service(DocsService, docsService);
  framework.store(MermaidDiagramsStore, [DocsService, WorkspaceService]);
  const provider = framework.provider();
  cleanups.push(() => {
    provider.dispose();
    rootYDoc.destroy();
  });
  return {
    nonTrashDocIds$,
    store: provider.get(MermaidDiagramsStore),
    updateAndWaitForSaved,
    saveCapturedUpdateAndWaitForSaved,
  };
}

describe("MermaidDiagramsStore", () => {
  test("indexes only non-trash first-class Mermaid diagram documents", () => {
    const diagram = docRecord("diagram", DIAGRAM_DOC_KIND);
    const plain = docRecord("plain", undefined);
    const trashed = docRecord("trashed", DIAGRAM_DOC_KIND, true);
    const { store } = createStore([diagram, plain, trashed]);

    expect(store.getDiagramDocIds()).toEqual(["diagram"]);
    expect(store.getDiagramDocs()).toEqual([diagram]);
    expect(store.isDiagramDoc("diagram")).toBe(true);
    expect(store.isDiagramDoc("plain")).toBe(false);
  });

  test("reacts when diagram docs are trashed and restored", () => {
    const diagram = docRecord("diagram", DIAGRAM_DOC_KIND);
    const { store, nonTrashDocIds$ } = createStore([diagram]);

    expect(store.diagramIds$.value).toEqual(["diagram"]);

    nonTrashDocIds$.next([]);
    expect(store.diagramIds$.value).toEqual([]);

    nonTrashDocIds$.next(["diagram"]);
    expect(store.diagramIds$.value).toEqual(["diagram"]);
  });

  test("assigns and acknowledges synchronized doc metadata through its native root owner", async () => {
    const doc = docRecord("doc", undefined);
    const { store, updateAndWaitForSaved, saveCapturedUpdateAndWaitForSaved } =
      createStore([doc]);

    expect(store.diagramIds$.value).toEqual([]);

    await store.setDiagramDocKind(doc.id, "bpmn", "bpmn");

    expect(store.diagramIds$.value).toEqual(["doc"]);
    expect(updateAndWaitForSaved).toHaveBeenCalledOnce();
    await store.setDiagramDocKind(doc.id, "bpmn", "bpmn");
    expect(saveCapturedUpdateAndWaitForSaved).toHaveBeenCalledOnce();
    await expect(
      store.setDiagramDocKind("missing", "bpmn", "bpmn"),
    ).rejects.toThrow("DIAGRAM_RECORD_UNAVAILABLE");
  });
});
