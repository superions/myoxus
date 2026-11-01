// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createBpmnBlockInsertProps,
  insertPreparedBpmnBlockAt,
  readBpmnSourceRevisions,
} from "@virgultum/block-bpmn";
import { NoteDisplayMode } from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import * as Y from "yjs";

export type BpmnInitializationResult =
  | { status: "initialized"; blockId: string }
  | { status: "collision" | "retryable" };

/** A retained creation attempt, not a distributed lock or metadata fallback.
 * Replay uses the original CRDT operations, never a second map/array insertion
 * with merely the same string ID. Persisted blocks remain the source authority. */
export type BpmnInitialization = {
  readonly blockId: string;
  readonly props: ReturnType<typeof createBpmnBlockInsertProps>;
  skeleton?: {
    pageId: string;
    surfaceId: string;
    noteId: string;
    paragraphId: string;
  };
  update?: Uint8Array;
};

export function prepareBpmnInitialization(
  source?: string,
  preserveUnsupported = false,
): BpmnInitialization {
  return {
    blockId: crypto.randomUUID(),
    props: createBpmnBlockInsertProps({ source, preserveUnsupported }),
  };
}

function emptySkeleton(store: Store) {
  const blocks = store.doc.yBlocks;
  const pages = [...blocks.values()].filter(
    (block) => block.get("sys:flavour") === "myoxus:page",
  );
  const page = pages[0];
  if (pages.length !== 1 || blocks.size !== 4) return null;
  const childIds = (block: Y.Map<unknown>) =>
    (block.get("sys:children") as Y.Array<string>).toArray();
  const children = childIds(page).map((id) => blocks.get(id));
  const surface = children.find(
    (block) => block?.get("sys:flavour") === "myoxus:surface",
  );
  const note = children.find(
    (block) => block?.get("sys:flavour") === "myoxus:note",
  );
  const elements = (
    surface?.get("prop:elements") as Y.Map<unknown> | undefined
  )?.get("value");
  if (
    children.length !== 2 ||
    !surface ||
    !note ||
    childIds(surface).length !== 0 ||
    !(elements instanceof Y.Map) ||
    elements.size !== 0 ||
    surface.get("prop:exportSnapshotBlobId") !== "" ||
    surface.get("prop:exportSnapshotWidth") !== 0 ||
    surface.get("prop:exportSnapshotHeight") !== 0 ||
    note.get("prop:displayMode") !== NoteDisplayMode.DocAndEdgeless ||
    childIds(note).length !== 1
  )
    return null;
  const paragraphId = childIds(note)[0];
  const paragraph = blocks.get(paragraphId);
  if (
    !paragraph ||
    paragraph.get("sys:flavour") !== "myoxus:paragraph" ||
    childIds(paragraph).length !== 0 ||
    !(paragraph.get("prop:text") instanceof Y.Text) ||
    Object.entries(paragraph.toJSON()).some(
      ([key, value]) =>
        key.startsWith("prop:") &&
        (key === "prop:text"
          ? value !== ""
          : key === "prop:type"
            ? value !== "text"
            : key === "prop:collapsed"
              ? value !== false
              : value !== undefined),
    )
  )
    return null;
  return {
    pageId: page.get("sys:id") as string,
    surfaceId: surface.get("sys:id") as string,
    noteId: note.get("sys:id") as string,
    paragraphId,
  };
}

function initialized(store: Store, attempt: BpmnInitialization): boolean {
  const raw = store.doc.yBlocks.get(attempt.blockId);
  const note =
    attempt.skeleton && store.doc.yBlocks.get(attempt.skeleton.noteId);
  if (
    !raw ||
    raw.get("sys:flavour") !== "myoxus:bpmn" ||
    !note ||
    store.doc.yBlocks.has(attempt.skeleton!.paragraphId)
  )
    return false;
  const children = note.get("sys:children") as Y.Array<string>;
  if (children.toArray().filter((id) => id === attempt.blockId).length !== 1)
    return false;
  try {
    const links = raw.get("prop:sourceLinks") as Y.Map<string>;
    // Later edits may retire the initial XML payload, not its ancestry identity.
    // Recognizing that existing owner must not reset it to the creation source.
    return (
      links.has(attempt.props.selectedHead) &&
      readBpmnSourceRevisions(raw).status !== "empty"
    );
  } catch {
    return false;
  }
}

/** Only the exact Page/empty Surface/normal note/empty text skeleton is writable.
 * The synchronous transaction runs before provisioning returns or waits for ACK;
 * a delayed client may replay its captured update only on that same skeleton. */
export function initializeBpmnDocument(
  store: Store,
  attempt: BpmnInitialization,
): BpmnInitializationResult {
  if (initialized(store, attempt))
    return { status: "initialized", blockId: attempt.blockId };
  if (store.readonly || store.doc.yBlocks.size === 0)
    return { status: "retryable" };
  const skeleton = emptySkeleton(store);
  if (
    !skeleton ||
    (attempt.skeleton &&
      JSON.stringify(skeleton) !== JSON.stringify(attempt.skeleton))
  )
    return { status: "collision" };
  if (attempt.update) {
    // Applying these same item identities twice is idempotent for both the
    // block-map value and the parent's Y.Array reference. No fresh CRUD here.
    Y.applyUpdate(store.spaceDoc, attempt.update);
    return initialized(store, attempt)
      ? { status: "initialized", blockId: attempt.blockId }
      : { status: "retryable" };
  }
  attempt.skeleton = skeleton;
  const before = Y.encodeStateVector(store.spaceDoc);
  let inserted = false;
  store.transact(() => {
    const result = insertPreparedBpmnBlockAt(
      store,
      skeleton.noteId,
      attempt.props,
      0,
      attempt.blockId,
    );
    if (!result.ok) return;
    // Atomic first-leaf initialization has not materialized BlockModels yet.
    // The exact-skeleton check above owns this unchanged paragraph/reference.
    const children = store.doc.yBlocks
      .get(skeleton.noteId)!
      .get("sys:children") as Y.Array<string>;
    children.delete(children.toArray().indexOf(skeleton.paragraphId), 1);
    store.doc.yBlocks.delete(skeleton.paragraphId);
    inserted = true;
  });
  if (!inserted) return { status: "retryable" };
  attempt.update = Y.encodeStateAsUpdate(store.spaceDoc, before);
  return initialized(store, attempt)
    ? { status: "initialized", blockId: attempt.blockId }
    : { status: "retryable" };
}
