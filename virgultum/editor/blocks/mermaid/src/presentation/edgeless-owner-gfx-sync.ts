import {
  readMermaidSelectionHistory,
  carryMermaidSelectionHistory,
  type MermaidHistoryStackItem,
} from "../mermaid-selection-history.js";
import { mermaidRuntimePreservesSourceBytes } from "../families/runtime/factory.js";
import { getMermaidFamilyRuntime } from "../families/runtime/registry.js";
import { MERMAID_GFX_TITLE_ROLE } from "../families/runtime/gfx-element-roles.js";
import { usesTypeOwnedMermaidDocumentHistory } from "../families/runtime/gfx-owner-hooks.js";
import { Bound } from "@virgultum/global/gfx";
import { getMermaidGfxFamilyHooks } from "../families/runtime/gfx-family-hooks-registry.js";
import { readMermaidGfxMeta } from "../mermaid-gfx-metadata.js";
import type { MermaidGfxObjectEditIntent } from "../families/runtime/editor-capabilities.js";
import { batch } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/global/disposable";
import type { MermaidBlockModel } from "@virgultum/model";
import { GfxExtension, InteractivityIdentifier } from "@virgultum/std/gfx";

import type { MermaidVisualHistoryModel } from "../mermaid-block-constants.js";
import {
  applyMermaidVisualModelCommand,
  ensureMermaidProjectionOwnerCommand,
  getMermaidSourceAuthoritativeVisualModel,
  getMermaidVisualModel,
  getMermaidGfxNode,
  syncMermaidVisualModelFromProjectionOwnerCommand,
} from "../commands.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import { resolveMermaidSourceLifecycle } from "../families/runtime/source-lifecycle.js";
import { hasActiveMermaidInlineTextEditor } from "../mermaid-editor-events.js";
import {
  beginMermaidRuntimeTransaction,
  commitMermaidRuntimeTransaction,
} from "../families/runtime/transaction.js";
import {
  isMermaidGfxNodeModel,
  syncMermaidGfxNodeLabelsFromVisibleText,
} from "../mermaid-gfx-metadata.js";
import { resolveMermaidKeyboardIntent } from "../mermaid-keyboard.js";
import {
  createMermaidProjectionOwnerSourceSyncKey,
  MERMAID_OWNER_SOURCE_SYNC_DELAY_MS,
  nextMermaidOwnerSourceSyncPauseUntil,
  shouldScheduleMermaidOwnerSourceSync,
} from "../mermaid-owner-source-sync.js";
import {
  getMermaidVisualHistoryStacks,
  takeMermaidVisualRedoEntry,
  takeMermaidVisualUndoEntry,
} from "../mermaid-visual-source-history.js";
import { getMermaidBlockSource, hashMermaidSource } from "../utils.js";
import { projectMermaidLocalGfxAppearance } from "../mermaid-local-gfx-appearance.js";
import { cloneMermaidVisualModel } from "../mermaid-visual-model-operations.js";
import {
  canMutateMermaidGfxOwnerSource,
  canProjectMermaidNatively,
} from "./owner.js";
import {
  resolveMermaidGfxProjection,
  resolveMermaidGfxProjectionOwner,
} from "./gfx-projection-owner.js";
import {
  resolveNativeMermaidOwner,
  resolveNativeMermaidOwnerForSelection,
} from "./edgeless-owner-resolution.js";

type MermaidObservableText = {
  observe: (
    observer: (
      event: unknown,
      transaction: { local?: boolean } | undefined,
    ) => void,
  ) => void;
  toString: () => string;
  unobserve: (
    observer: (
      event: unknown,
      transaction: { local?: boolean } | undefined,
    ) => void,
  ) => void;
};

function isNativeMermaidGfxOwner(model: unknown): model is MermaidBlockModel {
  const block = model as MermaidBlockModel | null | undefined;
  if (!block || !resolveNativeMermaidOwner(block)) return false;
  const source = getMermaidBlockSource(block.props);
  const lifecycle = resolveMermaidSourceLifecycle(source);
  return (
    lifecycle.canReconcileProjection &&
    canProjectMermaidNatively(lifecycle.resolution) &&
    canMutateMermaidGfxOwnerSource({
      lastValidSource: block.props.lastValidSource,
      parent: block.store.getParent(block.id),
      source,
    })
  );
}

function isEditableMermaidEdgelessHotkeyTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    ),
  );
}

function isMermaidInlineShapeTextEditorTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "edgeless-shape-text-editor, edgeless-connector-label-editor",
      ),
    )
  );
}

function hasMermaidInlineShapeTextEditorEvent(event: Event) {
  const path = event.composedPath();
  return (
    isMermaidInlineShapeTextEditorTarget(event.target) ||
    path.some(
      (target) =>
        target instanceof Element &&
        (target.localName === "edgeless-shape-text-editor" ||
          target.localName === "edgeless-connector-label-editor"),
    ) ||
    hasActiveMermaidInlineShapeTextEditor()
  );
}

function hasActiveMermaidInlineShapeTextEditor() {
  return hasActiveMermaidInlineTextEditor();
}

function isMermaidObservableText(
  value: unknown,
): value is MermaidObservableText {
  const text = value as Partial<MermaidObservableText> | null | undefined;
  return (
    typeof text?.toString === "function" &&
    typeof text.observe === "function" &&
    typeof text.unobserve === "function"
  );
}

function isMermaidTextLike(
  value: unknown,
): value is { toString: () => string } {
  return (
    typeof (value as { toString?: unknown } | null)?.toString === "function"
  );
}

export class MermaidEdgelessOwnerGfxSync extends GfxExtension {
  static override key = "mermaid-edgeless-owner-gfx-sync";

  private readonly _disposables = new DisposableGroup();
  private readonly _handleDocumentKeydown = (event: KeyboardEvent) => {
    if (this._replayKeyboardHistoryIntent(event)) return;
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
    ) {
      return;
    }
    if (isEditableMermaidEdgelessHotkeyTarget(event.target)) return;
    const owner = this._getActiveNativeMermaidOwner();
    if (!owner) return;
    if (
      !event.isComposing &&
      !event.altKey &&
      (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() === "d") &&
      !event.shiftKey &&
      event.composedPath().includes(this.std.host) &&
      !(
        event.target instanceof Element &&
        event.target.closest('button,a[href],[role="dialog"],[role="menu"]')
      )
    ) {
      const selected = this.gfx.selection.selectedElements;
      const visual = getMermaidVisualModel(owner);
      const key =
        selected.length === 1 ||
        (selected.length > 1 &&
          ["Delete", "Backspace", "d", "D"].includes(event.key))
          ? readMermaidGfxMeta(selected[0], "mermaidNodeId") ||
            (selected[0].id === owner.id ? visual?.nodes[0]?.id : null)
          : null;
      const intent =
        visual &&
        key &&
        getMermaidGfxFamilyHooks(visual)?.nodeKeyboardIntent?.(
          visual,
          key,
          (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d"
            ? "Duplicate"
            : event.key,
        );
      if (intent && (intent.action === "select" || !this.std.store.readonly)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (intent.action === "select") {
          const target = owner.childIds
            .map((id) => owner.surface?.getElementById(id))
            .find(
              (element) =>
                readMermaidGfxMeta(element, "mermaidNodeId") === intent.id,
            );
          if (target) {
            this.gfx.selection.set({ editing: false, elements: [target.id] });
            const bound = target.elementBound;
            if (!this.gfx.viewport.viewportBounds.contains(bound))
              this.gfx.viewport.smoothTranslate(
                bound.x + bound.w / 2,
                bound.y + bound.h / 2,
              );
          }
          this.std.host.focus({ preventScroll: true });
        } else
          this.std.host.dispatchEvent(
            new CustomEvent("mermaid-gfx-object-edit", { detail: intent }),
          );
        return;
      }
    }
    this._captureOwnerGestureVisualModel(owner);
  };
  private _lastObjectPointerDown: {
    time: number;
    x: number;
    y: number;
  } | null = null;
  private _objectPointerId: number | null = null;
  private readonly _handleDocumentPointerup = (event: PointerEvent) => {
    if (event.pointerId !== this._objectPointerId) return;
    this._objectPointerId = null;
    // ClickController retains its previous down state. Consuming only the
    // repeated down still lets pointer-up mount a generic connector editor,
    // whose blur clears the family selection and closes its domain popover.
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private readonly _handleDocumentPointerdown = (event: PointerEvent) => {
    // Portaled domain controls are not canvas gestures. Capturing every owner
    // here would reparse whole diagrams before the form's click can run.
    if (!this._isCanvasPointerEvent(event)) return;
    // A selected-node structural gesture owns its down before double-click
    // editing or generic child movement can initialize a competing journey.
    if (
      !this.std.host.dispatchEvent(
        new CustomEvent("mermaid-gfx-node-pointerdown", {
          detail: event,
          cancelable: true,
        }),
      )
    )
      return;
    const previous = this._lastObjectPointerDown;
    const repeat =
      event.button === 0 &&
      previous &&
      event.timeStamp - previous.time < 500 &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 8;
    this._lastObjectPointerDown =
      event.button === 0
        ? { time: event.timeStamp, x: event.clientX, y: event.clientY }
        : null;
    // GFX recognizes double clicks at pointer-up, before the DOM dblclick event.
    // Consume the repeated pointer-down before its inline shape editor mounts.
    if (this._consumeObjectEdit(event, !repeat)) {
      this._objectPointerId = event.pointerId;
      return;
    }
    // A user can double-click a freshly materialized Mermaid shape before the
    // async surface-added observer has attached to every Y.Text. Refresh at
    // interaction start so the imminent native text edit is observed.
    this._refreshTextObservers();
    for (const owner of this._getNativeMermaidGfxOwners()) {
      this._captureOwnerGestureVisualModel(owner, true);
    }
  };
  private readonly _handleDocumentDoubleClick = (event: MouseEvent) => {
    this._consumeObjectEdit(event, false);
  };

  private _isCanvasPointerEvent(event: MouseEvent) {
    const path = event.composedPath();
    return (
      path.includes(this.std.host) &&
      path.some(
        (target) =>
          target instanceof Element &&
          (target.tagName === "CANVAS" ||
            target.classList.contains("edgeless-background")),
      )
    );
  }

  private _consumeObjectEdit(event: MouseEvent, detailsOnly: boolean) {
    if (
      event.button !== 0 ||
      this.std.host.hasAttribute("data-mermaid-placement-owner") ||
      !this._isCanvasPointerEvent(event)
    )
      return false;
    const [x, y] = this.gfx.viewport.toModelCoordFromClientCoord([
      event.clientX,
      event.clientY,
    ]);
    const hit = this.gfx.grid
      .search(new Bound(x - 1, y - 1, 2, 2), { filter: ["canvas"] })
      .filter((element) =>
        readMermaidGfxMeta(element, "mermaidDetailSourceKey")
          ? element.elementBound.isPointInBound([x, y])
          : element.includesPoint(
              x,
              y,
              { hitThreshold: 0, responsePadding: [0, 0] },
              this.std.host,
            ),
      )
      .at(-1);
    if (!hit) return false;
    const owner = resolveNativeMermaidOwnerForSelection(this.std.store, [
      hit,
    ])?.model;
    if (!owner) return false;
    const visual = getMermaidVisualModel(owner);
    if (
      !visual ||
      !getMermaidGfxFamilyHooks(visual)?.objectEditsViaFamilyControls
    )
      return false;
    if (this.std.store.readonly || !isNativeMermaidGfxOwner(owner)) {
      if (
        !getMermaidFamilyRuntime(visual.diagramType)?.edgelessToolbar
          ?.readonlySelection
      )
        return false;
      // Readonly still permits selecting the existing projection for readback
      // and file export. Do not enter a text editor or any model gesture.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.gfx.selection.set({ editing: false, elements: [hit.id] });
      return true;
    }
    const titleHit =
      readMermaidGfxMeta(hit, "mermaidRole") === MERMAID_GFX_TITLE_ROLE;
    const detailKey = readMermaidGfxMeta(hit, "mermaidDetailSourceKey"),
      nodeKey = readMermaidGfxMeta(hit, "mermaidNodeId"),
      edgeKey = readMermaidGfxMeta(hit, "mermaidEdgeId"),
      groupKey = readMermaidGfxMeta(hit, "mermaidSubgraphId");
    const intent: MermaidGfxObjectEditIntent | null = detailKey
      ? {
          action:
            detailsOnly &&
            getMermaidGfxFamilyHooks(visual)?.detailSelectionViaFamilyControls
              ? "select"
              : "edit",
          kind: "detail",
          id: detailKey,
          ownerId: nodeKey,
        }
      : detailsOnly && !titleHit
        ? null
        : titleHit
          ? { kind: "node", id: hit.id }
          : nodeKey
            ? { kind: "node", id: nodeKey }
            : edgeKey
              ? { kind: "edge", id: edgeKey }
              : groupKey
                ? { kind: "subgraph", id: groupKey }
                : null;
    if (!intent) return false;
    // A detail is a semantic row, not an independently draggable shape. Consume
    // the gesture before the default tool or shape editor can mutate it.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.gfx.selection.set({ editing: false, elements: [hit.id] });
    queueMicrotask(() =>
      this.std.host.dispatchEvent(
        new CustomEvent("mermaid-gfx-object-edit", { detail: intent }),
      ),
    );
    return true;
  }
  private readonly _textObservers = new Map<
    string,
    { text: MermaidObservableText; unobserve: () => void }
  >();
  private readonly _syncTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly _sourceSyncKeys = new Map<string, string>();
  private readonly _syncingOwnerIds = new Set<string>();
  private readonly _sourceProjectionQueuedOwnerIds = new Set<string>();
  private readonly _initializingOwnerIds = new Set<string>();
  private readonly _interactingOwnerIds = new Set<string>();
  private readonly _placementOnlyOwnerIds = new Set<string>();
  private readonly _sourceSyncPausedUntil = new Map<string, number>();
  private readonly _gestureVisualModelByOwnerId = new Map<
    string,
    MermaidVisualModel
  >();
  private _inlineShapeTextCommitSyncQueued = false;
  private _hadInlineShapeTextEditor = false;
  private _hasOwnerInteraction = false;
  private _inlineShapeTextEditorObserver: MutationObserver | null = null;
  private _surfaceBindingsMounted = false;
  private _projectingLocalAppearance = false;
  private _surfaceRefreshQueued = false;
  private _surfaceRefreshLocal = false;
  private _historyReadbackQueued = false;
  private readonly _historyProjectionReadbackOwnerIds = new Set<string>();

  private readonly _readDocumentHistoryProjection = (event: {
    stackItem?: MermaidHistoryStackItem;
    type?: "undo" | "redo";
    changedParentTypes: ReadonlyMap<unknown, unknown>;
  }) => {
    const selectionHistory = readMermaidSelectionHistory(event.stackItem);
    if (selectionHistory && event.type)
      carryMermaidSelectionHistory(
        this.std.store,
        selectionHistory,
        event.type,
      );
    // Source and individual-member history still need derived compartments
    // and enclosing bounds. A whole-owner geometry pop restores that bound too.
    for (const owner of this._getNativeMermaidGfxOwners())
      if (
        event.changedParentTypes.has(owner.props.source.yText) ||
        !event.changedParentTypes.has(owner.yBlock)
      )
        this._historyProjectionReadbackOwnerIds.add(owner.id);
    if (this._historyReadbackQueued) return;
    this._historyReadbackQueued = true;
    queueMicrotask(() => {
      this._historyReadbackQueued = false;
      if (!this._surfaceBindingsMounted) return;
      // Undo/redo restores authoritative Surface positions. Follow that final
      // graph with derived owner/detail bounds, without generating another
      // history entry or allowing a stale gesture baseline to overwrite it.
      for (const owner of this._getNativeMermaidGfxOwners()) {
        if (!usesTypeOwnedMermaidDocumentHistory(owner.props.diagramType))
          continue;
        this._gestureVisualModelByOwnerId.delete(owner.id);
        if (this._historyProjectionReadbackOwnerIds.has(owner.id)) {
          this._syncOwnerFromProjectionNow(owner);
        } else {
          // A geometry-only pop restores the complete native owner bound too.
          // Recomputing it from fixed Source padding/title bands loses the
          // restored scale even when every child position is correct.
          this._pauseProjectionOwnerSourceSync(owner);
          this._acceptProjectionOwnerSourceSyncKey(owner);
        }
      }
      this._historyProjectionReadbackOwnerIds.clear();
      const owner =
        selectionHistory &&
        this._getNativeMermaidGfxOwners().find(
          (owner) => owner.id === selectionHistory.ownerId,
        );
      if (owner && selectionHistory && event.type) {
        const items =
          event.type === "undo"
            ? selectionHistory.before
            : selectionHistory.after;
        const elements = items.flatMap((item) => {
          const element =
            item.kind === "node"
              ? getMermaidGfxNode(this.std.store, owner, item.editKey)
              : null;
          return element ? [element.id] : [];
        });
        this.gfx.selection.set({
          editing: false,
          elements: elements.length ? elements : [owner.id],
        });
        if (elements.length) this.std.host.focus({ preventScroll: true });
      }
    });
  };

  private _queueSurfaceRefresh(local: boolean) {
    if (this._projectingLocalAppearance) return;
    this._surfaceRefreshLocal ||= local;
    if (this._surfaceRefreshQueued) return;
    this._surfaceRefreshQueued = true;
    // A Source commit updates many compartments in one transaction. Observe
    // its finished membership and geometry once, before the next paint, rather
    // than reparsing every native owner for each intermediate property event.
    queueMicrotask(() => {
      this._surfaceRefreshQueued = false;
      const local = this._surfaceRefreshLocal;
      this._surfaceRefreshLocal = false;
      if (!this._surfaceBindingsMounted) return;
      this._projectLocalAppearance();
      this._refreshTextObservers(local);
      if (local) this._schedulePotentialOwners();
    });
  }

  private readonly _refreshOwnerTypography = () => {
    if (!this._surfaceBindingsMounted) return;
    // Font completion changes measured compartments even when Source is
    // unchanged. Reuse Source projection to fit them without relaying a
    // renderer update back as a user edit or rearranging manual positions.
    for (const owner of this._getNativeMermaidGfxOwners())
      this._queueOwnerSourceProjection(owner.id);
  };

  override mounted() {
    document.addEventListener("keydown", this._handleDocumentKeydown, true);
    document.addEventListener(
      "pointerdown",
      this._handleDocumentPointerdown,
      true,
    );
    document.addEventListener("pointerup", this._handleDocumentPointerup, true);
    document.addEventListener(
      "pointercancel",
      this._handleDocumentPointerup,
      true,
    );
    document.addEventListener(
      "dblclick",
      this._handleDocumentDoubleClick,
      true,
    );
    this._mountInlineShapeTextEditorObserver();
    const interactivity = this.std.getOptional(InteractivityIdentifier);
    if (interactivity) {
      this._disposables.add(
        interactivity.activeInteraction$.subscribe((interaction) => {
          if (interaction) {
            const interactingIds = new Set(
              interaction.elements.map((element) => element.id),
            );
            for (const owner of this._getNativeMermaidGfxOwners()) {
              if (
                !interactingIds.has(owner.id) &&
                !owner.descendantElements.some((child) =>
                  interactingIds.has(child.id),
                )
              ) {
                continue;
              }
              this._hasOwnerInteraction = true;
              this._interactingOwnerIds.add(owner.id);
              if (
                (interaction.type === "move" ||
                  interaction.type === "resize") &&
                interactingIds.has(owner.id) &&
                owner.descendantElements.every((child) =>
                  interactingIds.has(child.id),
                )
              ) {
                this._placementOnlyOwnerIds.add(owner.id);
              }
              const pendingSync = this._syncTimers.get(owner.id);
              if (pendingSync) {
                clearTimeout(pendingSync);
                this._syncTimers.delete(owner.id);
              }
            }
            return;
          }

          if (!this._hasOwnerInteraction) return;
          this._hasOwnerInteraction = false;
          const completedOwnerIds = [...this._interactingOwnerIds];
          // The interactivity manager announces completion before the final
          // view transaction has popped its temporary geometry. Read and
          // persist the owner only after that synchronous boundary. Keep the
          // owner suppressed until then so the final pop events cannot start
          // a competing source write.
          queueMicrotask(() => {
            if (!this._surfaceBindingsMounted) return;
            const owners = this._getNativeMermaidGfxOwners();
            for (const ownerId of completedOwnerIds) {
              this._interactingOwnerIds.delete(ownerId);
              const owner = owners.find(
                (candidate) => candidate.id === ownerId,
              );
              if (!owner) continue;
              if (this._placementOnlyOwnerIds.delete(ownerId)) {
                // Whole-owner placement/scale is already one native GFX
                // history entry. Replaying Source-derived inner layout here
                // would undo a resize and add a competing history write.
                this._gestureVisualModelByOwnerId.delete(ownerId);
                this._acceptProjectionOwnerSourceSyncKey(owner);
              } else {
                this._scheduleOwnerSync(owner);
              }
            }
          });
        }),
      );
    }
    this._disposables.add(
      this.std.store.slots.blockUpdated.subscribe((event) => {
        this._mountSurfaceBindings();
        if (
          event.type !== "update" ||
          event.flavour !== "myoxus:mermaid" ||
          event.props.key !== "source" ||
          this._syncingOwnerIds.has(event.id)
        ) {
          return;
        }
        this._queueOwnerSourceProjection(event.id);
      }),
    );
    this._mountSurfaceBindings();
    const undoManager = this.std.store.history.undoManager;
    undoManager.on("stack-item-popped", this._readDocumentHistoryProjection);
    this._disposables.add(() =>
      undoManager.off("stack-item-popped", this._readDocumentHistoryProjection),
    );
    document.fonts?.addEventListener(
      "loadingdone",
      this._refreshOwnerTypography,
    );
    void document.fonts?.ready.then(this._refreshOwnerTypography);
  }

  private _mountInlineShapeTextEditorObserver() {
    if (typeof MutationObserver === "undefined") return;
    this._hadInlineShapeTextEditor = hasActiveMermaidInlineTextEditor();
    this._inlineShapeTextEditorObserver = new MutationObserver(() => {
      const hasInlineShapeTextEditor = hasActiveMermaidInlineTextEditor();
      if (this._hadInlineShapeTextEditor && !hasInlineShapeTextEditor) {
        // Native Edgeless text editing can commit by removing the editor host
        // without delivering a composed key/focus event to this extension.
        // Treat that DOM transition as the authoritative commit boundary and
        // flush Mermaid metadata/source from the live owner projection.
        this._scheduleInlineShapeTextCommitSync();
      }
      this._hadInlineShapeTextEditor = hasInlineShapeTextEditor;
    });
    this._inlineShapeTextEditorObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private _replayKeyboardHistoryIntent(event: KeyboardEvent) {
    const intent = resolveMermaidKeyboardIntent({
      altKey: event.altKey,
      code: event.code,
      ctrlKey: event.ctrlKey,
      hasActiveBlockTarget: false,
      hasActiveInlineShapeTextEditor: Boolean(
        hasMermaidInlineShapeTextEditorEvent(event),
      ),
      hasEditableTarget: isEditableMermaidEdgelessHotkeyTarget(event.target),
      hasVisualSelection: false,
      key: event.key,
      metaKey: event.metaKey,
      mode: "visual",
      shiftKey: event.shiftKey,
    });
    if (intent !== "undo" && intent !== "redo") return;
    const owner = this._getActiveNativeMermaidOwner();
    if (!owner) return false;
    this.replayHistory(owner, intent);

    event.preventDefault();
    // The editor dispatcher also listens on `document`. Stopping propagation
    // alone does not suppress later listeners on that same target, which lets
    // central CRDT undo/redo replay the already handled Mermaid history entry.
    event.stopImmediatePropagation();
    return true;
  }

  /** Mouse controls and shortcuts share projection guards and the same history. */
  replayHistory(owner: MermaidBlockModel, intent: "undo" | "redo") {
    if (
      this.std.store.readonly ||
      owner.isLocked() ||
      this.std.store.getModelById(owner.id) !== owner
    )
      return false;
    const replayed =
      intent === "undo"
        ? this._replayOwnerVisualUndo(owner)
        : this._replayOwnerVisualRedo(owner);
    if (!replayed) {
      // Central GFX history restores the Surface snapshot. Hold Source readback
      // until that replay has finished, including native owner placement.
      this._pauseProjectionOwnerSourceSync(owner);
      if (intent === "undo") this.std.store.undo();
      else this.std.store.redo();
      queueMicrotask(() => {
        if (this._surfaceBindingsMounted) {
          this._acceptProjectionOwnerSourceSyncKey(owner);
        }
      });
    }

    return true;
  }

  private _mountSurfaceBindings() {
    if (this._surfaceBindingsMounted) return;
    const surface = this.gfx.surface;
    if (!surface) return;

    this._surfaceBindingsMounted = true;
    this._projectLocalAppearance();
    this._refreshTextObservers();
    for (const owner of this._getNativeMermaidGfxOwners()) {
      this._acceptProjectionOwnerSourceSyncKey(owner);
    }
    this._disposables.add(
      surface.elementAdded.subscribe(({ local }) =>
        this._queueSurfaceRefresh(local !== false),
      ),
    );
    this._disposables.add(
      surface.elementUpdated.subscribe(({ local }) =>
        this._queueSurfaceRefresh(local !== false),
      ),
    );
    this._disposables.add(
      surface.elementRemoved.subscribe(({ local }) =>
        this._queueSurfaceRefresh(local !== false),
      ),
    );
    queueMicrotask(() => {
      if (!this._surfaceBindingsMounted) return;
      for (const owner of this._getNativeMermaidGfxOwners()) {
        this._pauseProjectionOwnerSourceSync(owner);
        this.std.command.exec(ensureMermaidProjectionOwnerCommand, {
          capture: false,
          model: owner,
        });
        this._acceptProjectionOwnerSourceSyncKey(owner);
      }
      this._projectLocalAppearance();
      this._refreshTextObservers();
    });
  }

  override unmounted() {
    this._surfaceBindingsMounted = false;
    this._surfaceRefreshLocal = false;
    document.fonts?.removeEventListener(
      "loadingdone",
      this._refreshOwnerTypography,
    );
    document.removeEventListener("keydown", this._handleDocumentKeydown, true);
    document.removeEventListener(
      "pointerdown",
      this._handleDocumentPointerdown,
      true,
    );
    document.removeEventListener(
      "pointerup",
      this._handleDocumentPointerup,
      true,
    );
    document.removeEventListener(
      "pointercancel",
      this._handleDocumentPointerup,
      true,
    );
    this._objectPointerId = null;
    document.removeEventListener(
      "dblclick",
      this._handleDocumentDoubleClick,
      true,
    );
    this._cancelInlineShapeTextCommitSync();
    this._inlineShapeTextEditorObserver?.disconnect();
    this._inlineShapeTextEditorObserver = null;
    this._historyProjectionReadbackOwnerIds.clear();
    this._disposables.dispose();
    for (const observer of this._textObservers.values()) {
      observer.unobserve();
    }
    this._textObservers.clear();
    for (const timer of this._syncTimers.values()) {
      clearTimeout(timer);
    }
    this._syncTimers.clear();
    this._syncingOwnerIds.clear();
    this._sourceProjectionQueuedOwnerIds.clear();
    this._initializingOwnerIds.clear();
    this._interactingOwnerIds.clear();
    this._placementOnlyOwnerIds.clear();
    this._hasOwnerInteraction = false;
    this._gestureVisualModelByOwnerId.clear();
  }

  private _getNativeMermaidGfxOwners() {
    // Embedded owners are synchronized by their scoped host. This document-
    // wide consumer owns only native Mermaid groups directly below Surface.
    if (this.gfx.getMode() !== "edgeless") return [];
    return (this.gfx.doc.getBlocksByFlavour("myoxus:mermaid") ?? [])
      .map(({ model }) => model)
      .filter(isNativeMermaidGfxOwner);
  }

  private _queueOwnerSourceProjection(ownerId: string) {
    if (this._sourceProjectionQueuedOwnerIds.has(ownerId)) return;
    this._sourceProjectionQueuedOwnerIds.add(ownerId);
    queueMicrotask(() => {
      this._sourceProjectionQueuedOwnerIds.delete(ownerId);
      if (!this._surfaceBindingsMounted) return;
      const owner = this._getNativeMermaidGfxOwners().find(
        (candidate) => candidate.id === ownerId,
      );
      if (!owner) return;
      this._pauseProjectionOwnerSourceSync(owner);
      this.std.command.exec(ensureMermaidProjectionOwnerCommand, {
        capture: false,
        model: owner,
        preferSource: true,
      });
      this._acceptProjectionOwnerSourceSyncKey(owner);
    });
  }

  private _getActiveNativeMermaidOwner() {
    const owners = this._getNativeMermaidGfxOwners();
    if (owners.length === 0) return null;
    const selectedIds = new Set(this.gfx.selection.selectedIds);
    const selectedOwner = selectedIds.size
      ? owners.find((owner) => {
          const ownedIds = new Set([
            owner.id,
            ...owner.descendantElements.map((child) => child.id),
          ]);
          return [...selectedIds].every((id) => ownedIds.has(id));
        })
      : null;
    return selectedOwner?.isLocked() ? null : (selectedOwner ?? null);
  }

  private _captureOwnerGestureVisualModel(
    owner: MermaidBlockModel,
    replace = false,
  ) {
    if (!replace && this._gestureVisualModelByOwnerId.has(owner.id)) return;
    const visualModel = getMermaidSourceAuthoritativeVisualModel(
      this.std,
      owner,
    );
    if (visualModel) {
      this._gestureVisualModelByOwnerId.set(
        owner.id,
        cloneMermaidVisualModel(visualModel),
      );
    }
  }

  private _projectLocalAppearance(elementId?: string) {
    // Native text editing owns its temporary visibility mask and label box.
    if (
      this._projectingLocalAppearance ||
      hasActiveMermaidInlineShapeTextEditor()
    )
      return;
    this._projectingLocalAppearance = true;
    try {
      for (const owner of this._getNativeMermaidGfxOwners()) {
        if (this._syncingOwnerIds.has(owner.id)) continue;
        const visualModel = getMermaidVisualModel(owner);
        if (!visualModel) continue;
        const projection = resolveMermaidGfxProjectionOwner(owner);
        if (!projection) continue;
        const childIds = new Set(projection.childElementIds);
        if (elementId && !childIds.has(elementId)) continue;
        projectMermaidLocalGfxAppearance({
          changedElementId: elementId,
          elements: this.gfx.gfxElements.filter((element) =>
            childIds.has(element.id),
          ),
          frameXYWH: owner.xywh,
          visualModel,
        });
      }
    } finally {
      this._projectingLocalAppearance = false;
    }
  }

  private _applyOwnerVisualHistoryModel(
    owner: MermaidBlockModel,
    visualModel: MermaidVisualHistoryModel,
  ) {
    this._pauseProjectionOwnerSourceSync(owner);
    this._gestureVisualModelByOwnerId.delete(owner.id);
    this.std.store.captureSync();
    // Replay projects an existing history entry; its synchronous Surface
    // events must not become another native edit and clear the redo stack.
    // A time-based pause cannot protect a large projection transaction.
    this._syncingOwnerIds.add(owner.id);
    let result: { applied?: boolean } | undefined;
    try {
      // Native toolbar signals consume the finished projection, not every
      // intermediate connector/shape property of this same transaction.
      [, result] = batch(() =>
        this.std.command.exec(applyMermaidVisualModelCommand, {
          model: owner,
          visualModel,
          projectionOrigin: visualModel.projectionOrigin,
        }),
      );
    } finally {
      this._syncingOwnerIds.delete(owner.id);
      this._projectLocalAppearance();
      this._refreshTextObservers();
      this._acceptProjectionOwnerSourceSyncKey(owner);
    }
    if (result?.applied !== true) return false;
    const replayedProjection = resolveMermaidGfxProjectionOwner(owner);
    if (replayedProjection) {
      const validSelectionIds = new Set([
        owner.id,
        ...replayedProjection.childElementIds,
      ]);
      const hasStaleSelection = this.gfx.selection.selectedIds.some(
        (id) => !validSelectionIds.has(id),
      );
      if (hasStaleSelection) {
        this.gfx.selection.set({
          editing: false,
          elements: [owner.id],
        });
      }
    }
    this._acceptProjectionOwnerSourceSyncKey(owner);
    this.std.store.captureSync();
    return true;
  }

  private _replayOwnerVisualUndo(owner: MermaidBlockModel) {
    if (usesTypeOwnedMermaidDocumentHistory(owner.props.diagramType))
      return false;
    const current = getMermaidSourceAuthoritativeVisualModel(this.std, owner);
    const { redoStack, undoStack } = this._getOwnerVisualHistory(owner);
    const entry = takeMermaidVisualUndoEntry({
      current,
      currentSourceHash: hashMermaidSource(getMermaidBlockSource(owner.props)),
      undoStack,
    });
    if (!entry) return false;
    if (!this._applyOwnerVisualHistoryModel(owner, entry.before)) {
      undoStack.push(entry);
      return false;
    }
    entry.redoSourceHash = hashMermaidSource(
      getMermaidBlockSource(owner.props),
    );
    redoStack.push(entry);
    return true;
  }

  private _replayOwnerVisualRedo(owner: MermaidBlockModel) {
    if (usesTypeOwnedMermaidDocumentHistory(owner.props.diagramType))
      return false;
    const current = getMermaidSourceAuthoritativeVisualModel(this.std, owner);
    const { redoStack, undoStack } = this._getOwnerVisualHistory(owner);
    const entry = takeMermaidVisualRedoEntry({
      current,
      currentSourceHash: hashMermaidSource(getMermaidBlockSource(owner.props)),
      redoStack,
    });
    if (!entry) return false;
    if (!this._applyOwnerVisualHistoryModel(owner, entry.after)) {
      redoStack.push(entry);
      return false;
    }
    entry.undoSourceHash = hashMermaidSource(
      getMermaidBlockSource(owner.props),
    );
    undoStack.push(entry);
    return true;
  }

  private _refreshTextObservers(syncNewMetadata = true) {
    const nextObservedIds = new Set<string>();

    for (const owner of this._getNativeMermaidGfxOwners()) {
      const projection = resolveMermaidGfxProjectionOwner(owner);
      if (!projection) continue;
      for (const childId of projection.childElementIds) {
        const child = projection.getElementById(childId) as {
          id?: string;
          text?: unknown;
          yMap?: {
            get?: (key: string) => unknown;
            set?: (key: string, value: unknown) => void;
          };
        } | null;
        const text = child?.text;
        if (!isMermaidObservableText(text) || !child?.id) continue;
        nextObservedIds.add(child.id);
        const existing = this._textObservers.get(child.id);
        if (existing?.text === text) continue;
        if (syncNewMetadata) this._syncTextMetadata(child, text, owner);
        existing?.unobserve();
        const observer = (
          _event: unknown,
          transaction: { local?: boolean } | undefined,
        ) => {
          if (
            transaction?.local === false ||
            hasActiveMermaidInlineShapeTextEditor()
          ) {
            return;
          }
          this._syncTextMetadata(child, text, owner);
          this._scheduleOwnerSync(owner);
        };
        text.observe(observer);
        this._textObservers.set(child.id, {
          text,
          unobserve: () => text.unobserve(observer),
        });
      }
    }

    for (const [id, observer] of this._textObservers) {
      if (nextObservedIds.has(id)) continue;
      observer.unobserve();
      this._textObservers.delete(id);
    }
  }

  private _scheduleInlineShapeTextCommitSync() {
    if (this._inlineShapeTextCommitSyncQueued) return;
    this._inlineShapeTextCommitSyncQueued = true;
    queueMicrotask(() => {
      if (!this._inlineShapeTextCommitSyncQueued) return;
      this._inlineShapeTextCommitSyncQueued = false;
      this._flushInlineShapeTextCommitSync();
    });
  }

  private _cancelInlineShapeTextCommitSync() {
    this._inlineShapeTextCommitSyncQueued = false;
  }

  private _flushInlineShapeTextCommitSync() {
    // Native shape editors can close before their Y.Text observer pipeline has
    // settled. Re-read the live owner once after the current editor event so
    // one visible edit wins the next source projection and creates exactly one
    // Mermaid source/history transaction.
    this._refreshTextObservers();
    // Refresh deferred label boxes against any text-editor geometry before
    // Source sync classifies the appearance; the authored Y.Text stays intact.
    this._projectLocalAppearance();
    for (const owner of this._getNativeMermaidGfxOwners()) {
      this._syncOwnerTextMetadata(owner);
      this._syncOwnerFromProjectionNow(owner);
    }
  }

  private _syncOwnerTextMetadata(owner: MermaidBlockModel) {
    const projection = resolveMermaidGfxProjectionOwner(owner);
    if (!projection) return;
    for (const childId of projection.childElementIds) {
      const child = projection.getElementById(childId) as {
        id?: string;
        props?: Record<string, unknown>;
        text?: unknown;
        yMap?: {
          get?: (key: string) => unknown;
          set?: (key: string, value: unknown) => void;
        };
      } | null;
      if (!child) continue;
      const text = child?.text;
      if (!isMermaidTextLike(text)) continue;
      this._syncTextMetadata(child, text, owner, "immediate");
    }
  }

  private _syncTextMetadata(
    child: {
      id?: string;
      props?: Record<string, unknown>;
      text?: unknown;
      yMap?: {
        get?: (key: string) => unknown;
        set?: (key: string, value: unknown) => void;
      };
    },
    text: { toString: () => string },
    owner: MermaidBlockModel,
    timing: "async" | "immediate" = "async",
  ) {
    if (!isMermaidGfxNodeModel(child) || !child.yMap?.set) return;
    const sync = () => {
      const currentText = isMermaidTextLike(child.text) ? child.text : text;
      const visibleText = currentText.toString();
      const changed = syncMermaidGfxNodeLabelsFromVisibleText(
        child,
        visibleText,
      );
      // Keep Mermaid metadata live while typing, but leave Mermaid source
      // writes to the native editor close boundary. Source writes during
      // RichText composition can remount the projection and truncate the
      // user's label to the first observed character.
      if (changed && child.id && !hasActiveMermaidInlineShapeTextEditor()) {
        this._scheduleOwnerSync(owner);
      }
    };
    if (timing === "immediate") sync();
    else setTimeout(sync, 0);
  }

  private _schedulePotentialOwners() {
    for (const owner of this._getNativeMermaidGfxOwners()) {
      const projection = resolveMermaidGfxProjectionOwner(owner);
      if (!projection) continue;
      this._scheduleOwnerSync(owner);
    }
  }

  private _scheduleOwnerSync(owner: MermaidBlockModel) {
    if (
      hasActiveMermaidInlineShapeTextEditor() ||
      this._syncingOwnerIds.has(owner.id) ||
      this._interactingOwnerIds.has(owner.id)
    ) {
      return;
    }
    const nextKey = this._getOwnerSourceSyncKey(owner);
    if (
      !this._sourceSyncKeys.has(owner.id) ||
      this._initializingOwnerIds.has(owner.id)
    ) {
      // The first surface event after entering Edgeless is emitted while the
      // source application projects authoritative data into the owner.
      // Debounce that projection into this document owner's baseline; treating
      // any of its intermediate surface events as a native user edit races the
      // mounting block host and writes transient visual hashes for the same
      // source.
      this._initializingOwnerIds.add(owner.id);
      if (nextKey) this._sourceSyncKeys.set(owner.id, nextKey);
      const existing = this._syncTimers.get(owner.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this._syncTimers.delete(owner.id);
        this._initializingOwnerIds.delete(owner.id);
        this._acceptProjectionOwnerSourceSyncKey(owner);
      }, MERMAID_OWNER_SOURCE_SYNC_DELAY_MS);
      this._syncTimers.set(owner.id, timer);
      return;
    }
    if (
      !shouldScheduleMermaidOwnerSourceSync({
        currentKey: this._sourceSyncKeys.get(owner.id) ?? "",
        inEdgeless: true,
        isReadonly: this.std.store.readonly,
        mode: "visual",
        nextKey,
        now: performance.now(),
        pausedUntil: this._sourceSyncPausedUntil.get(owner.id) ?? 0,
      })
    ) {
      return;
    }
    this._sourceSyncKeys.set(owner.id, nextKey);

    const existing = this._syncTimers.get(owner.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._syncTimers.delete(owner.id);
      this._syncOwnerFromProjectionNow(owner);
    }, MERMAID_OWNER_SOURCE_SYNC_DELAY_MS);
    this._syncTimers.set(owner.id, timer);
  }

  private _syncOwnerFromProjectionNow(owner: MermaidBlockModel) {
    if (hasActiveMermaidInlineShapeTextEditor()) return;
    if (
      !resolveMermaidSourceLifecycle(getMermaidBlockSource(owner.props))
        .canReconcileProjection
    ) {
      return;
    }
    if (
      !canMutateMermaidGfxOwnerSource({
        lastValidSource: owner.props.lastValidSource,
        parent: owner.store.getParent(owner.id),
        source: getMermaidBlockSource(owner.props),
      })
    ) {
      return;
    }
    if (this.std.store.getBlock(owner.id)?.model !== owner) {
      this._sourceSyncKeys.delete(owner.id);
      this._sourceSyncPausedUntil.delete(owner.id);
      this._initializingOwnerIds.delete(owner.id);
      this._gestureVisualModelByOwnerId.delete(owner.id);
      return;
    }
    // A native GFX event can be the reason sourceHash is currently stale.
    // Edgeless must still sync from the live owner so the block source
    // and visual-history stack catch up before the next keyboard undo/redo.
    const resolution = resolveMermaidSourceLifecycle(
      getMermaidBlockSource(owner.props),
    ).resolution;
    const transaction = beginMermaidRuntimeTransaction({
      currentSource: getMermaidBlockSource(owner.props),
      currentVisualModel: this._gestureVisualModelByOwnerId.get(owner.id),
      readonly: this.std.store.readonly,
      options: {
        preserveSourceBytes: mermaidRuntimePreservesSourceBytes(
          resolution.runtime,
          resolution.diagramType,
        ),
      },
    });
    if (!transaction) return;
    this._syncingOwnerIds.add(owner.id);
    let result: { synced?: boolean; visualsReprojected?: boolean } | undefined;
    try {
      const execution = batch(() =>
        this.std.command.exec(
          syncMermaidVisualModelFromProjectionOwnerCommand,
          {
            model: owner,
            gestureBefore: transaction.beforeVisualModel,
          },
        ),
      );
      result = execution[1];
    } finally {
      // Reconciliation writes shape/connector props synchronously. Ignore
      // those derived surface events while the command is active; otherwise
      // they enqueue another owner sync before the final key can be accepted.
      this._syncingOwnerIds.delete(owner.id);
      this._projectLocalAppearance();
    }
    if (!result) {
      this._gestureVisualModelByOwnerId.delete(owner.id);
      return;
    }
    // A resize can first refresh its label box/ancestor bounds without a
    // Source change. Its completed projection still belongs to the captured
    // gesture, so Undo must restore those bounds with the native node.
    if (!result.synced && !result.visualsReprojected) {
      this._acceptProjectionOwnerSourceSyncKey(owner);
      this._gestureVisualModelByOwnerId.delete(owner.id);
      return;
    }
    const sourceAfter = getMermaidBlockSource(owner.props);
    commitMermaidRuntimeTransaction({
      applied: true,
      currentSource: sourceAfter,
      currentVisualModel: getMermaidSourceAuthoritativeVisualModel(
        this.std,
        owner,
      ),
      owner,
      transaction,
    });
    this._gestureVisualModelByOwnerId.delete(owner.id);
    this._acceptProjectionOwnerSourceSyncKey(owner);
  }

  private _getOwnerSourceSyncKey(owner: MermaidBlockModel) {
    return createMermaidProjectionOwnerSourceSyncKey(
      owner,
      resolveMermaidGfxProjection(owner),
    );
  }

  private _acceptProjectionOwnerSourceSyncKey(owner: MermaidBlockModel) {
    const key = this._getOwnerSourceSyncKey(owner);
    if (key) this._sourceSyncKeys.set(owner.id, key);
    else this._sourceSyncKeys.delete(owner.id);
  }

  private _pauseProjectionOwnerSourceSync(owner: MermaidBlockModel) {
    this._sourceSyncPausedUntil.set(
      owner.id,
      nextMermaidOwnerSourceSyncPauseUntil(performance.now()),
    );
    const existing = this._syncTimers.get(owner.id);
    if (existing) {
      clearTimeout(existing);
      this._syncTimers.delete(owner.id);
    }
  }

  private _getOwnerVisualHistory(owner: MermaidBlockModel) {
    return getMermaidVisualHistoryStacks(owner);
  }
}
