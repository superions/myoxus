import { signal } from "@preact/signals-core";
import { Subject } from "rxjs";
import * as Y from "yjs";

import type { Store } from "../../model";
import {
  canChangeFixedTextProperty,
  hasFixedTextOwner,
} from "../../reactive/text/text-protection";
import { StoreExtension } from "../store-extension";

const touchedItems = Symbol("native-history-touched-items");
type NativeStackItem = Y.UndoManager["undoStack"][number];

function sameDefinition(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameDefinition(value, right[index]))
    );
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameDefinition(a[key], b[key]))
  );
}

/** Keep admission on the one supplied manager, including direct rich-text
 * keyboard calls. Rejected entries are removed, not partially applied.
 */
class NativeHistoryManager extends Y.UndoManager {
  constructor(private readonly nativeStore: Store) {
    super([nativeStore.doc.yBlocks], {
      trackedOrigins: new Set([nativeStore.doc.spaceDoc.clientID]),
    });
    const capture = ({ stackItem }: { stackItem: NativeStackItem }) => {
      const items = new Set<Y.Item>();
      for (const deleted of [stackItem.insertions, stackItem.deletions]) {
        for (const [client, ranges] of deleted.clients) {
          const structs = nativeStore.spaceDoc.store.clients.get(client);
          if (!structs) continue;
          for (const range of ranges) {
            let index = Y.findIndexSS(structs, range.clock);
            while (index < structs.length) {
              const item = structs[index++];
              if (item.id.clock >= range.clock + range.len) break;
              if (item instanceof Y.Item) items.add(item);
            }
          }
        }
      }
      stackItem.meta.set(touchedItems, items);
    };
    this.on("stack-item-added", capture);
    this.on("stack-item-updated", capture);
  }

  private admits(entry: NativeStackItem): boolean {
    const items = entry.meta.get(touchedItems) as Set<Y.Item> | undefined;
    if (!items) return false;
    for (const item of items) {
      const parent = item.parent;
      if (
        parent === this.nativeStore.doc.yBlocks &&
        item.parentSub &&
        this.nativeStore.hasFixedText(item.parentSub)
      )
        return false;
      if (parent instanceof Y.Text && hasFixedTextOwner(parent)) {
        // A canonical answer changes only the descriptor's formatting atom.
        // Literal/mark edits and insertion/removal of an occurrence are structural.
        if (
          !(item.content instanceof Y.ContentFormat) ||
          item.content.key !== "documentField"
        )
          return false;
        const descriptor = item.content.value as {
          type?: string;
          id?: string;
          definition?: unknown;
        } | null;
        if (descriptor !== null) {
          if (
            !descriptor ||
            descriptor.type !== "input" ||
            typeof descriptor.id !== "string"
          )
            return false;
          const current = parent
            .toDelta()
            .find(
              (run: { attributes?: { documentField?: { id?: string } } }) =>
                run.attributes?.documentField?.id === descriptor.id,
            )?.attributes?.documentField;
          if (
            !current ||
            current.type !== "input" ||
            !sameDefinition(current.definition, descriptor.definition)
          )
            return false;
        }
      }
      if (
        parent instanceof Y.Map &&
        item.parentSub &&
        !canChangeFixedTextProperty(parent, item.parentSub, undefined)
      )
        return false;
    }
    return true;
  }

  private prune(stack: NativeStackItem[]) {
    for (let index = stack.length - 1; index >= 0; index--)
      if (!this.admits(stack[index])) stack.splice(index, 1);
  }

  override canUndo() {
    this.prune(this.undoStack);
    return super.canUndo();
  }

  override canRedo() {
    this.prune(this.redoStack);
    return super.canRedo();
  }

  override undo() {
    this.prune(this.undoStack);
    return this.nativeStore.readonly ? null : super.undo();
  }

  override redo() {
    this.prune(this.redoStack);
    return this.nativeStore.readonly ? null : super.redo();
  }
}

export class HistoryExtension extends StoreExtension {
  static override readonly key = "history";

  private _history: Y.UndoManager;

  private _disposed = false;

  private readonly _canRedo = signal(false);

  private readonly _canUndo = signal(false);

  private _onUpdated = new Subject<void>();

  get onUpdated() {
    return this._onUpdated;
  }

  constructor(store: Store) {
    super(store);

    this._history = this._createHistory();
  }

  private _createHistory() {
    return new NativeHistoryManager(this.store);
  }

  private readonly _updateCanUndoRedoSignals = () => {
    const canRedo = this._history.canRedo();
    const canUndo = this._history.canUndo();
    if (this._canRedo.peek() !== canRedo) {
      this._canRedo.value = canRedo;
    }
    if (this._canUndo.peek() !== canUndo) {
      this._canUndo.value = canUndo;
    }
  };

  get canRedo() {
    return this._canRedo.peek();
  }

  get canUndo() {
    return this._canUndo.peek();
  }

  get canRedo$() {
    return this._canRedo;
  }

  get canUndo$() {
    return this._canUndo;
  }

  get undoManager() {
    return this._history;
  }

  override loaded() {
    if (this._disposed) {
      this._history = this._createHistory();
      this._onUpdated = new Subject<void>();
      this._disposed = false;
    }
    this._updateCanUndoRedoSignals();
    this._history.on("stack-cleared", this._historyObserver);
    this._history.on("stack-item-added", this._historyObserver);
    this._history.on("stack-item-popped", this._historyObserver);
    this._history.on("stack-item-updated", this._historyObserver);
  }

  private readonly _historyObserver = () => {
    this._updateCanUndoRedoSignals();
    this.onUpdated.next();
  };

  override disposed() {
    super.disposed();
    // The shared Y.Doc outlives its Store. Release this Store's manager now;
    // load() creates a fresh manager before selection listeners are attached.
    this._history.clear();
    this._history.destroy();
    this._disposed = true;
    this._updateCanUndoRedoSignals();
    this.onUpdated.complete();
  }
}
