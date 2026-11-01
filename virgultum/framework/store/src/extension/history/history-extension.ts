import { signal } from "@preact/signals-core";
import { Subject } from "rxjs";
import * as Y from "yjs";

import type { Store } from "../../model";
import { StoreExtension } from "../store-extension";

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
    return new Y.UndoManager([this.store.doc.yBlocks], {
      trackedOrigins: new Set([this.store.doc.spaceDoc.clientID]),
    });
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
