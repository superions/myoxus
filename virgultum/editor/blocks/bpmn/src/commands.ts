// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createBlankBpmnSource,
  canPreserveBpmnSource,
  inspectBpmnSource,
} from "@myoxus/bpmn-editor/source";
import type { BpmnBlockProps, BpmnSourceRevisionProps } from "@virgultum/model";
import { BlockSelection, type Command } from "@virgultum/std";
import {
  type BlockModel,
  type Store,
  native2Y,
  internalPrimitives,
} from "@virgultum/store";
import * as Y from "yjs";
import {
  cloneBpmnSourceRevisionSnapshot,
  createBpmnSourceRevisionProps,
  readBpmnSourceRevisions,
} from "./source-revisions.js";

export type BpmnInsertionResult =
  | { ok: true; blockId: string }
  | {
      ok: false;
      code:
        "BPMN_INSERT_CONTEXT" | "BPMN_SOURCE_REJECTED" | "BPMN_INSERT_READBACK";
      residueRetained: boolean;
    };
export type InsertBpmnBlockOptions = {
  place?: "after" | "before";
  removeEmptyLine?: boolean;
  selectedModels?: BlockModel[];
  source?: string;
  caption?: string;
  /** New-document import only; ordinary insertion/replacement stays editable. */
  preserveUnsupported?: boolean;
};

/** Prepare exact source and fresh map identities before any document mutation. */
export function createBpmnBlockInsertProps(
  options: Pick<
    InsertBpmnBlockOptions,
    "source" | "caption" | "preserveUnsupported"
  > = {},
): Partial<BpmnBlockProps> &
  BpmnSourceRevisionProps & { flavour: "myoxus:bpmn" } {
  return {
    flavour: "myoxus:bpmn",
    ...createBpmnSourceRevisionProps(
      options.source ?? createBlankBpmnSource(),
      options.preserveUnsupported,
    ),
    caption: options.caption ?? "",
  };
}

/** Resolve Page-relative placement before the shared insertion/readback owner. */
export function insertPreparedBpmnBlock(
  store: Store,
  target: BlockModel,
  props: Partial<BpmnBlockProps> & BpmnSourceRevisionProps,
  place: "after" | "before" = "after",
): BpmnInsertionResult {
  const parent = store.getParent(target);
  const index =
    parent?.children.findIndex((child) => child.id === target.id) ?? -1;
  if (!parent || index < 0 || store.getBlock(target.id)?.model !== target)
    return { ok: false, code: "BPMN_INSERT_CONTEXT", residueRetained: false };
  return insertPreparedBpmnBlockAt(
    store,
    parent,
    props,
    index + (place === "after" ? 1 : 0),
  );
}

/** Page and compound Edgeless insertion share source/readback/rollback ownership.
 * Read Yjs directly: a parent created in an outer transaction has no model until
 * observers run. Transactions do not roll back failed CRUD; remove only unchanged
 * attempt-owned residue, never concurrently edited or moved content.
 * @param blockId - Optional reserved creation ID; an existing ID is rejected,
 * not treated as proof of idempotent initialization. */
export function insertPreparedBpmnBlockAt(
  store: Store,
  parent: BlockModel | string,
  props: Partial<BpmnBlockProps> & BpmnSourceRevisionProps,
  index?: number,
  blockId?: string,
): BpmnInsertionResult {
  const parentId = typeof parent === "string" ? parent : parent.id;
  const parentBlock = store.doc.yBlocks.get(parentId);
  const children = parentBlock?.get("sys:children") as
    Y.Array<string> | undefined;
  const at = index ?? children?.length ?? 0;
  if (
    store.readonly ||
    !parentBlock ||
    !children ||
    (typeof parent !== "string" &&
      store.getBlock(parentId)?.model !== parent) ||
    !Number.isInteger(at) ||
    at < 0 ||
    at > children.length ||
    !store.schema.safeValidate(
      "myoxus:bpmn",
      parentBlock.get("sys:flavour") as string,
      [],
    )
  )
    return { ok: false, code: "BPMN_INSERT_CONTEXT", residueRetained: false };
  try {
    cloneBpmnSourceRevisionSnapshot(props);
    if (
      !Object.keys(props.sourceHeads).length ||
      Object.values(props.sourceHeads).some(
        (source) => !canPreserveBpmnSource(inspectBpmnSource(source)),
      )
    )
      throw new Error("BPMN_SOURCE_REJECTED");
  } catch {
    return { ok: false, code: "BPMN_SOURCE_REJECTED", residueRetained: false };
  }
  const id = blockId ?? store.workspace.idGenerator();
  if (!id || store.doc.yBlocks.has(id))
    return { ok: false, code: "BPMN_INSERT_CONTEXT", residueRetained: false };
  const defaults =
    store.schema.get("myoxus:bpmn")!.model.props!(internalPrimitives);
  const values = { ...defaults, ...props };
  const expected: Record<string, unknown> = {
    "sys:id": id,
    "sys:flavour": "myoxus:bpmn",
    "sys:version": store.schema.get("myoxus:bpmn")!.version,
    "sys:children": [],
  };
  // Unattached Y.Text cannot be serialized by reading it. Materialize preparation
  // separately so expected title/props are frozen before document observers run.
  const preparation = new Y.Doc();
  const prepared = preparation.getMap("props");
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && key !== "flavour")
      prepared.set(key, native2Y(value));
  for (const [key, value] of Object.entries(prepared.toJSON()))
    expected[`prop:${key}`] = value;
  store.captureSync();
  let insertionThrew = false;
  try {
    store.addBlock("myoxus:bpmn", { ...values, id }, parentId, at);
  } catch {
    insertionThrew = true;
  } finally {
    preparation.destroy();
  }
  const raw = store.doc.yBlocks.get(id);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const unedited =
    raw &&
    Object.entries(raw.toJSON()).every(
      ([key, value]) =>
        Object.hasOwn(expected, key) && same(value, expected[key]),
    );
  let valid = false;
  try {
    valid =
      !insertionThrew &&
      !!raw &&
      unedited === true &&
      same(
        (raw.get("prop:sourceHeads") as Y.Map<string>).toJSON(),
        props.sourceHeads,
      ) &&
      same(
        (raw.get("prop:sourceLinks") as Y.Map<string>).toJSON(),
        props.sourceLinks,
      ) &&
      raw.get("prop:selectedHead") === props.selectedHead &&
      children.toArray().filter((child) => child === id).length === 1 &&
      readBpmnSourceRevisions(raw).status !== "empty";
  } catch {
    valid = false;
  }
  if (valid) {
    store.captureSync();
    return { ok: true, blockId: id };
  }
  const moved = [...store.doc.yBlocks].some(
    ([parentId, block]) =>
      parentId !== (typeof parent === "string" ? parent : parent.id) &&
      (block.get("sys:children") as Y.Array<string> | undefined)
        ?.toArray()
        .includes(id),
  );
  if (raw && unedited && !moved)
    store.transact(() => {
      const at = children.toArray().indexOf(id);
      if (at >= 0) children.delete(at, 1);
      store.doc.yBlocks.delete(id);
    });
  store.captureSync();
  return {
    ok: false,
    code: "BPMN_INSERT_READBACK",
    residueRetained: store.doc.yBlocks.has(id),
  };
}

function select(std: Parameters<Command>[0]["std"], blockId: string) {
  std.selection.set([std.selection.create(BlockSelection, { blockId })]);
}

export const insertBpmnBlockCommand: Command<
  InsertBpmnBlockOptions,
  { insertedBpmnBlockId?: string; bpmnInsertion: BpmnInsertionResult }
> = (ctx, next) => {
  const targets = ctx.selectedModels;
  const target = ctx.place === "before" ? targets?.[0] : targets?.at(-1);
  if (!target) return;
  let props: ReturnType<typeof createBpmnBlockInsertProps>;
  try {
    props = createBpmnBlockInsertProps(ctx);
  } catch {
    next({
      bpmnInsertion: {
        ok: false,
        code: "BPMN_SOURCE_REJECTED",
        residueRetained: false,
      },
    });
    return;
  }
  const result = insertPreparedBpmnBlock(
    ctx.std.store,
    target,
    props,
    ctx.place,
  );
  if (result.ok) {
    if (
      ctx.removeEmptyLine &&
      target.text?.length === 0 &&
      target.flavour === "myoxus:paragraph"
    )
      ctx.std.store.deleteBlock(target);
    select(ctx.std, result.blockId);
  }
  next({
    bpmnInsertion: result,
    insertedBpmnBlockId: result.ok ? result.blockId : undefined,
  });
};
