import { Container } from "@virgultum/global/di";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { sha } from "@virgultum/global/utils";
import {
  defaultImageProxyMiddleware,
  documentReferenceMiddleware,
  finalizeMarkdownNativeReferences,
  markdownNativeTargets,
  markdownDocumentReferences,
  prepareMarkdownDocumentExport,
  authorizedMarkdownReferenceMetas,
  captureMarkdownReferenceSnapshots,
  configureMarkdownReferenceMetas,
  docLinkBaseURLMiddleware,
  fileNameMiddleware,
  filePathMiddleware,
  importedDocumentIdMiddleware,
  MarkdownAdapter,
  normalizeMarkdownSourcePath,
  emptyMarkdownImportDiagnostics,
  type MarkdownImportDiagnostics,
  type MarkdownNativeTarget,
} from "@virgultum/shared/adapters";
import {
  type DocMeta,
  type BlockSnapshot,
  type DocSnapshot,
  type ExtensionType,
  extMimeMap,
  type Schema,
  type Store,
  type SliceImportOperation,
  Transformer,
  type TransformerMiddleware,
  type Workspace,
} from "@virgultum/store";
import {
  DocEmbedProvider,
  DocumentFieldOutputProvider,
} from "@virgultum/shared/services";

import type { AssetMap, ImportedFileEntry, PathBlobIdMap } from "./type.js";
import { createAssetsArchive, download, parseMatter, Unzip } from "./utils.js";

type ParsedFrontmatterMeta = Partial<
  Pick<DocMeta, "title" | "createDate" | "updatedDate" | "tags" | "favorite">
>;

const FRONTMATTER_KEYS = {
  title: ["title", "name"],
  created: [
    "created",
    "createdat",
    "created_at",
    "createddate",
    "created_date",
    "creationdate",
    "date",
    "time",
  ],
  updated: [
    "updated",
    "updatedat",
    "updated_at",
    "updateddate",
    "updated_date",
    "modified",
    "modifiedat",
    "modified_at",
    "lastmodified",
    "last_modified",
    "lastedited",
    "last_edited",
    "lasteditedtime",
    "last_edited_time",
  ],
  tags: ["tags", "tag", "categories", "category", "labels", "keywords"],
  favorite: ["favorite", "favourite", "star", "starred", "pinned"],
  trash: ["trash", "trashed", "deleted", "archived"],
};

const truthyStrings = new Set(["true", "yes", "y", "1", "on"]);
const falsyStrings = new Set(["false", "no", "n", "0", "off"]);

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (truthyStrings.has(normalized)) return true;
    if (falsyStrings.has(normalized)) return false;
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (value && value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e10 ? value : Math.round(value * 1000);
  }
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    const num = Number(value);
    if (!Number.isNaN(num)) {
      return num > 1e10 ? num : Math.round(num * 1000);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value
      .map((v) => (typeof v === "string" ? v : String(v)))
      .map((v) => v.trim())
      .filter(Boolean);
    return tags.length ? [...new Set(tags)] : undefined;
  }
  if (typeof value === "string") {
    const tags = value
      .split(/[,;]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    return tags.length ? [...new Set(tags)] : undefined;
  }
  return undefined;
}

function buildMetaFromFrontmatter(
  data: Record<string, unknown>,
): ParsedFrontmatterMeta {
  const meta: ParsedFrontmatterMeta = {};
  for (const [rawKey, value] of Object.entries(data)) {
    const key = rawKey.trim().toLowerCase();
    if (FRONTMATTER_KEYS.title.includes(key) && typeof value === "string") {
      const title = value.trim();
      if (title) meta.title = title;
      continue;
    }
    if (FRONTMATTER_KEYS.created.includes(key)) {
      const timestamp = parseTimestamp(value);
      if (timestamp !== undefined) {
        meta.createDate = timestamp;
      }
      continue;
    }
    if (FRONTMATTER_KEYS.updated.includes(key)) {
      const timestamp = parseTimestamp(value);
      if (timestamp !== undefined) {
        meta.updatedDate = timestamp;
      }
      continue;
    }
    if (FRONTMATTER_KEYS.tags.includes(key)) {
      const tags = parseTags(value);
      if (tags) meta.tags = tags;
      continue;
    }
    if (FRONTMATTER_KEYS.favorite.includes(key)) {
      const favorite = parseBoolean(value);
      if (favorite !== undefined) {
        meta.favorite = favorite;
      }
      continue;
    }
  }
  return meta;
}

function parseFrontmatter(markdown: string): {
  content: string;
  meta: ParsedFrontmatterMeta;
} {
  // Only a document-leading YAML header owns metadata. Literal annotation
  // bodies may contain delimiter lines and must never be mistaken for it.
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n"))
    return { content: markdown, meta: {} };
  try {
    const parsed = parseMatter(markdown);
    if (!parsed) {
      return { content: markdown, meta: {} };
    }
    const content = parsed.body ?? markdown;

    if (Array.isArray(parsed.metadata)) {
      return { content: String(content), meta: {} };
    }

    const meta = buildMetaFromFrontmatter({ ...parsed.metadata });
    return { content: String(content), meta };
  } catch {
    return { content: markdown, meta: {} };
  }
}

function applyMetaPatch(
  collection: Workspace,
  docId: string,
  meta: ParsedFrontmatterMeta,
) {
  const metaPatch: Partial<DocMeta> = {};
  if (meta.title) metaPatch.title = meta.title;
  if (meta.createDate !== undefined) metaPatch.createDate = meta.createDate;
  if (meta.updatedDate !== undefined) metaPatch.updatedDate = meta.updatedDate;
  if (meta.tags) metaPatch.tags = meta.tags;
  if (meta.favorite !== undefined) metaPatch.favorite = meta.favorite;

  if (Object.keys(metaPatch).length) {
    collection.meta.setDocMeta(docId, metaPatch);
  }
}

function consumeMatchingMarkdownTitle(
  title?: string,
  referencedBlocks: ReadonlySet<string> = new Set(),
): TransformerMiddleware {
  return ({ slots }) => {
    const subscription = slots.beforeImport.subscribe((payload) => {
      if (payload.type !== "page" || !title) return;

      const note = payload.snapshot.blocks.children.find(
        (block) => block.flavour === "myoxus:note",
      );
      const firstBlock = note?.children[0];
      if (
        firstBlock?.flavour !== "myoxus:paragraph" ||
        firstBlock.props.type !== "h1"
      ) {
        return;
      }

      const heading = (
        firstBlock.props.text as
          { delta?: Array<{ insert?: unknown }> } | undefined
      )?.delta
        ?.map(({ insert }) => (typeof insert === "string" ? insert : ""))
        .join("");

      // Full-document exports serialize the page title as the first H1. Treat
      // only an exact match as metadata so unrelated leading headings survive.
      // An explicit source anchor owns a real navigation target, not metadata.
      if (
        heading === title &&
        firstBlock.props.markdownAnchor === undefined &&
        !referencedBlocks.has(firstBlock.id)
      )
        note?.children.shift();
    });

    return () => subscription.unsubscribe();
  };
}

function collectReferencedBlocks(
  root: BlockSnapshot,
  references: Map<string, Set<string>>,
) {
  for (const [id, blockIds] of markdownDocumentReferences(root)) {
    const targets = references.get(id) ?? new Set<string>();
    for (const blockId of blockIds) targets.add(blockId);
    references.set(id, targets);
  }
}

async function finalizeNativeReferences(
  prepared: Array<{
    snapshot: DocSnapshot;
    job: Transformer;
    mdAdapter: MarkdownAdapter;
  }>,
  authorizedTitles: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, readonly MarkdownNativeTarget[]> = new Map(),
  signal?: AbortSignal,
) {
  return finalizeMarkdownNativeReferences(
    prepared.map(({ snapshot, job, mdAdapter }) => ({
      documentId: snapshot.meta.id,
      root: snapshot.blocks,
      configs: job.adapterConfigs,
      resolve: () => mdAdapter.resolveImportReferences(),
    })),
    authorizedTitles,
    existing,
    signal,
  );
}

/** Rebind the retained parser trees before any docCRUD writes. New batch IDs
 * are operation-owned; existing IDs require the host's normal read capability.
 */
async function prepareImportedReferences(
  collection: Workspace,
  prepared: Parameters<typeof finalizeNativeReferences>[0],
  planned: Array<Pick<DocMeta, "id" | "title">>,
  referenceMetas: Array<Pick<DocMeta, "id" | "title">>,
  access: DocEmbedProvider | undefined,
) {
  const signal = AbortSignal.timeout(30_000);
  const plannedIds = new Set(planned.map(({ id }) => id));
  const candidates = new Set(
    prepared
      .flatMap(({ mdAdapter }) => [...mdAdapter.referencedDocumentIds])
      .filter((id) => !plannedIds.has(id)),
  );
  const captured = await captureMarkdownReferenceSnapshots(
    collection,
    referenceMetas,
    candidates,
    access,
    signal,
  );
  const initialIds = new Set(referenceMetas.map(({ id }) => id));
  const current = (
    await authorizedMarkdownReferenceMetas(collection, access)
  ).filter(({ id }) => initialIds.has(id));
  const metas = [...current, ...planned];
  const titles = new Map(metas.map(({ id, title }) => [id, title]));
  for (const { job } of prepared)
    configureMarkdownReferenceMetas(job.adapterConfigs, metas);
  await finalizeNativeReferences(
    prepared,
    titles,
    new Map(
      [...candidates]
        .filter((id) => titles.has(id))
        .map((id) => {
          const snapshot = captured.snapshots.get(id);
          return [
            id,
            snapshot ? markdownNativeTargets(snapshot.blocks, titles) : [],
          ];
        }),
    ),
    signal,
  );
  // Asset preparation and fixed-point heading resolution are asynchronous.
  // Losing an existing target's access cancels creation, rather than publishing
  // a snapshot whose target/title was read under a now-invalid capability.
  return async () => {
    for (const id of candidates) {
      signal.throwIfAborted();
      if (
        titles.has(id) &&
        (!collection.meta.getDocMeta(id) || !(await access?.canRead(id)))
      )
        throw new Error("Markdown import reference access lost");
    }
  };
}

function getProvider(extensions: ExtensionType[]) {
  const container = new Container();
  extensions.forEach((ext) => {
    ext.setup(container);
  });
  return container.provider();
}

type ImportMarkdownToBlockOptions = {
  doc: Store;
  markdown: string;
  blockId: string;
  extensions: ExtensionType[];
  access?: DocEmbedProvider;
  replaceExistingTargets?: boolean;
  /** Called once, after model preparation, inside the first fenced write.
   * May create the already-reserved destination block, or replace its contents.
   */
  beforeInsert?: () => void;
  operation?: SliceImportOperation;
};

type ImportMarkdownToDocOptions = {
  collection: Workspace;
  schema: Schema;
  markdown: string;
  fileName?: string;
  extensions: ExtensionType[];
  access?: DocEmbedProvider;
};

type ImportMarkdownZipOptions = {
  collection: Workspace;
  schema: Schema;
  imported: Blob;
  extensions: ExtensionType[];
  access?: DocEmbedProvider;
};

export type MarkdownDocumentImportResult = {
  docId?: string;
  diagnostics: MarkdownImportDiagnostics;
};

export type MarkdownZipImportResult = {
  docIds: string[];
  diagnostics: MarkdownImportDiagnostics;
};

function addDiagnostics(
  aggregate: MarkdownImportDiagnostics,
  diagnostics: Readonly<MarkdownImportDiagnostics>,
) {
  aggregate.unresolvedReferences += diagnostics.unresolvedReferences;
  aggregate.unsupportedReferences += diagnostics.unsupportedReferences;
  for (const key of [
    "unsupportedAnnotations",
    "normalizedAnnotations",
    "unsupportedCallouts",
    "unsupportedMath",
    "unsupportedTables",
  ] as const) {
    if (diagnostics[key])
      aggregate[key] = (aggregate[key] ?? 0) + diagnostics[key];
  }
}

/**
 * Exports a doc to a Markdown file or a zip archive containing Markdown and assets.
 * @param doc The doc to export
 * @returns A Promise that resolves when the export is complete
 */
async function exportDoc(
  doc: Store,
  access?: DocEmbedProvider,
  fields?: DocumentFieldOutputProvider,
) {
  const prepared = await prepareMarkdownDocumentExport(doc, access);
  const provider = doc.provider;
  using job = doc.getTransformer([
    docLinkBaseURLMiddleware(doc.workspace.id),
    documentReferenceMiddleware(prepared.metas, new Map(), undefined, {
      nativeTargets: prepared.nativeTargets,
      currentDocumentId: doc.id,
    }),
  ]);
  const snapshot = prepared.snapshot;

  const exportServices = new Container();
  if (access) exportServices.addImpl(DocEmbedProvider, () => access);
  if (fields) exportServices.addImpl(DocumentFieldOutputProvider, () => fields);
  const adapter = new MarkdownAdapter(
    job,
    provider,
    exportServices.provider(undefined, provider),
  );
  if (!snapshot) {
    return;
  }

  const markdownResult = await adapter.fromDocSnapshot({
    snapshot,
    assets: job.assetsManager,
  });

  let downloadBlob: Blob;
  const docTitle = snapshot.meta.title || "Untitled";
  let name: string;
  const contentBlob = new Blob([markdownResult.file], { type: "plain/text" });
  if (markdownResult.assetsIds.length > 0) {
    if (!job.assets) {
      throw new VirgultumError(ErrorCode.ValueNotExists, "No assets found");
    }
    const zip = await createAssetsArchive(job.assets, markdownResult.assetsIds);

    await zip.file("index.md", contentBlob);

    downloadBlob = await zip.generate();
    name = `${docTitle}.zip`;
  } else {
    downloadBlob = contentBlob;
    name = `${docTitle}.md`;
  }
  await prepared.assertReadable();
  download(downloadBlob, name);
  return { diagnostics: adapter.exportDiagnostics };
}

/**
 * Imports Markdown content into a specific block within a doc.
 * @param options Object containing import options
 * @param options.doc The target doc
 * @param options.markdown The Markdown content to import
 * @param options.blockId The ID of the block where the content will be imported
 * @returns The fidelity diagnostics produced by this block import
 */
async function importMarkdownToBlock({
  doc,
  markdown,
  blockId,
  extensions,
  access,
  replaceExistingTargets,
  beforeInsert,
  operation,
}: ImportMarkdownToBlockOptions): Promise<{
  diagnostics: MarkdownImportDiagnostics;
}> {
  const provider = getProvider(extensions);
  using job = doc.getTransformer([
    defaultImageProxyMiddleware,
    docLinkBaseURLMiddleware(doc.workspace.id),
    documentReferenceMiddleware([]),
  ]);
  const adapter = new MarkdownAdapter(job, provider);
  const snapshot = await adapter.toSliceSnapshotWithReferences(
    {
      file: markdown,
      assets: job.assetsManager,
      workspaceId: doc.workspace.id,
      pageId: doc.id,
    },
    doc,
    { access, replaceExistingTargets },
  );

  if (!snapshot) {
    throw new VirgultumError(
      VirgultumError.ErrorCode.ValueNotExists,
      "import markdown failed, expected to get a snapshot",
    );
  }

  const blocks = snapshot.content.flatMap((x) => x.children);

  let started = false;
  const imported = await job.snapshotToSlice(
    { ...snapshot, content: blocks },
    doc,
    blockId,
    undefined,
    {
      write: (write) => {
        const insert = () => {
          adapter.assertImportReferencesCurrent();
          if (
            doc.readonly ||
            !doc.root ||
            !doc.workspace.meta.getDocMeta(doc.id)
          )
            throw new Error("Markdown import destination unavailable");
          // Store materialization observes the end of each normal mutation's
          // Yjs transaction. An outer transaction hides a newly created parent
          // from hasBlock/addBlock and Store.transact can swallow failures.
          if (!started) {
            beforeInsert?.();
            started = true;
          }
          if (!doc.hasBlock(blockId))
            throw new Error("Markdown import destination block missing");
          write();
        };
        if (operation) operation.write(insert);
        else insert();
      },
    },
  );
  if (!imported) throw new Error("Markdown block import failed");

  return { diagnostics: adapter.importDiagnostics };
}

/**
 * Imports Markdown content into a new doc within a collection.
 * @param options Object containing import options
 * @param options.collection The target doc collection
 * @param options.schema The schema of the target doc collection
 * @param options.markdown The Markdown content to import
 * @param options.fileName Optional filename for the imported doc
 * @returns The created document ID, when available, and this import's fidelity diagnostics
 */
async function importMarkdownToDoc({
  collection,
  schema,
  markdown,
  fileName,
  extensions,
  access,
}: ImportMarkdownToDocOptions): Promise<MarkdownDocumentImportResult> {
  const { content, meta } = parseFrontmatter(markdown);
  const preferredTitle = meta.title ?? fileName;
  const id = collection.idGenerator();
  if (collection.getDoc(id))
    throw new Error("Markdown import document ID collision");
  const references = new Map<string, Set<string>>([[id, new Set()]]);
  const referenceMetas = [
    ...(await authorizedMarkdownReferenceMetas(collection, access)),
    { id, title: preferredTitle ?? "Untitled" },
  ];
  const provider = getProvider(extensions);
  const job = new Transformer({
    schema,
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => collection.createDoc(id).getStore({ id }),
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
    middlewares: [
      defaultImageProxyMiddleware,
      fileNameMiddleware(preferredTitle),
      consumeMatchingMarkdownTitle(preferredTitle, references.get(id)),
      docLinkBaseURLMiddleware(collection.id),
      importedDocumentIdMiddleware(id),
      documentReferenceMiddleware(referenceMetas, new Map(), undefined, {
        currentDocumentId: id,
      }),
    ],
  });
  const mdAdapter = new MarkdownAdapter(job, provider);
  const snapshot = await mdAdapter.toDocSnapshot({
    file: content,
    assets: job.assetsManager,
  });
  snapshot.meta.id = id;
  const assertReadable = await prepareImportedReferences(
    collection,
    [{ snapshot, job, mdAdapter }],
    [{ id, title: preferredTitle ?? "Untitled" }],
    referenceMetas,
    access,
  );
  collectReferencedBlocks(snapshot.blocks, references);
  // Keep the set captured by title consumption; document creation still belongs
  // to Transformer and happens only after native references are finalized.
  await assertReadable();
  if (collection.getDoc(id))
    throw new Error("Markdown import document ID collision");
  try {
    const page = await job.snapshotToDoc(snapshot);
    if (!page?.root)
      throw new Error("Markdown import document creation failed");
    await assertReadable();
    applyMetaPatch(collection, page.id, { title: preferredTitle, ...meta });
    return { docId: page.id, diagnostics: mdAdapter.importDiagnostics };
  } catch (error) {
    collection.removeDoc(id);
    throw error;
  }
}

/**
 * Imports a zip file containing Markdown files and assets into a collection.
 * @param options Object containing import options
 * @param options.collection The target doc collection
 * @param options.schema The schema of the target doc collection
 * @param options.imported The zip file as a Blob
 * @returns The created document IDs and aggregate fidelity diagnostics for the archive
 */
async function importMarkdownZip({
  collection,
  schema,
  imported,
  extensions,
  access,
}: ImportMarkdownZipOptions): Promise<MarkdownZipImportResult> {
  const provider = getProvider(extensions);
  const unzip = new Unzip();
  await unzip.load(imported);

  const docIds: string[] = [];
  const diagnostics = emptyMarkdownImportDiagnostics();
  const pendingAssets: AssetMap = new Map();
  const pendingPathBlobIdMap: PathBlobIdMap = new Map();
  const markdownBlobs: ImportedFileEntry[] = [];
  const archiveEntries: Array<{ path: string; blob: Blob }> = [];
  const normalizedPaths = new Set<string>();

  // Validate the complete source inventory before allocating document IDs or
  // preparing assets. Otherwise normalization could overwrite an earlier path.
  for await (const { path, content: blob } of unzip) {
    if (path.includes("__MACOSX") || path.includes(".DS_Store")) {
      continue;
    }
    const normalizedPath = normalizeMarkdownSourcePath(path);
    if (!normalizedPath) {
      throw new VirgultumError(
        ErrorCode.ParsingError,
        "Markdown archive contains an invalid source path",
      );
    }
    if (normalizedPaths.has(normalizedPath)) {
      throw new VirgultumError(
        ErrorCode.ParsingError,
        "Markdown archive contains colliding source paths",
      );
    }
    normalizedPaths.add(normalizedPath);
    if (path.endsWith("/") || path.endsWith("\\")) continue;
    archiveEntries.push({ path: normalizedPath, blob });
  }

  for (const { path, blob } of archiveEntries) {
    const fileName = path.split("/").pop() ?? "";
    if (fileName.endsWith(".md")) {
      markdownBlobs.push({
        filename: fileName,
        contentBlob: blob,
        fullPath: path,
      });
    } else {
      const ext = path.split(".").at(-1) ?? "";
      const mime = extMimeMap.get(ext) ?? "";
      const key = await sha(await blob.arrayBuffer());
      pendingPathBlobIdMap.set(path, key);
      pendingAssets.set(key, new File([blob], fileName, { type: mime }));
    }
  }

  const planned = await Promise.all(
    markdownBlobs
      .sort((left, right) => left.fullPath.localeCompare(right.fullPath))
      .map(async (markdownFile) => {
        const { filename, contentBlob, fullPath } = markdownFile;
        const fileNameWithoutExt = filename.replace(/\.[^/.]+$/, "");
        const markdown = await contentBlob.text();
        const { content, meta } = parseFrontmatter(markdown);
        const preferredTitle = meta.title ?? fileNameWithoutExt;
        return {
          content,
          fullPath,
          id: collection.idGenerator(),
          meta,
          preferredTitle,
        };
      }),
  );
  const referenceMetas = [
    ...(await authorizedMarkdownReferenceMetas(collection, access)),
    ...planned.map(({ id, preferredTitle }) => ({ id, title: preferredTitle })),
  ];
  if (
    new Set(planned.map(({ id }) => id)).size !== planned.length ||
    planned.some(({ id }) => collection.getDoc(id))
  )
    throw new Error("Markdown import document ID collision");
  const paths = new Map(planned.map(({ fullPath, id }) => [fullPath, id]));
  const references = new Map(planned.map(({ id }) => [id, new Set<string>()]));
  const attempted: string[] = [];
  try {
    const prepared = [];
    for (const plan of planned) {
      const { content, fullPath, id, preferredTitle } = plan;
      const job = new Transformer({
        schema,
        blobCRUD: collection.blobSync,
        docCRUD: {
          create: (id: string) => collection.createDoc(id).getStore({ id }),
          get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
          delete: (id: string) => collection.removeDoc(id),
        },
        middlewares: [
          defaultImageProxyMiddleware,
          fileNameMiddleware(preferredTitle),
          consumeMatchingMarkdownTitle(preferredTitle, references.get(id)),
          docLinkBaseURLMiddleware(collection.id),
          filePathMiddleware(fullPath),
          importedDocumentIdMiddleware(id),
          documentReferenceMiddleware(referenceMetas, paths, fullPath, {
            currentDocumentId: id,
          }),
        ],
      });
      const assets = job.assets;
      const pathBlobIdMap = job.assetsManager.getPathBlobIdMap();
      // Iterate over all assets to be imported
      for (const [assetPath, key] of pendingPathBlobIdMap.entries()) {
        // Get the relative path of the asset to the markdown file
        // Store the path to blobId map
        pathBlobIdMap.set(assetPath, key);
        // Store the asset to assets, the key is the blobId, the value is the file object
        // In block adapter, it will use the blobId to get the file object
        if (pendingAssets.get(key)) {
          assets.set(key, pendingAssets.get(key)!);
        }
      }

      const mdAdapter = new MarkdownAdapter(job, provider);
      const snapshot = await mdAdapter.toDocSnapshot({
        file: content,
        assets: job.assetsManager,
      });
      snapshot.meta.id = id;
      prepared.push({ plan, job, mdAdapter, snapshot });
    }

    // Convert and reserve every native block before materializing any document.
    // Rebinding the retained inline AST arrays preserves forward-reference IDs
    // and leaves archive assets on their existing single import lifecycle.
    const assertReadable = await prepareImportedReferences(
      collection,
      prepared,
      planned.map(({ id, preferredTitle }) => ({ id, title: preferredTitle })),
      referenceMetas,
      access,
    );
    for (const { snapshot } of prepared) {
      collectReferencedBlocks(snapshot.blocks, references);
    }
    for (const { plan, job, mdAdapter, snapshot } of prepared) {
      const { id, meta, fullPath, preferredTitle } = plan;
      await assertReadable();
      if (collection.getDoc(id))
        throw new Error("Markdown import document ID collision");
      attempted.push(id);
      const doc = await job.snapshotToDoc(snapshot);
      addDiagnostics(diagnostics, mdAdapter.importDiagnostics);
      if (doc?.root) {
        await assertReadable();
        applyMetaPatch(collection, doc.id, { title: preferredTitle, ...meta });
        docIds.push(doc.id);
      } else {
        throw new VirgultumError(
          ErrorCode.ValueNotExists,
          `Markdown import failed for ${fullPath}`,
        );
      }
    }
  } catch (error) {
    for (const id of attempted) collection.removeDoc(id);
    throw error;
  }
  return { docIds, diagnostics };
}

export const MarkdownTransformer = {
  exportDoc,
  importMarkdownToBlock,
  importMarkdownToDoc,
  importMarkdownZip,
};
