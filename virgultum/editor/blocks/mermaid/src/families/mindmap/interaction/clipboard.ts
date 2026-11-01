// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  copyMindmapSubtrees,
  readCopiedMindmapSubtree,
  type MindmapCopiedSubtree,
} from "../../../engine/mindmap/index.js";
import {
  createMermaidVisualFamilyData,
  parseMermaidVisualFamilyData,
} from "../../runtime/gfx-family-data.js";
import { readMindmapProjectionData } from "../gfx-data.js";
import type { MindmapReactHostProps } from "../react-host-contract.js";
import type { MindmapProjectionOptions } from "../projection/layout.js";

export const MINDMAP_SUBTREE_CLIPBOARD_MIME = "myoxus/mermaid-mindmap-subtrees";

/** Remap only occurrence-bound projection roles. Syntax IDs, labels, resources
 * and design values are not document references and must retain their bytes. */
export function copiedMindmapProjection(
  base: MindmapProjectionOptions,
  copied: MindmapProjectionOptions,
  keys: ReadonlyMap<string, string>,
  rootParent: boolean,
): MindmapProjectionOptions {
  const map = <T>(entries: ReadonlyMap<string, T> | undefined) =>
    [...(entries ?? [])].flatMap(([key, value]) =>
      keys.has(key) ? [[keys.get(key)!, value] as const] : [],
    );
  return {
    ...base,
    rootSides: new Map([
      ...(base.rootSides ?? []),
      ...(rootParent ? map(copied.rootSides) : []),
    ]),
    collapsed: new Set([
      ...(base.collapsed ?? []),
      ...[...(copied.collapsed ?? [])].flatMap((key) =>
        keys.has(key) ? [keys.get(key)!] : [],
      ),
    ]),
    nodeAppearance: new Map([
      ...(base.nodeAppearance ?? []),
      ...map(copied.nodeAppearance),
    ]),
    branchAppearance: new Map([
      ...(base.branchAppearance ?? []),
      ...map(copied.branchAppearance),
    ]),
  };
}

function readClipboard(encoded: string) {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("copies" in value) ||
    !Array.isArray(value.copies) ||
    !value.copies.length ||
    !("projection" in value)
  )
    return null;
  const copies: MindmapCopiedSubtree[] = [];
  const keys = new Set<string>();
  for (const entry of value.copies) {
    const model = readCopiedMindmapSubtree(entry);
    if (!model) return null;
    const identities = model.sourceDocument.records
      .filter((record) => record.kind !== "header")
      .map((record) => [record.range.start, record.sourceKey] as const);
    for (const [, key] of identities) {
      if (keys.has(key)) return null;
      keys.add(key);
    }
    copies.push({ source: model.sourceDocument.source, identities });
  }
  const data = parseMermaidVisualFamilyData(value.projection);
  if (data?.family !== "mindmap") return null;
  return { copies, projection: readMindmapProjectionData(data) };
}

/** Pointer and native clipboard actions serialize the same disjoint subtrees. */
export function copyMindmapSelection(props: MindmapReactHostProps) {
  if (props.displayOnly || props.draftActive || !props.clipboard) return null;
  const copies = copyMindmapSubtrees(props.model, props.selectedKeys);
  if (!copies) return null;
  const selected = new Map(
    copies.flatMap((copy) =>
      copy.identities.map(([, key]) => [key, key] as const),
    ),
  );
  const projection = copiedMindmapProjection(
    {},
    props.projection,
    selected,
    true,
  );
  const data = createMermaidVisualFamilyData("mindmap", {
    projection: {
      layout: props.projection.layout,
      design: props.projection.design,
      collapsed: [...(projection.collapsed ?? [])],
      rootSides: [...(projection.rootSides ?? [])],
      nodeAppearance: [...(projection.nodeAppearance ?? [])],
      branchAppearance: [...(projection.branchAppearance ?? [])],
    },
  });
  return props.clipboard.write({
    "text/plain": copies.map((copy) => copy.source).join("\n"),
    [MINDMAP_SUBTREE_CLIPBOARD_MIME]: JSON.stringify({
      version: 1,
      copies,
      projection: data,
    }),
  });
}

/** A typed subtree never falls through into the surrounding rich-text editor. */
export function pasteMindmapSelection(
  props: MindmapReactHostProps,
  data: Record<string, unknown>,
) {
  const encoded = data[MINDMAP_SUBTREE_CLIPBOARD_MIME];
  const payload = typeof encoded === "string" ? readClipboard(encoded) : null;
  if (
    props.readonly ||
    props.displayOnly ||
    props.draftActive ||
    props.selectedKeys.length !== 1 ||
    !payload
  )
    return false;
  return props.onCommand(
    { type: "paste", parentKey: props.selectedKeys[0], ...payload },
    props.sourceBasis,
  ).changed;
}

export function bindMindmapClipboard(getProps: () => MindmapReactHostProps) {
  const port = getProps().clipboard;
  return port?.subscribe({
    copy: (event) => {
      const write = copyMindmapSelection(getProps());
      if (!write) return false;
      event.preventDefault();
      void write.catch(console.error);
      return true;
    },
    paste: (event) => {
      const encoded = port.read(event)[MINDMAP_SUBTREE_CLIPBOARD_MIME];
      if (typeof encoded !== "string") return false;
      // An unresolved/readonly target still consumes this typed payload: falling
      // through to generic rich text paste would create a different product.
      event.preventDefault();
      pasteMindmapSelection(getProps(), {
        [MINDMAP_SUBTREE_CLIPBOARD_MIME]: encoded,
      });
      return true;
    },
    cut: (event) => {
      // Delete owns the explicit subtree impact confirmation. A browser cut
      // must never bypass it through the surrounding Page/Edgeless clipboard.
      if (!getProps().selectedKeys.length) return false;
      event.preventDefault();
      return true;
    },
  });
}
