import { Array as YArray, type Doc as YDoc, Map as YMap } from "yjs";

type ReadAllBlocksOptions = {
  ydoc: YDoc;
  rootYDoc: YDoc;
  spaceId: string;
  maxSummaryLength: number;
};

/**
 * Keep document extraction behind an explicit worker-local async boundary.
 * The reader uses only Yjs and the DOM-free delta-to-Markdown converter; it
 * must never make Virgultum schemas, adapters or browser globals part of the
 * storage worker chunk.
 */
export async function readAllBlocksForIndexer(options: ReadAllBlocksOptions) {
  const { readAllBlocksFromDoc } = await import("@myoxus/reader");
  return readAllBlocksFromDoc(options);
}

/**
 * Read the lightweight document directory from the workspace root Y.Doc.
 *
 * This intentionally lives in `@myoxus/storage` instead of `@myoxus/reader`:
 * the storage worker needs root metadata during boot, while `@myoxus/reader`
 * also initializes the full Virgultum schema/Markdown stack and therefore
 * pulls DOM/Lit modules into worker bundles.
 */
export function readAllDocsFromRootDoc(
  rootDoc: YDoc,
  options?: {
    includeTrash?: boolean;
  },
) {
  const docs = rootDoc.getMap("meta").get("pages") as
    YArray<YMap<unknown>> | undefined;
  const availableDocs = new Map<string, { title: string | undefined }>();

  if (!docs) {
    return availableDocs;
  }

  for (const page of docs) {
    const docId = page.get("id");
    if (typeof docId !== "string") {
      continue;
    }

    const inTrash = page.get("trash") ?? false;
    if (!options?.includeTrash && inTrash) {
      continue;
    }

    const title = page.get("title");
    availableDocs.set(docId, {
      title: typeof title === "string" ? title : undefined,
    });
  }

  return availableDocs;
}
