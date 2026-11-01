import type {
  BlockSnapshot,
  DocSnapshot,
  DocMeta,
  TransformerMiddleware,
  Workspace,
  Store,
  SliceSnapshot,
  AssetsManager,
} from "@virgultum/store";
import { nanoid } from "@virgultum/store";
import { sha } from "@virgultum/global/utils";
import {
  awaitDocEmbedReference,
  type DocEmbedProvider,
} from "../../services/doc-embed-service";
import { validMarkdownAnchor } from "../markdown/remark-plugins/remark-wikilink";

export const DOCUMENT_REFERENCE_TITLE_PREFIX = "documentReferenceTitle:";
export const DOCUMENT_REFERENCE_PATH_PREFIX = "documentReferencePath:";
export const DOCUMENT_REFERENCE_EXPORT_PATH_PREFIX =
  "documentReferenceExportPath:";
export const DOCUMENT_REFERENCE_SOURCE_PATH = "documentReferenceSourcePath";
export const DOCUMENT_REFERENCE_TARGETS_PREFIX = "documentReferenceTargets:";
export const DOCUMENT_REFERENCE_SELECTOR_PREFIX = "documentReferenceSelector:";
export const DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX =
  "documentReferenceNativeTarget:";
export const DOCUMENT_REFERENCE_CURRENT_DOCUMENT =
  "documentReferenceCurrentDocument";
export const DOCUMENT_REFERENCE_IMPORT_PREPARED =
  "documentReferenceImportPrepared";

/** Qualification cannot share an operation-local title/selector key with a local ID. */
export const documentReferenceKey = (pageId: string, workspaceId?: string) =>
  workspaceId === undefined ? pageId : JSON.stringify([workspaceId, pageId]);
export const DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX =
  "qualifiedDocumentReferenceTitle:";
export function configuredDocumentReferenceTitle(
  configs: Map<string, string>,
  pageId: string,
  workspaceId?: string,
) {
  if (workspaceId === undefined)
    return (
      configs.get(DOCUMENT_REFERENCE_TITLE_PREFIX + pageId) ??
      configs.get("title:" + pageId)
    );
  return configs.get(
    DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX +
      documentReferenceKey(pageId, workspaceId),
  );
}

/** Whether a parsed link can use the native document-reference resolver. */
export function needsMarkdownReferenceInventory(
  destination: string,
  configs: ReadonlyMap<string, string>,
) {
  if (destination.startsWith("myoxus-wikilink:")) return true;
  if (
    !destination.includes("?") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(destination) &&
    (destination.split(/[?#]/, 1)[0].toLowerCase().endsWith(".md") ||
      destination.startsWith("#"))
  )
    return true;
  const baseUrl = configs.get("docLinkBaseUrl");
  if (!baseUrl) return false;
  try {
    const base = new URL(baseUrl);
    const target = new URL(destination);
    const prefix = base.pathname.replace(/\/+$/, "") + "/";
    const suffix = target.pathname.startsWith(prefix)
      ? target.pathname.slice(prefix.length)
      : undefined;
    return (
      target.origin === base.origin &&
      !target.username &&
      !target.password &&
      !!suffix &&
      !suffix.includes("/")
    );
  } catch {
    return false;
  }
}

/** Load the authorized inventory only when the parsed clipboard needs it. */
export async function prepareDocumentReferenceImport(
  referenceStore: Store,
  configs: Map<string, string>,
  codec: {
    /** Parse once, then request metadata before traversing native references. */
    prepare: (
      loadReferences: () => Promise<void>,
    ) => Promise<SliceSnapshot | null>;
    referencedDocumentIds: ReadonlySet<string>;
    resolve: () => void;
  },
  access: DocEmbedProvider | undefined,
  options?: {
    replaceExistingTargets?: boolean;
    includeIncomingTargets?: boolean;
  },
) {
  configs.set(DOCUMENT_REFERENCE_CURRENT_DOCUMENT, referenceStore.id);
  let metas: Array<Pick<DocMeta, "id" | "title">> | undefined;
  const snapshot = await codec.prepare(async () => {
    metas = await authorizedMarkdownReferenceMetas(
      referenceStore.workspace,
      access,
    );
    configureMarkdownReferenceMetas(configs, metas);
  });
  if (!snapshot) return null;
  // Plain/rich text, external links and local footnotes have no workspace
  // reference dependency. Do not gate their local insertion on unrelated ACLs.
  if (!metas) {
    configs.set(DOCUMENT_REFERENCE_IMPORT_PREPARED, "true");
    return { snapshot, assertCurrent: () => {} };
  }
  const signal = AbortSignal.timeout(30_000);
  const captured = await captureMarkdownReferenceSnapshots(
    referenceStore.workspace,
    metas,
    codec.referencedDocumentIds,
    access,
    signal,
  );
  const titles = new Map(captured.metas.map(({ id, title }) => [id, title]));
  const targets = new Map(
    [...codec.referencedDocumentIds]
      .filter((id) => titles.has(id))
      .map((id) => [
        id,
        captured.snapshots.has(id) &&
        !(options?.replaceExistingTargets && id === referenceStore.id)
          ? markdownNativeTargets(captured.snapshots.get(id)!.blocks, titles)
          : [],
      ]),
  );
  configureMarkdownReferenceMetas(configs, captured.metas);
  // Incoming anchors share the destination's inventory; duplicates stay ambiguous.
  const incomingRoot: BlockSnapshot = {
    type: "block",
    id: nanoid(),
    flavour: "myoxus:note",
    props: {},
    children: options?.includeIncomingTargets === false ? [] : snapshot.content,
  };
  await finalizeMarkdownNativeReferences(
    [
      {
        documentId: referenceStore.id,
        root: incomingRoot,
        configs,
        resolve: codec.resolve,
      },
    ],
    titles,
    targets,
    signal,
    true,
  );
  // The legacy middleware must not reinterpret diagnosed ordinary links.
  configs.set(DOCUMENT_REFERENCE_IMPORT_PREPARED, "true");
  const required = [...codec.referencedDocumentIds].filter((id) =>
    titles.has(id),
  );
  const permissions = new Map(required.map((id) => [id, access?.readable(id)]));
  for (const id of required) {
    signal.throwIfAborted();
    if (
      !referenceStore.workspace.meta.getDocMeta(id) ||
      !(await access?.canRead(id))
    )
      throw new Error("Markdown import reference access lost");
  }
  return {
    snapshot,
    assertCurrent: () => {
      signal.throwIfAborted();
      for (const id of required)
        if (
          !referenceStore.workspace.meta.getDocMeta(id) ||
          permissions.get(id)?.value !== true
        )
          throw new Error("Markdown import reference access lost");
    },
  };
}

export type MarkdownNativeTarget = {
  blockId: string;
  headingPath?: string[];
  sourceAnchor?: string;
  canExportAnchor: boolean;
};

// Snapshot/blob limits belong to the import and document owners. This walk is
// linear in the already-materialized tree; reject cycles/depth, not valid width.
function* markdownSnapshotBlocks(root: BlockSnapshot) {
  const seen = new Set<string>();
  const pending = [{ block: root, depth: 0 }];
  while (pending.length) {
    const { block, depth } = pending.pop()!;
    if (depth > 100 || seen.has(block.id))
      throw new Error("Markdown target snapshot exceeds tree limits");
    seen.add(block.id);
    yield block;
    for (let index = block.children.length - 1; index >= 0; index--)
      pending.push({ block: block.children[index], depth: depth + 1 });
  }
}

/** Qualify an export-only foreign body and materialize its typed assets in the
 * existing archive owner. Live native values and ordinary literals stay intact.
 */
export async function prepareQualifiedNativeExportSnapshot(
  snapshot: DocSnapshot,
  collection: Workspace,
  assets?: AssetsManager,
  access?: DocEmbedProvider,
  configs?: Map<string, string>,
) {
  const copy = structuredClone(snapshot);
  const qualify = (reference: Record<string, unknown>) => {
    if (reference.workspaceId === undefined)
      reference.workspaceId = collection.id;
  };
  const materialized = new Map<string, string>();
  const asset = async (owner: Record<string, unknown>, property: string) => {
    const id = owner[property];
    if (typeof id !== "string" || !id || /^(https?:|data:|blob:)/i.test(id))
      return;
    if (!assets) throw new Error("Embedded export assets unavailable");
    const workspaceId =
      owner.workspaceId === undefined ? collection.id : owner.workspaceId;
    if (typeof workspaceId !== "string")
      throw new Error("Embedded export asset scope invalid");
    const key = JSON.stringify([workspaceId, id]);
    let alias = materialized.get(key);
    if (!alias) {
      const borrowed =
        workspaceId !== collection.id
          ? access?.inWorkspace?.(workspaceId)
          : undefined;
      let blob: Blob | null | undefined;
      try {
        const source =
          workspaceId === collection.id ? collection : borrowed?.collection;
        if (!source) throw new Error("Embedded export asset scope unavailable");
        blob = await source.blobSync.get(id);
      } finally {
        borrowed?.dispose();
      }
      if (!blob) throw new Error("Embedded export asset missing");
      do {
        alias = "scoped-export-" + nanoid();
      } while (assets.getAssets().has(alias));
      assets
        .getAssets()
        .set(
          alias,
          blob instanceof File
            ? new File([blob], alias + "-" + blob.name, { type: blob.type })
            : blob,
        );
      materialized.set(key, alias);
    }
    owner[property] = alias;
  };
  for (const block of markdownSnapshotBlocks(copy.blocks)) {
    if (
      [
        "myoxus:embed-linked-doc",
        "myoxus:embed-synced-doc",
        "myoxus:surface-ref",
      ].includes(block.flavour) &&
      typeof block.props.pageId === "string"
    )
      qualify(block.props);
    if (
      ["myoxus:image", "myoxus:attachment", "myoxus:bookmark"].includes(
        block.flavour,
      )
    )
      await asset(block.props, "sourceId");
    if (["myoxus:code", "myoxus:annotation"].includes(block.flavour)) continue;
    type NativeText = {
      delta?: Array<{
        attributes?: {
          reference?: Record<string, unknown>;
          footnote?: { reference?: Record<string, unknown> };
        };
      }>;
    };
    const texts = [block.props.text as NativeText | undefined];
    if (block.flavour === "myoxus:table")
      for (const cell of Object.values(
        (block.props.cells ?? {}) as Record<string, { text?: NativeText }>,
      ))
        texts.push(cell.text);
    for (const text of texts)
      for (const part of text?.delta ?? []) {
        if (part.attributes?.reference) qualify(part.attributes.reference);
        const citation = part.attributes?.footnote?.reference;
        if (citation?.type === "doc") qualify(citation);
        else if (citation?.type === "attachment")
          await asset(citation, "blobId");
      }
  }
  if (access && configs) {
    const targets = new Map<string, { pageId: string; workspaceId: string }>();
    markdownDocumentReferences(copy.blocks, undefined, (pageId, workspaceId) =>
      targets.set(documentReferenceKey(pageId, workspaceId), {
        pageId,
        workspaceId,
      }),
    );
    for (const [key, { pageId, workspaceId }] of targets) {
      const resolved = await awaitDocEmbedReference(
        access,
        pageId,
        workspaceId,
      );
      const borrowed =
        resolved ??
        (!access.openReference ? access.inWorkspace?.(workspaceId) : undefined);
      if (!borrowed) continue;
      const targetId = resolved?.docId ?? pageId;
      try {
        const title = await borrowed.access.referenceTitle?.(targetId);
        if (title !== undefined)
          configs.set(DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX + key, title);
      } finally {
        borrowed.dispose();
      }
    }
  }
  return copy;
}

/** Recheck operation-local qualified metadata after asynchronous body/asset loads. */
export async function assertQualifiedNativeExportReadable(
  configs: Map<string, string>,
  access?: DocEmbedProvider,
) {
  for (const key of configs.keys()) {
    if (!key.startsWith(DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX)) continue;
    const [workspaceId, pageId] = JSON.parse(
      key.slice(DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX.length),
    ) as [string, string];
    const resolved = await awaitDocEmbedReference(access, pageId, workspaceId);
    const borrowed =
      resolved ??
      (!access?.openReference ? access?.inWorkspace?.(workspaceId) : undefined);
    try {
      if (
        !borrowed ||
        !(await borrowed.access.canRead(resolved?.docId ?? pageId))
      )
        throw new Error("Qualified export reference access lost");
    } finally {
      borrowed?.dispose();
    }
  }
}

/** A single page block selector; absent optional params are not extra geometry. */
export function markdownPreciseTargetBlockId(params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const values = params as Record<string, unknown>;
  const ids = values.blockIds;
  if (
    !Array.isArray(ids) ||
    ids.length !== 1 ||
    typeof ids[0] !== "string" ||
    !ids[0] ||
    (values.mode !== undefined && values.mode !== "page") ||
    Object.entries(values).some(
      ([key, value]) =>
        value !== undefined && key !== "mode" && key !== "blockIds",
    )
  )
    return;
  return ids[0];
}

/** Existing native text hosts, including table cells; literal content is inert. */
export function markdownDocumentReferences(
  root: BlockSnapshot,
  workspaceId?: string,
  qualified?: (
    pageId: string,
    workspaceId: string,
    blocks: Set<string>,
  ) => void,
) {
  const references = new Map<string, Set<string>>();
  for (const block of markdownSnapshotBlocks(root)) {
    if (
      block.flavour === "myoxus:code" ||
      block.flavour === "myoxus:annotation"
    )
      continue;
    if (
      ["myoxus:embed-linked-doc", "myoxus:embed-synced-doc"].includes(
        block.flavour,
      )
    ) {
      const id = block.props.pageId;
      if (typeof id === "string" && id) {
        const targetWorkspace = block.props.workspaceId;
        if (targetWorkspace !== undefined && targetWorkspace !== workspaceId) {
          if (typeof targetWorkspace === "string")
            qualified?.(id, targetWorkspace, new Set());
        } else {
          if (!references.has(id)) references.set(id, new Set());
          const containing =
            typeof targetWorkspace === "string" ? targetWorkspace : workspaceId;
          if (containing !== undefined) qualified?.(id, containing, new Set());
        }
      }
    }
    type SnapshotText = {
      delta?: Array<{
        attributes?: {
          reference?: {
            pageId?: unknown;
            workspaceId?: unknown;
            params?: unknown;
          };
          annotation?: unknown;
          code?: unknown;
          latex?: unknown;
          footnote?: {
            reference?: {
              type?: unknown;
              docId?: unknown;
              workspaceId?: unknown;
            };
          };
        };
      }>;
    };
    const texts = [block.props.text as SnapshotText | undefined];
    if (block.flavour === "myoxus:table")
      for (const cell of Object.values(
        (block.props.cells ?? {}) as Record<string, { text?: SnapshotText }>,
      ))
        texts.push(cell.text);
    for (const text of texts)
      for (const { attributes } of text?.delta ?? []) {
        if (attributes?.annotation || attributes?.code || attributes?.latex)
          continue;
        const citation = attributes?.footnote?.reference;
        const reference =
          attributes?.reference ??
          (citation?.type === "doc"
            ? {
                pageId: citation.docId,
                workspaceId: citation.workspaceId,
                params: undefined,
              }
            : undefined);
        if (typeof reference?.pageId !== "string" || !reference.pageId)
          continue;
        const foreign =
          reference.workspaceId !== undefined &&
          reference.workspaceId !== workspaceId;
        const targets = foreign
          ? new Set<string>()
          : (references.get(reference.pageId) ?? new Set<string>());
        // Keep every native block selection for title-consumption protection;
        // only the writer decides whether it is one portable Markdown target.
        const params = reference.params;
        if (params && typeof params === "object" && !Array.isArray(params)) {
          const ids = (params as Record<string, unknown>).blockIds;
          if (Array.isArray(ids))
            for (const id of ids)
              if (typeof id === "string" && id) targets.add(id);
        }
        if (foreign) {
          if (typeof reference.workspaceId === "string")
            qualified?.(reference.pageId, reference.workspaceId, targets);
        } else {
          references.set(reference.pageId, targets);
          const containing =
            typeof reference.workspaceId === "string"
              ? reference.workspaceId
              : workspaceId;
          if (containing !== undefined)
            qualified?.(reference.pageId, containing, targets);
        }
      }
  }
  return references;
}

/** Guard a title resolver's inventory or an export's concrete dependency IDs. */
export async function authorizedMarkdownReferenceMetas(
  collection: Workspace,
  access: DocEmbedProvider | undefined,
  documentIds?: ReadonlySet<string>,
) {
  if (!access) return [];
  return currentMarkdownReferenceMetas(
    collection,
    access,
    // A host title read already includes the read guard. Providers without that
    // projection still need explicit authorization before cached metadata use.
    (id) =>
      access.referenceTitle ? Promise.resolve(true) : access.canRead(id),
    documentIds,
  );
}

async function currentMarkdownReferenceMetas(
  collection: Workspace,
  access: DocEmbedProvider,
  include: (id: string) => Promise<boolean>,
  documentIds?: ReadonlySet<string>,
) {
  const ids = collection.meta.docMetas
    .filter(({ id }) => !documentIds || documentIds.has(id))
    .map(({ id }) => id);
  const allowed = new Set<string>();
  const hostTitles = new Map<string, string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (await include(id)) {
          if (access.referenceTitle) {
            const title = await access.referenceTitle(id);
            if (title === undefined) continue;
            hostTitles.set(id, title);
          }
          allowed.add(id);
        }
      }
    }),
  );
  // Read titles/deletions after the async guard, not from the earlier inventory.
  return collection.meta.docMetas
    .filter(({ id }) => allowed.has(id))
    .map(({ id, title }) => ({ id, title: hostTitles.get(id) ?? title }));
}

/** Load only parser-selected authorized targets through the normal host lifecycle. */
export async function captureMarkdownReferenceSnapshots(
  collection: Workspace,
  metas: Array<Pick<DocMeta, "id" | "title">>,
  ids: Iterable<string>,
  access: DocEmbedProvider | undefined,
  signal: AbortSignal,
) {
  const captured = new Map<string, DocSnapshot>();
  if (!access) return { snapshots: captured, metas: [] };
  const authorized = new Set(metas.map(({ id }) => id));
  const rejected = new Set<string>();
  for (const id of new Set(ids)) {
    signal.throwIfAborted();
    if (!authorized.has(id)) continue;
    if (!collection.meta.getDocMeta(id)) {
      rejected.add(id);
      continue;
    }
    await access.waitForLoaded(id, signal);
    signal.throwIfAborted();
    // The host owns fresh read checks around loading. Retain its live result
    // through snapshot capture instead of duplicating both network checks here.
    if (access.readable(id).value !== true)
      throw new Error("Markdown import reference access lost");
    if (!collection.meta.getDocMeta(id)) {
      rejected.add(id);
      continue;
    }
    const store = collection.getDoc(id)?.getStore({ id });
    if (!store?.root) continue;
    const snapshot = store.getTransformer([]).docToSnapshot(store);
    if (!snapshot)
      throw new Error("Markdown reference snapshot capture failed");
    captured.set(id, snapshot);
  }
  const currentMetas = await currentMarkdownReferenceMetas(
    collection,
    access,
    async (id) => authorized.has(id) && !rejected.has(id),
    authorized,
  );
  // A host title projection may observe revocation after successful body loading.
  // That is cancellation, not permission to import downgraded ordinary links.
  const currentIds = new Set(currentMetas.map(({ id }) => id));
  for (const id of captured.keys())
    if (!currentIds.has(id))
      throw new Error("Markdown import reference access lost");
  return {
    snapshots: captured,
    metas: currentMetas,
  };
}

/** Refresh operation-local metadata after async loading or permission changes. */
export function configureMarkdownReferenceMetas(
  configs: Map<string, unknown>,
  metas: Array<Pick<DocMeta, "id" | "title"> & { workspaceId?: string }>,
) {
  for (const key of configs.keys())
    if (
      key.startsWith(DOCUMENT_REFERENCE_TITLE_PREFIX) ||
      key.startsWith(DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX)
    )
      configs.delete(key);
  const authorized = new Set(
    metas.filter((meta) => meta.workspaceId === undefined).map(({ id }) => id),
  );
  for (const meta of metas)
    configs.set(
      (meta.workspaceId === undefined
        ? DOCUMENT_REFERENCE_TITLE_PREFIX
        : DOCUMENT_REFERENCE_QUALIFIED_TITLE_PREFIX) +
        documentReferenceKey(meta.id, meta.workspaceId),
      meta.title,
    );
  for (const [key, value] of configs) {
    if (
      key.startsWith(DOCUMENT_REFERENCE_PATH_PREFIX) &&
      !authorized.has(String(value))
    )
      configs.delete(key);
    if (
      key.startsWith(DOCUMENT_REFERENCE_EXPORT_PATH_PREFIX) &&
      !authorized.has(key.slice(DOCUMENT_REFERENCE_EXPORT_PATH_PREFIX.length))
    )
      configs.delete(key);
  }
}

/** Same Unicode whitespace/case contract as Rust's normalize_heading; no slugs. */
export const normalizeMarkdownHeading = (value: string) =>
  value
    .split(/\p{White_Space}+/u)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

/** Derive selectors from an already authorized, reachable snapshot, not source offsets. */
export function markdownNativeTargets(
  root: BlockSnapshot,
  authorizedTitles: ReadonlyMap<string, string>,
): MarkdownNativeTarget[] {
  const targets: MarkdownNativeTarget[] = [];
  const headings: Array<{ level: number; label?: string }> = [];
  for (const block of markdownSnapshotBlocks(root)) {
    const eligible = [
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:callout",
    ].includes(block.flavour);
    if (eligible) {
      const text = block.props.text as
        | {
            delta?: Array<{
              insert?: unknown;
              attributes?: Record<string, unknown>;
            }>;
          }
        | undefined;
      let label = "";
      let known = true;
      for (const part of text?.delta ?? []) {
        if (part.attributes?.annotation) continue;
        const reference = part.attributes?.reference as
          | { pageId?: unknown; workspaceId?: unknown; title?: unknown }
          | undefined;
        if (reference) {
          const title =
            typeof reference.pageId === "string" &&
            reference.workspaceId === undefined
              ? authorizedTitles.get(reference.pageId)
              : undefined;
          if (title === undefined) known = false;
          else
            label +=
              typeof reference.title === "string" && reference.title.trim()
                ? reference.title
                : title;
        } else if (part.attributes?.latex || typeof part.insert !== "string")
          known = false;
        else label += part.insert;
      }
      const level =
        block.flavour === "myoxus:paragraph" &&
        typeof block.props.type === "string" &&
        /^h[1-6]$/.test(block.props.type)
          ? Number(block.props.type.slice(1))
          : undefined;
      let headingPath: string[] | undefined;
      if (level !== undefined) {
        while (headings.at(-1) && headings.at(-1)!.level >= level)
          headings.pop();
        headings.push({ level, label: known ? label : undefined });
        const unknown = headings.findLastIndex(
          (heading) => heading.label === undefined,
        );
        const suffix = headings
          .slice(unknown + 1)
          .map((heading) => heading.label!);
        if (suffix.length) headingPath = suffix;
      }
      targets.push({
        blockId: block.id,
        headingPath,
        sourceAnchor: validMarkdownAnchor(block.props.markdownAnchor)
          ? block.props.markdownAnchor
          : undefined,
        canExportAnchor: !!text?.delta?.some(
          (part) =>
            (typeof part.insert === "string" && part.insert.trim()) ||
            (part.attributes && Object.keys(part.attributes).length),
        ),
      });
    } else targets.push({ blockId: block.id, canExportAnchor: false });
  }
  return targets;
}

/** Rebind retained ASTs until reference-bearing heading labels are stable.
 * Slices extend their destination inventory; new documents replace their own.
 * No source is reparsed and no model is written by this preparation step.
 */
export async function finalizeMarkdownNativeReferences(
  prepared: Array<{
    documentId: string;
    root: BlockSnapshot;
    configs: Map<string, unknown>;
    resolve: () => void;
  }>,
  authorizedTitles: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, readonly MarkdownNativeTarget[]> = new Map(),
  signal?: AbortSignal,
  extendExisting = false,
) {
  const seen = new Set<string>();
  let previous: string | undefined;
  let remaining = prepared.reduce(
    (count, { root }) =>
      count + markdownNativeTargets(root, authorizedTitles).length,
    2,
  );
  while (remaining-- > 0) {
    signal?.throwIfAborted();
    const targets = new Map(existing);
    for (const { documentId, root } of prepared)
      targets.set(documentId, [
        ...(extendExisting ? (existing.get(documentId) ?? []) : []),
        ...markdownNativeTargets(root, authorizedTitles),
      ]);
    const signature = await sha(
      new TextEncoder().encode(JSON.stringify([...targets])).buffer,
    );
    signal?.throwIfAborted();
    if (signature === previous) return;
    if (seen.has(signature)) break;
    seen.add(signature);
    previous = signature;
    for (const { documentId, configs, resolve } of prepared) {
      configureMarkdownNativeTargets(configs, targets, documentId);
      resolve();
    }
  }
  throw new Error(
    "Markdown reference headings cannot be resolved consistently",
  );
}

const selectorKey = (pageId: string, fragment: string) =>
  fragment.startsWith("^")
    ? JSON.stringify([pageId, "block", fragment.slice(1)])
    : JSON.stringify([
        pageId,
        "heading",
        ...fragment.split("#").map(normalizeMarkdownHeading),
      ]);

/** Authorization precedes target lookup, including operation-local imports. */
export function configuredMarkdownTarget(
  configs: Map<string, string>,
  pageId: string,
  fragment: string,
):
  | { blockId: string }
  | { error: "missing" | "ambiguous" | "invalid" | "unsupported" } {
  if (typeof configs.get(DOCUMENT_REFERENCE_TITLE_PREFIX + pageId) !== "string")
    return { error: "missing" };
  if (!configs.has(DOCUMENT_REFERENCE_TARGETS_PREFIX + pageId))
    return { error: "unsupported" };
  if (
    fragment.startsWith("^")
      ? !validMarkdownAnchor(fragment.slice(1))
      : fragment
          .split("#")
          .map(normalizeMarkdownHeading)
          .some((value) => !value)
  )
    return { error: "invalid" };
  const id = configs.get(
    DOCUMENT_REFERENCE_SELECTOR_PREFIX + selectorKey(pageId, fragment),
  );
  return id === undefined
    ? { error: "missing" }
    : id
      ? { blockId: id }
      : { error: "ambiguous" };
}

/** Derive a portable selector from the retained native ID and current tree. */
export function portableMarkdownTargetFragment(
  configs: Map<string, string>,
  pageId: string,
  blockId: string,
): string | undefined {
  if (typeof configs.get(DOCUMENT_REFERENCE_TITLE_PREFIX + pageId) !== "string")
    return;
  const encoded = configs.get(
    DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX + JSON.stringify([pageId, blockId]),
  );
  if (!encoded) return;
  const target = JSON.parse(encoded) as MarkdownNativeTarget;
  const fragments = [
    ...(target.sourceAnchor && target.canExportAnchor
      ? ["^" + target.sourceAnchor]
      : []),
    ...(target.headingPath ? [target.headingPath.join("#")] : []),
  ];
  for (const fragment of fragments) {
    const resolved = configuredMarkdownTarget(configs, pageId, fragment);
    if ("blockId" in resolved && resolved.blockId === blockId) return fragment;
  }
  return;
}

/** Add deterministic anchors to export copies only; never mutate live models. */
export async function prepareMarkdownExportSnapshots(
  captured: ReadonlyMap<string, DocSnapshot>,
  authorizedTitles: ReadonlyMap<string, string>,
  exportedIds: ReadonlySet<string> = new Set(captured.keys()),
) {
  for (const id of exportedIds) {
    if (!authorizedTitles.has(id) || !captured.has(id))
      throw new Error("Markdown export snapshot missing or unauthorized");
  }
  const nativeTargets = new Map<string, MarkdownNativeTarget[]>();
  const snapshots = new Map<string, DocSnapshot>();
  for (const [id, snapshot] of captured) {
    if (!authorizedTitles.has(id))
      throw new Error("Unauthorized Markdown target snapshot");
    nativeTargets.set(
      id,
      markdownNativeTargets(snapshot.blocks, authorizedTitles),
    );
    if (exportedIds.has(id)) snapshots.set(id, structuredClone(snapshot));
  }
  const referenced = new Map<string, Set<string>>();
  const blocksByDocument = new Map<string, Map<string, BlockSnapshot>>();
  for (const [id, snapshot] of snapshots) {
    const blocks = new Map(
      [...markdownSnapshotBlocks(snapshot.blocks)].map((block) => [
        block.id,
        block,
      ]),
    );
    for (const [targetId, ids] of markdownDocumentReferences(snapshot.blocks)) {
      if (!snapshots.has(targetId) || !ids.size) continue;
      const targets = referenced.get(targetId) ?? new Set<string>();
      for (const blockId of ids) targets.add(blockId);
      referenced.set(targetId, targets);
    }
    blocksByDocument.set(id, blocks);
  }
  for (const [id, references] of referenced) {
    const targets = nativeTargets.get(id)!;
    const byId = new Map(targets.map((target) => [target.blockId, target]));
    const occupied = new Set(
      targets.flatMap((target) =>
        target.sourceAnchor ? [target.sourceAnchor] : [],
      ),
    );
    for (const blockId of [...references].sort()) {
      const target = byId.get(blockId);
      if (!target || target.sourceAnchor || !target.canExportAnchor) continue;
      // Reuse the existing SHA-256 utility; encode the same hex provenance as Rust.
      const digest = await sha(new TextEncoder().encode(blockId).buffer);
      const hex = Array.from(
        atob(digest.replace(/-/g, "+").replace(/_/g, "/")),
        (value) => value.charCodeAt(0).toString(16).padStart(2, "0"),
      ).join("");
      const base = "myoxus-" + hex;
      let anchor = base;
      let suffix = 1;
      while (occupied.has(anchor)) anchor = base + "-" + suffix++;
      occupied.add(anchor);
      blocksByDocument.get(id)!.get(blockId)!.props.markdownAnchor = anchor;
    }
    nativeTargets.set(
      id,
      markdownNativeTargets(snapshots.get(id)!.blocks, authorizedTitles),
    );
  }
  return { snapshots, nativeTargets };
}

/** Guarded current target indexes for document downloads and selection copies. */
export async function prepareMarkdownDocumentExport(
  doc: Store,
  access: DocEmbedProvider | undefined,
  /** A frozen selection narrows dependencies; their snapshots stay current. */
  referencesRoot?: BlockSnapshot,
) {
  if (!access) throw new Error("Markdown export access unavailable");
  const signal = AbortSignal.timeout(30_000);
  // Exports already carry concrete reference IDs. Authorize the source before
  // reading its body, then only the dependencies found in that guarded snapshot.
  const sourceMetas = await authorizedMarkdownReferenceMetas(
    doc.workspace,
    access,
    new Set([doc.id]),
  );
  if (!sourceMetas.some((meta) => meta.id === doc.id))
    throw new Error("Markdown export access denied");
  const source = await captureMarkdownReferenceSnapshots(
    doc.workspace,
    sourceMetas,
    [doc.id],
    access,
    signal,
  );
  const snapshot = source.snapshots.get(doc.id);
  if (!snapshot) throw new Error("Markdown export source missing");
  const foreign = new Map<
    string,
    { pageId: string; workspaceId: string; blockIds: Set<string> }
  >();
  const references = markdownDocumentReferences(
    referencesRoot ?? snapshot.blocks,
    doc.workspace.id,
    (pageId, workspaceId, blockIds) => {
      const key = documentReferenceKey(pageId, workspaceId);
      const previous = foreign.get(key);
      foreign.set(key, {
        pageId,
        workspaceId,
        blockIds: new Set([...(previous?.blockIds ?? []), ...blockIds]),
      });
    },
  );
  const targetMetas = await authorizedMarkdownReferenceMetas(
    doc.workspace,
    access,
    new Set([...references.keys()].filter((id) => id !== doc.id)),
  );
  const metas = [...source.metas, ...targetMetas];
  const targetIds = [...references]
    .filter(([id, ids]) => id !== doc.id && ids.size)
    .map(([id]) => id);
  const targets = targetIds.length
    ? await captureMarkdownReferenceSnapshots(
        doc.workspace,
        metas,
        targetIds,
        access,
        signal,
      )
    : { snapshots: new Map<string, DocSnapshot>(), metas };
  const titles = new Map(targets.metas.map(({ id, title }) => [id, title]));
  const captured = new Map(
    [...source.snapshots, ...targets.snapshots].filter(([id]) =>
      titles.has(id),
    ),
  );
  const prepared = await prepareMarkdownExportSnapshots(
    captured,
    titles,
    new Set([doc.id]),
  );
  for (const [id, ids] of references)
    if (ids.size && titles.has(id) && !prepared.nativeTargets.has(id))
      prepared.nativeTargets.set(id, []);
  const requiredIds = new Set([
    doc.id,
    ...[...references.keys()].filter((id) => titles.has(id)),
  ]);
  const assertReadable = async () => {
    for (const id of requiredIds) {
      signal.throwIfAborted();
      if (!doc.workspace.meta.getDocMeta(id) || !(await access.canRead(id)))
        throw new Error("Markdown export access lost");
    }
  };
  const qualifiedMetas: Array<
    Pick<DocMeta, "id" | "title"> & { workspaceId?: string }
  > = [];
  const qualifiedChecks: Array<{ pageId: string; workspaceId: string }> = [];
  for (const { pageId, workspaceId, blockIds } of foreign.values()) {
    const resolved = await awaitDocEmbedReference(
      access,
      pageId,
      workspaceId,
      signal,
    );
    const borrowed =
      resolved ??
      (!access.openReference ? access.inWorkspace?.(workspaceId) : undefined);
    if (!borrowed) continue;
    const targetId = resolved?.docId ?? pageId;
    try {
      const title = await borrowed.access.referenceTitle?.(targetId);
      if (title === undefined) continue;
      if (blockIds.size) {
        await borrowed.access.waitForLoaded(targetId, signal);
        if (borrowed.access.readable(targetId).value !== true)
          throw new Error("Markdown export access lost");
        const store = borrowed.collection
          .getDoc(targetId)
          ?.getStore({ readonly: true });
        const targetSnapshot =
          store?.root && store.getTransformer([]).docToSnapshot(store);
        if (!targetSnapshot)
          throw new Error("Markdown export target snapshot missing");
        const reachable = new Set(
          [...markdownSnapshotBlocks(targetSnapshot.blocks)].map(
            (block) => block.id,
          ),
        );
        if ([...blockIds].some((id) => !reachable.has(id))) continue;
        // Foreign precise links stay native URLs, never local export paths.
      }
      qualifiedMetas.push({ id: pageId, title, workspaceId });
      // An unqualified source alias still uses its original local formatter key.
      // The title comes from the guarded canonical target, never cached source Yjs.
      if (
        workspaceId === doc.workspace.id &&
        references.has(pageId) &&
        !titles.has(pageId)
      )
        qualifiedMetas.push({ id: pageId, title });
      qualifiedChecks.push({ pageId, workspaceId });
    } finally {
      borrowed.dispose();
    }
  }
  const assertQualifiedReadable = async () => {
    await assertReadable();
    for (const { pageId, workspaceId } of qualifiedChecks) {
      const resolved = await awaitDocEmbedReference(
        access,
        pageId,
        workspaceId,
        signal,
      );
      const borrowed =
        resolved ??
        (!access.openReference ? access.inWorkspace?.(workspaceId) : undefined);
      try {
        if (
          !borrowed ||
          !(await borrowed.access.canRead(resolved?.docId ?? pageId))
        )
          throw new Error("Markdown export access lost");
      } finally {
        borrowed?.dispose();
      }
    }
  };
  const exportMetas: Array<
    Pick<DocMeta, "id" | "title"> & { workspaceId?: string }
  > = [...targets.metas, ...qualifiedMetas];
  return {
    snapshot: prepared.snapshots.get(doc.id)!,
    nativeTargets: prepared.nativeTargets,
    metas: exportMetas,
    assertReadable: assertQualifiedReadable,
  };
}

/** Replace an operation's target index without retaining stale or ambiguous entries. */
export function configureMarkdownNativeTargets(
  configs: Map<string, unknown>,
  nativeTargets: ReadonlyMap<string, readonly MarkdownNativeTarget[]>,
  currentDocumentId?: string,
) {
  for (const key of configs.keys()) {
    if (
      key.startsWith(DOCUMENT_REFERENCE_TARGETS_PREFIX) ||
      key.startsWith(DOCUMENT_REFERENCE_SELECTOR_PREFIX) ||
      key.startsWith(DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX)
    )
      configs.delete(key);
  }
  for (const [id, targets] of nativeTargets) {
    if (!configs.has(DOCUMENT_REFERENCE_TITLE_PREFIX + id)) continue;
    configs.set(DOCUMENT_REFERENCE_TARGETS_PREFIX + id, "true");
    for (const target of targets) {
      configs.set(
        DOCUMENT_REFERENCE_NATIVE_TARGET_PREFIX +
          JSON.stringify([id, target.blockId]),
        JSON.stringify(target),
      );
      const keys = [
        ...(target.sourceAnchor
          ? [selectorKey(id, "^" + target.sourceAnchor)]
          : []),
        ...(target.headingPath?.map((_label, index) =>
          JSON.stringify([
            id,
            "heading",
            ...target.headingPath!.slice(index).map(normalizeMarkdownHeading),
          ]),
        ) ?? []),
      ];
      for (const selector of keys) {
        const key = DOCUMENT_REFERENCE_SELECTOR_PREFIX + selector;
        const previous = configs.get(key);
        configs.set(
          key,
          previous !== undefined && previous !== target.blockId
            ? ""
            : target.blockId,
        );
      }
    }
  }
  if (currentDocumentId !== undefined)
    configs.set(DOCUMENT_REFERENCE_CURRENT_DOCUMENT, currentDocumentId);
}

/** Supplies only caller-authorized metadata; document bodies are never loaded. */
export const documentReferenceMiddleware =
  (
    metas: Array<Pick<DocMeta, "id" | "title"> & { workspaceId?: string }>,
    paths: ReadonlyMap<string, string> = new Map(),
    sourcePath?: string,
    options?: {
      nativeTargets?: ReadonlyMap<string, readonly MarkdownNativeTarget[]>;
      currentDocumentId?: string;
    },
  ): TransformerMiddleware =>
  ({ adapterConfigs }) => {
    configureMarkdownReferenceMetas(adapterConfigs, metas);
    configureMarkdownNativeTargets(
      adapterConfigs,
      options?.nativeTargets ?? new Map(),
      options?.currentDocumentId,
    );
    for (const [path, id] of paths) {
      if (!adapterConfigs.has(DOCUMENT_REFERENCE_TITLE_PREFIX + id)) continue;
      adapterConfigs.set(DOCUMENT_REFERENCE_PATH_PREFIX + path, id);
      adapterConfigs.set(DOCUMENT_REFERENCE_EXPORT_PATH_PREFIX + id, path);
    }
    if (sourcePath)
      adapterConfigs.set(DOCUMENT_REFERENCE_SOURCE_PATH, sourcePath);
  };

/** Applies an identity reserved during batch preflight to the imported page. */
export const importedDocumentIdMiddleware =
  (documentId: string): TransformerMiddleware =>
  ({ slots }) => {
    const subscription = slots.beforeImport.subscribe((payload) => {
      if (payload.type === "page") payload.snapshot.meta.id = documentId;
    });
    return () => subscription.unsubscribe();
  };
