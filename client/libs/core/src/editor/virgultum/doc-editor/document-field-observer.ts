// SPDX-License-Identifier: AGPL-3.0-or-later
import { Boxed, type BlockModel, type Store } from "@virgultum/editor/store";
import {
  DocumentFieldSchema,
  validateDocumentFieldRun,
  type DocumentField,
} from "@virgultum/editor/shared/types";
import * as Y from "yjs";

type MetadataField = Extract<DocumentField, { type: "metadata" }>;
type TextOwner = {
  fields: DocumentField[];
  invalid: boolean;
  changed: (event: Y.YTextEvent) => void;
};
type PropertyOwner = {
  value: unknown;
  texts: Set<Y.Text>;
  dispose: () => void;
};
type BlockOwner = {
  model: BlockModel;
  children: Set<string>;
  properties: Map<string, PropertyOwner>;
  disposeChildren: () => void;
  disposeProperties: () => void;
};

const hasFieldAttributes = (attributes: Record<string, unknown> | undefined) =>
  !!attributes &&
  ("documentField" in attributes || "documentFieldCaptured" in attributes);

/** Read reachable native text only. Associations are mount-local: no snapshots,
 * model writes, metadata reads or synchronization hooks belong to discovery.
 */
export function observeDocumentFields(
  page: Store,
  publish: (fields: MetadataField[]) => void,
  invalid: () => void,
): () => void {
  const blocks = new Map<string, BlockOwner>();
  const parents = new Map<string, Set<string>>();
  const texts = new Map<Y.Text, TextOwner>();
  const fieldOwners = new Set<TextOwner>();
  const dirtyTexts = new Set<Y.Text>();
  const dirtyProperties = new Map<string, Set<string>>();
  const removed = new Set<string>();
  let root: string | undefined;
  let disposed = false;
  let queued = false;
  let last: string | undefined;

  const readText = (text: Y.Text, owner: TextOwner) => {
    owner.fields = [];
    owner.invalid = false;
    try {
      for (const run of text.toDelta()) {
        if (!hasFieldAttributes(run.attributes)) continue;
        validateDocumentFieldRun(run);
        if (run.attributes?.documentFieldCaptured === true) continue;
        owner.fields.push(
          DocumentFieldSchema.parse(run.attributes?.documentField),
        );
      }
    } catch {
      owner.invalid = true;
    }
    if (owner.fields.length || owner.invalid) fieldOwners.add(owner);
    else fieldOwners.delete(owner);
  };
  const attachText = (text: Y.Text) => {
    if (texts.has(text)) return;
    const owner: TextOwner = {
      fields: [],
      invalid: false,
      changed: (event) => {
        // Ordinary insertion/formatting in an input-only or field-free owner
        // cannot alter its metadata descriptors. A deletion can remove a field.
        if (
          owner.invalid ||
          owner.fields.some((field) => field.type === "metadata") ||
          event.delta.some(
            (operation) =>
              hasFieldAttributes(operation.attributes) ||
              ("delete" in operation && owner.fields.length > 0),
          )
        ) {
          dirtyTexts.add(text);
          schedule();
        }
      },
    };
    texts.set(text, owner);
    readText(text, owner);
    text.observe(owner.changed);
  };
  const detachText = (text: Y.Text) => {
    const owner = texts.get(text);
    if (owner) text.unobserve(owner.changed);
    if (owner) fieldOwners.delete(owner);
    texts.delete(text);
    dirtyTexts.delete(text);
  };
  const collectTexts = (value: unknown, found: Set<Y.Text>) => {
    if (value instanceof Y.Text) found.add(value);
    else if (!Boxed.is(value)) {
      if (value instanceof Y.Map || value instanceof Y.Array)
        value.forEach((child) => collectTexts(child, found));
    }
  };
  const propertyChanged = (id: string, key: string) => {
    const keys = dirtyProperties.get(id) ?? new Set<string>();
    keys.add(key);
    dirtyProperties.set(id, keys);
    schedule();
  };
  const readProperty = (block: BlockOwner, key: string) => {
    const value: unknown = block.model.yBlock.get(`prop:${key}`);
    const previous = block.properties.get(key);
    const found = new Set<Y.Text>();
    collectTexts(value, found);
    for (const text of previous?.texts ?? [])
      if (!found.has(text)) detachText(text);
    for (const text of found) attachText(text);
    previous?.dispose();
    if (value === undefined) {
      block.properties.delete(key);
      return;
    }
    const structural = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (
        events.some((event) => {
          if (event.target instanceof Y.Text) return false;
          // Shared table containers are traversable; private/boxed values are not.
          let current: unknown = value;
          for (const part of event.path) {
            if (Boxed.is(current)) return false;
            current =
              current instanceof Y.Map
                ? current.get(String(part))
                : current instanceof Y.Array
                  ? current.get(Number(part))
                  : undefined;
          }
          return !Boxed.is(current);
        })
      )
        propertyChanged(block.model.id, key);
    };
    const shared =
      !Boxed.is(value) && (value instanceof Y.Map || value instanceof Y.Array)
        ? value
        : undefined;
    shared?.observeDeep(structural);
    block.properties.set(key, {
      value,
      texts: found,
      dispose: () => shared?.unobserveDeep(structural),
    });
  };
  const readChildren = (block: BlockOwner) => {
    const children = new Set(block.model.yBlock.get("sys:children").toArray());
    for (const id of block.children) {
      if (children.has(id)) continue;
      const owners = parents.get(id);
      owners?.delete(block.model.id);
      if (!owners?.size) {
        parents.delete(id);
        removed.add(id);
      }
    }
    for (const id of children) {
      const owners = parents.get(id) ?? new Set<string>();
      owners.add(block.model.id);
      parents.set(id, owners);
      if (!block.children.has(id)) attachBlock(id);
    }
    block.children = children;
  };
  const observeChildren = (block: BlockOwner) => {
    block.disposeChildren();
    const children = block.model.yBlock.get("sys:children");
    const changed = () => {
      readChildren(block);
      schedule();
    };
    children.observe(changed);
    block.disposeChildren = () => children.unobserve(changed);
    readChildren(block);
  };
  const attachBlock = (id: string) => {
    if (blocks.has(id)) return;
    const model = page.getBlock(id)?.model;
    if (!model) return; // Child membership can precede model initialization.
    const block: BlockOwner = {
      model,
      children: new Set(),
      properties: new Map(),
      disposeChildren: () => {},
      disposeProperties: () => {},
    };
    blocks.set(id, block);
    if (id !== root)
      for (const key of model.yBlock.keys())
        if (key.startsWith("prop:")) readProperty(block, key.slice(5));
    const changed = (event: Y.YMapEvent<unknown>) => {
      for (const nativeKey of event.keysChanged) {
        if (!nativeKey.startsWith("prop:") || id === root) continue;
        const key = nativeKey.slice(5);
        const previous = block.properties.get(key);
        const next: unknown = model.yBlock.get(nativeKey);
        const native =
          !Boxed.is(next) &&
          (next instanceof Y.Text ||
            next instanceof Y.Map ||
            next instanceof Y.Array);
        if (previous?.value !== next && (native || previous?.texts.size))
          propertyChanged(id, key);
      }
    };
    // Store's public table update key is the top-level "cells". Native map
    // keys identify the replaced cell without reading every other cell.
    model.yBlock.observe(changed);
    block.disposeProperties = () => model.yBlock.unobserve(changed);
    observeChildren(block);
  };
  const detachBlock = (id: string) => {
    const block = blocks.get(id);
    if (!block) return;
    block.disposeChildren();
    block.disposeProperties();
    for (const property of block.properties.values()) {
      property.dispose();
      for (const text of property.texts) detachText(text);
    }
    blocks.delete(id);
    dirtyProperties.delete(id);
    for (const child of block.children) {
      const owners = parents.get(child);
      owners?.delete(id);
      if (!owners?.size) {
        parents.delete(child);
        detachBlock(child);
      }
    }
  };
  const emit = () => {
    const fields: MetadataField[] = [];
    const identities = new Set<string>();
    let malformed = false;
    for (const owner of fieldOwners) {
      malformed ||= owner.invalid;
      for (const field of owner.fields) {
        if (identities.has(field.id)) malformed = true;
        identities.add(field.id);
        if (field.type === "metadata") fields.push(field);
      }
    }
    fields.sort((a, b) => a.id.localeCompare(b.id));
    const encoded = malformed ? "invalid" : JSON.stringify(fields);
    if (encoded === last) return;
    last = encoded;
    if (malformed) invalid();
    else publish(fields);
  };
  function schedule() {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      for (const id of removed)
        if (id !== root && !parents.has(id)) detachBlock(id);
      removed.clear();
      for (const [id, keys] of dirtyProperties) {
        const block = blocks.get(id);
        if (block) for (const key of keys) readProperty(block, key);
      }
      dirtyProperties.clear();
      for (const text of dirtyTexts) {
        const owner = texts.get(text);
        if (owner) readText(text, owner);
      }
      dirtyTexts.clear();
      emit();
    });
  }
  const syncRoot = () => {
    const next = page.root?.id;
    if (next === root) return;
    if (root) detachBlock(root);
    root = next;
    if (root) attachBlock(root);
    schedule();
  };
  const subscriptions = [
    page.slots.rootAdded.subscribe(syncRoot),
    page.slots.rootDeleted.subscribe(() => {
      if (root) detachBlock(root);
      root = undefined;
      schedule();
    }),
    page.slots.blockUpdated.subscribe((event) => {
      if (event.type === "add") {
        if (event.id === root || parents.has(event.id)) attachBlock(event.id);
        schedule();
      } else if (event.type === "delete") {
        detachBlock(event.id);
        schedule();
      } else {
        const block = blocks.get(event.id);
        if (!block) return;
        const key = event.props.key;
        if (key === "sys:children") {
          observeChildren(block);
          schedule();
        }
      }
    }),
  ];
  syncRoot();
  return () => {
    disposed = true;
    subscriptions.forEach((subscription) => subscription.unsubscribe());
    for (const block of blocks.values()) {
      block.disposeChildren();
      block.disposeProperties();
    }
    for (const block of blocks.values())
      for (const property of block.properties.values()) property.dispose();
    for (const text of texts.keys()) detachText(text);
    blocks.clear();
    fieldOwners.clear();
    parents.clear();
    dirtyProperties.clear();
    removed.clear();
  };
}
