import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import {
  type DocSnapshot,
  type Store,
  Transformer,
} from "@virgultum/editor/store";
import { Doc as YDoc } from "yjs";
export const getCollection = (() => {
  let collection: WorkspaceImpl | null = null;
  return function () {
    if (collection) {
      return collection;
    }
    collection = new WorkspaceImpl({
      id: "edgeless-settings",
      rootDoc: new YDoc({ guid: "edgeless-settings" }),
    });
    collection.meta.initialize();
    return collection;
  };
})();

export type DocName =
  | "note"
  | "pen"
  | "shape"
  | "flow"
  | "text"
  | "connector"
  | "mindmap"
  | "frame";

type DocLoadOptions = {
  textReplacements?: Record<string, string>;
};

const docMap = new Map<string, Promise<Store | undefined>>();

async function loadNote() {
  return (await import("./note.json")).default;
}

async function loadPen() {
  return (await import("./pen.json")).default;
}

async function loadShape() {
  return (await import("./shape.json")).default;
}

async function loadFrame() {
  return (await import("./frame.json")).default;
}

async function loadFlow() {
  return (await import("./flow.json")).default;
}

async function loadText() {
  return (await import("./text.json")).default;
}

async function loadConnector() {
  return (await import("./connector.json")).default;
}

async function loadMindmap() {
  return (await import("./mindmap.json")).default;
}

const loaders = {
  note: loadNote,
  pen: loadPen,
  shape: loadShape,
  frame: loadFrame,
  flow: loadFlow,
  text: loadText,
  connector: loadConnector,
  mindmap: loadMindmap,
};

export async function getDocByName(name: DocName, options?: DocLoadOptions) {
  const cacheKey = buildCacheKey(name, options?.textReplacements);
  if (docMap.get(cacheKey)) {
    return docMap.get(cacheKey);
  }

  const promise = initDoc(name, options);
  docMap.set(cacheKey, promise);
  return promise;
}

function buildCacheKey(
  name: DocName,
  textReplacements?: Record<string, string>,
) {
  if (!textReplacements || Object.keys(textReplacements).length === 0) {
    return name;
  }
  return `${name}:${Object.entries(textReplacements)
    .map(([from, to]) => `${from}=>${to}`)
    .join("\u0001")}`;
}

function applySnapshotTextReplacements(
  snapshot: DocSnapshot,
  textReplacements?: Record<string, string>,
) {
  if (!textReplacements || Object.keys(textReplacements).length === 0) {
    return snapshot;
  }

  const localizedSnapshot = JSON.parse(JSON.stringify(snapshot)) as DocSnapshot;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.insert === "string") {
      record.insert = textReplacements[record.insert] ?? record.insert;
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(localizedSnapshot);
  return localizedSnapshot;
}

async function initDoc(name: DocName, options?: DocLoadOptions) {
  const snapshot = applySnapshotTextReplacements(
    (await loaders[name]()) as DocSnapshot,
    options?.textReplacements,
  );
  const collection = getCollection();
  const transformer = new Transformer({
    schema: getMyoxusWorkspaceSchema(),
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => collection.createDoc(id).getStore({ id }),
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
    middlewares: [],
  });

  return await transformer.snapshotToDoc(snapshot);
}
