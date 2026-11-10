import { sha } from "@virgultum/global/utils";
import {
  replaceIdMiddleware,
  titleMiddleware,
} from "@virgultum/shared/adapters";
import { remapDocumentFieldIdentities } from "@virgultum/shared/types";
import {
  type DocSnapshot,
  extMimeMap,
  getAssetName,
  type Schema,
  type Store,
  Transformer,
  type Workspace,
} from "@virgultum/store";

import { download, Unzip, Zip } from "./utils.js";

async function exportDocs(
  collection: Workspace,
  schema: Schema,
  docs: Store[],
  labels?: {
    workspaceTags: unknown;
    documents: { sourceId: string; tags: string[] }[];
  },
) {
  const zip = new Zip();
  const job = new Transformer({
    schema,
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => collection.createDoc(id).getStore({ id }),
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
    middlewares: [
      replaceIdMiddleware(collection.idGenerator),
      titleMiddleware(collection.meta.docMetas),
    ],
  });

  const assignments =
    labels && new Map(labels.documents.map((doc) => [doc.sourceId, doc.tags]));
  await Promise.all(
    docs.map(async (doc) => {
      const snapshot = job.docToSnapshot(doc);
      if (!snapshot)
        throw new Error("Document snapshot is unavailable for export");
      if (assignments) {
        const tags = assignments.get(doc.id);
        if (!tags)
          throw new Error("Canonical export label assignment is unavailable");
        // Resolve with the source store ID, independently of serializer output
        // identity. Only the detached snapshot receives canonical labels.
        snapshot.meta.tags = [...tags];
      }
      const title = snapshot.meta.title || "untitled";
      await zip.file(
        `${title}-${snapshot.meta.id}.snapshot.json`,
        JSON.stringify(snapshot, null, 2),
      );
    }),
  );
  await zip.file(
    "info.json",
    JSON.stringify({
      workspaceTags:
        labels?.workspaceTags ?? collection.meta.properties.tags?.options ?? [],
    }),
  );

  const assets = zip.folder("assets");
  const pathBlobIdMap = job.assetsManager.getPathBlobIdMap();
  const assetsMap = job.assets;

  // Add blobs to assets folder, if failed, log the error and continue
  const results = await Promise.all(
    Array.from(pathBlobIdMap.values()).map(async (blobId) => {
      try {
        await job.assetsManager.readFromBlob(blobId);
        const ext = getAssetName(assetsMap, blobId).split(".").at(-1);
        const blob = assetsMap.get(blobId);
        if (blob) {
          await assets.file(`${blobId}.${ext}`, blob);
          return { success: true, blobId };
        }
        return { success: false, blobId, error: "Blob not found" };
      } catch (error) {
        console.error(`Failed to process blob: ${blobId}`, error);
        return { success: false, blobId, error };
      }
    }),
  );

  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    console.warn(`Failed to process ${failures.length} blobs:`, failures);
  }

  const downloadBlob = await zip.generate();
  // Use the collection id as the zip file name
  return download(downloadBlob, `${collection.id}.bs.zip`);
}

export type SnapshotImportLabels = {
  catalog: unknown;
  documents: { sourceId: string; tags: unknown }[];
};

export type SnapshotImportHooks = {
  validateLabels: (labels: SnapshotImportLabels) => Promise<void>;
  applyLabels: (
    labels: SnapshotImportLabels,
    targets: Map<string, string>,
  ) => Promise<void>;
  compensate: (docIds: string[]) => Promise<void>;
};

async function importDocs(
  collection: Workspace,
  schema: Schema,
  imported: Blob,
  hooks?: SnapshotImportHooks,
) {
  const unzip = new Unzip();
  await unzip.load(imported);

  const assetBlobs: [string, Blob][] = [];
  const snapshotsBlobs: Blob[] = [];
  let catalog: unknown = [];

  for await (const { path, content: blob } of unzip) {
    if (path.includes("MACOSX") || path.includes("DS_Store")) {
      continue;
    }

    if (path.startsWith("assets/")) {
      assetBlobs.push([path, blob]);
      continue;
    }

    if (path === "info.json") {
      catalog =
        (JSON.parse(await blob.text()) as { workspaceTags?: unknown })
          .workspaceTags ?? [];
      continue;
    }

    if (path.endsWith(".snapshot.json")) {
      snapshotsBlobs.push(blob);
      continue;
    }
  }

  const snapshots = await Promise.all(
    snapshotsBlobs.map(
      async (blob) => JSON.parse(await blob.text()) as DocSnapshot,
    ),
  );
  const labels: SnapshotImportLabels = {
    catalog,
    documents: snapshots.map((snapshot) => ({
      sourceId: snapshot.meta.id,
      tags: snapshot.meta.tags ?? [],
    })),
  };
  // Remote authority validates the complete metadata before any docCRUD.create.
  await hooks?.validateLabels(labels);
  // Snapshot archives preserve captured fields verbatim. Their destination is
  // a new editable document, so rebind occurrences before any doc is created.
  snapshots.forEach((snapshot) =>
    remapDocumentFieldIdentities(snapshot, collection.idGenerator),
  );
  if (hooks)
    snapshots.forEach((snapshot) => {
      snapshot.meta.tags = [];
    });
  const created: string[] = [];
  const targets = new Map<string, string>();

  const job = new Transformer({
    schema,
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => {
        created.push(id);
        return collection.createDoc(id).getStore({ id });
      },
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
    middlewares: [
      replaceIdMiddleware(collection.idGenerator),
      titleMiddleware(collection.meta.docMetas),
    ],
  });
  const assetsMap = job.assets;

  assetBlobs.forEach(([name, blob]) => {
    const nameWithExt = name.replace("assets/", "");
    const assetsId = nameWithExt.replace(/\.[^/.]+$/, "");
    const ext = nameWithExt.split(".").at(-1) ?? "";
    const mime = extMimeMap.get(ext) ?? "";
    const file = new File([blob], nameWithExt, {
      type: mime,
    });
    assetsMap.set(assetsId, file);
  });

  const results = await Promise.allSettled(
    snapshots.map(async (snapshot, index) => {
      const tasks: Promise<void>[] = [];

      job.walk(snapshot, (block) => {
        const sourceId = block.props?.sourceId as string | undefined;

        if (sourceId && sourceId.startsWith("/")) {
          const removeSlashId = sourceId.replace(/^\//, "");

          if (assetsMap.has(removeSlashId)) {
            const blob = assetsMap.get(removeSlashId)!;

            tasks.push(
              blob
                .arrayBuffer()
                .then((buffer) => sha(buffer))
                .then((hash) => {
                  assetsMap.set(hash, blob);
                  block.props.sourceId = hash;
                }),
            );
          }
        }
      });

      await Promise.all(tasks);

      const doc = await job.snapshotToDoc(snapshot);
      if (!doc)
        throw new Error("Snapshot document import did not produce a document");
      collection.meta.setDocMeta(doc.id, { title: snapshot.meta.title });
      targets.set(labels.documents[index].sourceId, doc.id);
      return doc;
    }),
  );
  try {
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await hooks?.applyLabels(labels, targets);
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  } catch (error) {
    // Await all creators before compensation so a late task cannot recreate a
    // document after the failure has already been reported.
    if (hooks) {
      try {
        await hooks.compensate(created);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Snapshot import compensation failed",
        );
      }
    } else {
      created.forEach((id) => collection.removeDoc(id));
    }
    throw error;
  }
}

export const ZipTransformer = {
  exportDocs,
  importDocs,
};
