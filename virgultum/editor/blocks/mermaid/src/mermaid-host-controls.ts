import {
  readMermaidSelectionHistory,
  carryMermaidSelectionHistory,
} from "./mermaid-selection-history.js";
import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { typeOwnedMermaidGeometrySelection } from "./families/runtime/gfx-owner-hooks.js";
import { usesTypeOwnedMermaidDocumentHistory } from "./families/runtime/gfx-owner-hooks.js";
import { BlockSelection } from "@virgultum/std";
import {
  consumeMyoxusEditorEscape,
  hasMyoxusEditorLocalKeyboardTarget,
  hasOpenMyoxusUiOverlay,
  wasMyoxusEditorEscapeConsumed,
} from "@virgultum/shared/utils";

import { applyMermaidVisualModelCommand } from "./commands.js";

import {
  findMermaidEditableEventTarget,
  hasActiveMermaidInlineTextEditor,
  type MermaidSourceEditIntent,
  shouldPreventMermaidEditableFocusDefault,
  shouldRefocusMermaidEditableTarget,
} from "./mermaid-editor-events.js";

import {
  resolveMermaidKeyboardIntent,
  shouldReadMermaidKeyboardSelection,
} from "./mermaid-keyboard.js";
import { resolveMermaidPageZoomStep } from "./mermaid-page-viewport-state.js";

import {
  type MermaidSourceControlChange,
  resolveMermaidBlankSourceControl,
} from "./mermaid-source-controls.js";

import {
  takeMermaidVisualRedoEntry,
  takeMermaidVisualUndoEntry,
} from "./mermaid-visual-source-history.js";

import {
  coerceMermaidBlockText,
  getMermaidBlockSource,
  hashMermaidSource,
} from "./utils.js";
import { detectMermaidDiagramType } from "./engine/diagram-types.js";
import { isMermaidProductDiagramType } from "./engine/product-types.js";
import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "./engine/diagram-title.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { validateMermaidPageSelectionContainerAction } from "./families/runtime/contracts.js";

import { MermaidHostSource } from "./mermaid-host-source.js";
import { MermaidHostState } from "./mermaid-host-state.js";

export abstract class MermaidHostControls extends MermaidHostSource {
  private _isPageVisualWorkareaKeyboardTarget(event: KeyboardEvent) {
    const path = event.composedPath();
    if (
      path.some(
        (target) =>
          target instanceof Element &&
          (target.matches(".myoxus-mermaid-gfx-viewport") ||
            target.matches(".myoxus-mermaid-gfx-object-focus-proxy")),
      )
    ) {
      return true;
    }
    const active = document.activeElement;
    return Boolean(
      active instanceof Element &&
      this.renderRoot
        .querySelector(".myoxus-mermaid-gfx-viewport")
        ?.contains(active),
    );
  }

  protected _handleSelect = (event?: Event) => {
    MermaidHostState.activeKeyboardBlock = this;
    this.selection.set([
      this.selection.create(BlockSelection, {
        blockId: this.blockId,
      }),
    ]);
    if (event && this._getEditableEventTarget(event)) return;
    this.focus({ preventScroll: true });
  };

  protected _activateKeyboardTarget() {
    MermaidHostState.activeKeyboardBlock = this;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      this.contains(active) &&
      (active instanceof HTMLInputElement ||
        active instanceof HTMLSelectElement ||
        active instanceof HTMLTextAreaElement)
    ) {
      active.blur();
    }
    this.focus({ preventScroll: true });
  }

  protected _activateEmbeddedGfxEditor() {
    if (!this._isInEdgelessMode()) return;
    if (this.store.readonly) {
      if (!this._canExploreReadonly()) return;
      const note = this.store.getParent(this.model.id);
      if (note?.flavour !== "myoxus:note") return;
      // Reading owns local selection only. Readonly Store/command guards and
      // the Note's non-editable content remain authoritative for all writes.
      const selection = this.std.get(GfxControllerIdentifier).selection;
      if (!selection.has(note.id) || !selection.editing)
        selection.set({ elements: [note.id], editing: true });
    }
    if (
      !this._isInEdgelessMode() ||
      !this._canConsumeScopedGfxEvent() ||
      this.selected$.value
    ) {
      return;
    }
    this._claimKeyboardOwner();
    this.selection.setGroup("note", [
      this.selection.create(BlockSelection, { blockId: this.blockId }),
    ]);
  }

  protected _handleBlockKeydown(event: KeyboardEvent) {
    if (
      ["Delete", "Backspace", "Escape"].includes(event.key) &&
      hasMyoxusEditorLocalKeyboardTarget(event)
    )
      return;
    const editableTarget = this._getEditableEventTarget(event);
    const isClosedPopupTrigger = Boolean(
      editableTarget instanceof HTMLElement &&
      editableTarget.hasAttribute("aria-haspopup") &&
      editableTarget.getAttribute("aria-expanded") === "false",
    );
    const normalizedKey = event.key.toLowerCase();
    const isMermaidHistoryShortcut = Boolean(
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      (normalizedKey === "z" || normalizedKey === "y"),
    );
    // A dismissed menu returns focus to its trigger. That closed trigger still
    // owns Enter/Arrow navigation, but it no longer owns Escape or the active
    // Mermaid owner's history shortcuts.
    const hasEditableTarget = Boolean(
      editableTarget &&
      !(
        isClosedPopupTrigger &&
        (event.key === "Escape" || isMermaidHistoryShortcut)
      ),
    );
    const hasPageVisualWorkareaTarget =
      this._isPageVisualWorkareaKeyboardTarget(event);
    const hasActiveBlockTarget =
      event.composedPath().includes(this) ||
      (document.activeElement instanceof Node &&
        this.contains(document.activeElement)) ||
      // Embedded actions are rendered through the React host and can return
      // focus to a portal trigger outside this custom element. The selected
      // Mermaid block inside the editing Note remains the keyboard owner; DOM
      // containment must not make the next local Escape skip that owner.
      this._isActiveEmbeddedGfxEditor();
    const consumeEscape = () => {
      consumeMyoxusEditorEscape(event);
      event.preventDefault();
      event.stopPropagation();
    };
    if (
      event.key === "Escape" &&
      this._isInEdgelessMode() &&
      hasOpenMyoxusUiOverlay(event)
    ) {
      return;
    }
    const objectProxy = event
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement &&
          target.matches(".myoxus-mermaid-gfx-object-focus-proxy"),
      );
    const familyInput = event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          this.contains(target) &&
          target.matches(
            'input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="dialog"],[role="menu"],button:not(.myoxus-mermaid-gfx-object-focus-proxy)',
          ),
      );
    if (
      hasPageVisualWorkareaTarget &&
      (!this._isInEdgelessMode() || this._isActiveEmbeddedGfxEditor()) &&
      !familyInput &&
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !hasOpenMyoxusUiOverlay(event)
    ) {
      this._hydrateVisualSelectionFromScopedGfxSelection();
      const items = this._visualSelection.items;
      const key =
        objectProxy?.dataset.mermaidEditKey ??
        (items.length === 1 && items[0].kind === "node"
          ? items[0].editKey
          : null);
      const visual = this._getMermaidVisualModelForEditing();
      const intent =
        visual &&
        key &&
        getMermaidGfxFamilyHooks(visual)?.nodeKeyboardIntent?.(
          visual,
          key,
          event.key,
        );
      if (intent && (intent.action === "select" || !this.store.readonly)) {
        if (intent.action === "select") {
          this._selectVisualNode(intent.id);
          // Navigation reuses a mounted carrier; structural projection queues
          // would leave a rapid next key on the previous focused node.
          Array.from(
            this.renderRoot.querySelectorAll<HTMLElement>(
              ".myoxus-mermaid-gfx-object-focus-proxy",
            ),
          )
            .find((proxy) => proxy.dataset.mermaidEditKey === intent.id)
            ?.focus({ preventScroll: true });
        } else if (!this._consumeVisualObjectIntent(intent)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    if (
      this._pageSelectionEnabled &&
      hasPageVisualWorkareaTarget &&
      !hasEditableTarget &&
      event.key === "Tab"
    ) {
      // Keep the Page editor's block keymap from consuming native traversal
      // between the scoped workarea and its per-node focus proxies.
      event.stopPropagation();
      return;
    }
    if (
      this._pageSelectionEnabled &&
      hasPageVisualWorkareaTarget &&
      !hasEditableTarget &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ["c", "v", "x"].includes(normalizedKey) &&
      this._visualSelection.items.length > 0
    ) {
      if (
        !getMermaidGfxFamilyHooks(this._getMermaidVisualModelForEditing())
          ?.semanticClipboard
      )
        event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      this._pageSelectionEnabled &&
      hasActiveBlockTarget &&
      !hasEditableTarget &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      normalizedKey === "d" &&
      this._visualSelectionKeys("node").length > 0
    ) {
      event.preventDefault();
      event.stopPropagation();
      this._duplicateSelectedVisualNodes();
      return;
    }
    if (
      this._pageSelectionEnabled &&
      hasActiveBlockTarget &&
      !hasEditableTarget &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      normalizedKey === "g"
    ) {
      const visualModel = this._getMermaidVisualModelForEditing();
      const action = visualModel
        ? getMermaidFamilyRuntime(visualModel.diagramType)?.pageSelectionTools
            ?.containerAction
        : null;
      if (
        !visualModel ||
        !action ||
        !validateMermaidPageSelectionContainerAction(
          action,
          this._visualSelection.items,
          visualModel,
        ).valid
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this._handleAddVisualSubgraph();
      return;
    }
    if (
      this._pageSelectionEnabled &&
      hasPageVisualWorkareaTarget &&
      !hasEditableTarget &&
      // Resize and connector buttons own their arrow keys at the target.
      // Window capture must not translate the selection before they run.
      !familyInput &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key) &&
      this._visualSelectionKeys("node").length > 0
    ) {
      const visual = this._getMermaidVisualModelForEditing();
      if (
        visual &&
        !typeOwnedMermaidGeometrySelection(
          visual,
          this._visualSelectionKeys("node"),
        ).length
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      this._moveSelectedVisualNode(
        event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0,
        event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
      );
      return;
    }
    if (
      event.key === "Escape" &&
      this._gfxSession.hasTransientConnectionPreview
    ) {
      consumeEscape();
      this._stopTransientPointerInteractions();
      return;
    }
    if (
      event.key === "Escape" &&
      hasActiveBlockTarget &&
      !hasEditableTarget &&
      this._pendingVisualInsertShape
    ) {
      consumeEscape();
      this._pendingVisualInsertShape = null;
      this._pendingVisualNodePlacement = null;
      this._stopTransientPointerInteractions();
      this.requestUpdate();
      this.focus({ preventScroll: true });
      return;
    }
    if (
      event.key === "Escape" &&
      !hasEditableTarget &&
      (this._pageSelectionState.tool === "box" ||
        this._pageSelectionState.gestureActive)
    ) {
      consumeEscape();
      this._cancelPageSelectionMode();
      this.focus({ preventScroll: true });
      return;
    }
    if (
      event.key.toLowerCase() === "a" &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      this._pageSelectionEnabled &&
      hasPageVisualWorkareaTarget &&
      !hasEditableTarget
    ) {
      event.preventDefault();
      event.stopPropagation();
      this._selectAllPageVisualNodes();
      return;
    }
    if (
      event.key === "Escape" &&
      this._gfxViewportInteraction.cancelVisualNodeDrag()
    ) {
      consumeEscape();
      return;
    }
    if (
      event.key === "Escape" &&
      this._pageSelectionEnabled &&
      hasActiveBlockTarget &&
      !hasEditableTarget &&
      (this._hydrateVisualSelectionFromScopedGfxSelection() ||
        this._visualSelection.items.length > 0)
    ) {
      consumeEscape();
      this._clearPageVisualSelectionFromKeyboard();
      if (this._isInEdgelessMode()) {
        // A portal action can retain focus after its menu closes. Once the
        // inner selection is cleared, return focus to the existing Mermaid
        // keyboard target so the next Escape can reach the surrounding Note.
        this._activateKeyboardTarget();
      }
      return;
    }
    if (
      event.key === "Escape" &&
      !hasEditableTarget &&
      this._isActiveEmbeddedGfxEditor()
    ) {
      // This host listens on Window capture so it runs before a React/Facade
      // editor can cancel its active pointer or keyboard gesture. Defer the
      // outer Edgeless exit until the same native event has traversed every
      // capture listener. A microtask is too early here: the browser performs a
      // checkpoint between listeners registered by different component owners.
      setTimeout(() => {
        if (wasMyoxusEditorEscapeConsumed(event)) return;
        if (!this._exitEmbeddedGfxEditor()) return;
        consumeMyoxusEditorEscape(event);
        event.preventDefault();
      }, 0);
      return;
    }
    const keyboardInput = {
      altKey: event.altKey,
      code: event.code,
      ctrlKey: event.ctrlKey,
      hasActiveBlockTarget,
      hasActiveInlineShapeTextEditor:
        typeof this._hasActiveInlineShapeTextEditor === "function" &&
        this._hasActiveInlineShapeTextEditor(),
      hasEditableTarget,
      key: event.key,
      metaKey: event.metaKey,
      // Embedded Edgeless has no Page mode switch and always exposes the
      // active Mermaid child as Visual. A Page-persisted View mode must not
      // silently disable the child's history and selection shortcuts.
      mode: this._isActiveEmbeddedGfxEditor() ? "visual" : this._getShellMode(),
      shiftKey: event.shiftKey,
    } as const;
    const shouldReadVisualSelection =
      shouldReadMermaidKeyboardSelection(keyboardInput);
    const hydratedVisualSelection = shouldReadVisualSelection
      ? this._hydrateVisualSelectionFromScopedGfxSelection()
      : false;
    const focused = this._keyboardFocusedVisualItem;
    const focusedSelectionChanged = Boolean(
      shouldReadVisualSelection &&
      (event.key === "Delete" || event.key === "Backspace") &&
      focused &&
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element &&
            target.matches(".myoxus-mermaid-gfx-object-focus-proxy"),
        ) &&
      !this._visualSelection.items.some(
        (item) =>
          item.kind === focused.kind && item.editKey === focused.editKey,
      ),
    );
    if (focusedSelectionChanged && focused) {
      // Window capture runs before family controls. A newly focused object
      // owns Delete; focusing an already selected member retains the group.
      if (focused.kind === "node") this._selectVisualNode(focused.editKey);
      else if (focused.kind === "edge") this._selectVisualEdge(focused.editKey);
      else this._selectVisualSubgraph(focused.editKey);
      this._projectVisualSelectionToScopedGfx();
    }
    const hasVisualSelection =
      shouldReadVisualSelection &&
      Boolean(
        hydratedVisualSelection ||
        this._hasFamilySelectionAction() ||
        this._visualSelection.items.length > 0,
      );
    const intent = resolveMermaidKeyboardIntent({
      ...keyboardInput,
      hasVisualSelection,
    });

    if (intent === "ignore") return;

    if (
      intent === "zoom-in" ||
      intent === "zoom-out" ||
      intent === "zoom-reset"
    ) {
      if (this._isInEdgelessMode()) return;
      event.preventDefault();
      event.stopPropagation();
      this._changePageZoom({
        anchor: { type: "center" },
        source: "keyboard",
        zoom:
          intent === "zoom-reset"
            ? 100
            : resolveMermaidPageZoomStep(
                this._pageViewportState.zoom,
                this._pageViewportState.resolvedScales.visual,
                {
                  direction: intent === "zoom-in" ? 1 : -1,
                  type: "step",
                },
              ),
      });
      return;
    }

    if (this.store.readonly) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (intent === "delete-selection") {
      if (focusedSelectionChanged) {
        // A rendered action callback still describes the former selection.
        // The object intent consumes this new selection and records its focus.
        this._handleDeleteVisualSelection();
        return;
      }
      if (this._handlePageSelectionAction()) {
        return;
      }
      if (this._hasFamilySelectionAction()) {
        this._handleFamilySelectionAction();
      } else {
        this._handleDeleteVisualSelection();
      }
      return;
    }

    if (intent === "undo") {
      this._handleUndo();
      return;
    }

    if (intent === "redo") {
      this._handleRedo();
    }
  }

  private _restoreEmbeddedHistoryScope(wasActive: boolean) {
    if (!wasActive || !this.isConnected || !this._isInEdgelessMode()) return;
    const note = this.store.getParent(this.model.id);
    if (note?.flavour !== "myoxus:note") return;
    // Document history may restore a Page-era selection. The invoking embedded
    // editor still owns this journey, including Undo to an empty source tree.
    this.std
      .get(GfxControllerIdentifier)
      .selection.set({ elements: [note.id], editing: true });
    this._activateEmbeddedGfxEditor();
  }

  private _captureHistoryFocus() {
    const item = this._keyboardFocusedVisualItem;
    const focused = document.activeElement;
    const owned =
      item &&
      focused instanceof HTMLElement &&
      focused.matches(".myoxus-mermaid-gfx-object-focus-proxy") &&
      focused.dataset.mermaidEditKey === item.editKey &&
      this._visualSelection.anchor?.editKey === item.editKey &&
      this._visualSelection.anchor.kind === item.kind &&
      this.renderRoot.contains(focused);
    return () => {
      this._activateKeyboardTarget();
      // Projection-only history has no Source text event to queue its carrier.
      if (owned && !this._pendingVisualSelectionProjection) {
        this._queueVisualSelectionForProjection([item], { focus: true });
        this.requestUpdate();
      }
    };
  }

  protected _handleUndo = () => {
    if (this.store.readonly) return;
    const embeddedWasActive = this._isActiveEmbeddedGfxEditor();
    const restoreFocus = this._captureHistoryFocus();
    const selectionHistory = readMermaidSelectionHistory(
      this.store.history.undoManager.undoStack.at(-1),
    );
    this._clearPendingVisualSelectionProjection();
    this._stopTransientPointerInteractions();
    this._transitionPageSelection({ type: "end-gesture" });
    if (this._replayVisualUndoFallback()) return;
    if (!this.store.canUndo) return;
    this._pauseProjectionOwnerSourceSync();
    this.store.undo();
    this._reconcileProjectionOwnerFromSourceAfterHistory();
    this._restoreEmbeddedHistoryScope(embeddedWasActive);
    // Central history can clear the ephemeral BlockSelection of an embedded
    // diagram. Keep the invoking Mermaid host as keyboard owner so the next
    // Redo is not intercepted by the surrounding Edgeless editor.
    if (selectionHistory?.ownerId === this.model.id) {
      carryMermaidSelectionHistory(this.store, selectionHistory, "undo");
      this._queueVisualSelectionForProjection(selectionHistory.before, {
        focus: selectionHistory.before.length > 0,
      });
      this.requestUpdate();
    }
    restoreFocus();
  };

  protected _handleRedo = () => {
    if (this.store.readonly) return;
    const embeddedWasActive = this._isActiveEmbeddedGfxEditor();
    const restoreFocus = this._captureHistoryFocus();
    const selectionHistory = readMermaidSelectionHistory(
      this.store.history.undoManager.redoStack.at(-1),
    );
    this._clearPendingVisualSelectionProjection();
    this._stopTransientPointerInteractions();
    this._transitionPageSelection({ type: "end-gesture" });
    if (this._replayVisualRedoFallback()) return;
    if (!this.store.canRedo) return;
    this._pauseProjectionOwnerSourceSync();
    this.store.redo();
    this._reconcileProjectionOwnerFromSourceAfterHistory();
    this._restoreEmbeddedHistoryScope(embeddedWasActive);
    if (selectionHistory?.ownerId === this.model.id) {
      carryMermaidSelectionHistory(this.store, selectionHistory, "redo");
      this._queueVisualSelectionForProjection(selectionHistory.after, {
        focus: selectionHistory.after.length > 0,
      });
      this.requestUpdate();
    }
    restoreFocus();
  };

  protected _replayVisualUndoFallback() {
    if (usesTypeOwnedMermaidDocumentHistory(this.model.props.diagramType))
      return false;
    const current = this._getMermaidVisualModelForEditing();
    const entry = takeMermaidVisualUndoEntry({
      current,
      currentSourceHash: hashMermaidSource(
        getMermaidBlockSource(this.model.props),
      ),
      undoStack: this._visualUndoStack,
    });
    if (!entry) return false;

    this._pauseProjectionOwnerSourceSync();
    const [, result] = this.std.command.exec(applyMermaidVisualModelCommand, {
      model: this.model,
      visualModel: entry.before,
      projectionOrigin: entry.before.projectionOrigin,
    });
    if (result?.applied !== true) {
      this._visualUndoStack.push(entry);
      return false;
    }
    entry.redoSourceHash = hashMermaidSource(
      getMermaidBlockSource(this.model.props),
    );
    this._visualRedoStack.push(entry);
    this._acceptProjectionOwnerSourceSyncKey();
    this._remapVisualSelection();
    this._scheduleRender();
    this.requestUpdate();
    return true;
  }

  protected _replayVisualRedoFallback() {
    if (usesTypeOwnedMermaidDocumentHistory(this.model.props.diagramType))
      return false;
    const current = this._getMermaidVisualModelForEditing();
    const entry = takeMermaidVisualRedoEntry({
      current,
      currentSourceHash: hashMermaidSource(
        getMermaidBlockSource(this.model.props),
      ),
      redoStack: this._visualRedoStack,
    });
    if (!entry) return false;

    this._pauseProjectionOwnerSourceSync();
    const [, result] = this.std.command.exec(applyMermaidVisualModelCommand, {
      model: this.model,
      visualModel: entry.after,
      projectionOrigin: entry.after.projectionOrigin,
    });
    if (result?.applied !== true) {
      this._visualRedoStack.push(entry);
      return false;
    }
    entry.undoSourceHash = hashMermaidSource(
      getMermaidBlockSource(this.model.props),
    );
    this._visualUndoStack.push(entry);
    this._acceptProjectionOwnerSourceSyncKey();
    this._remapVisualSelection();
    this._scheduleRender();
    this.requestUpdate();
    return true;
  }

  /** Standard Edgeless headers share the Page title's source/history transaction. */
  editDiagramTitle(value: string) {
    this._handleTitleChange(value);
  }

  protected _handleTitleChange = (value: string) => {
    if (this.store.readonly) return;
    const source = getMermaidBlockSource(this.model.props);
    const diagramType = detectMermaidDiagramType(source);
    if (!isMermaidProductDiagramType(diagramType)) return;
    const runtime = getMermaidFamilyRuntime(diagramType);
    const title = value.trim();
    if (!title) return;
    const current = resolveMermaidDiagramTitle({
      diagramType,
      familyTitle: runtime?.diagramTitle,
      legacyTitle: coerceMermaidBlockText(this.model.props.title),
      source,
    });
    if (current.value === title) return;
    const nextSource = writeMermaidDiagramTitle({
      diagramType,
      familyTitle: runtime?.diagramTitle,
      source,
      title,
    });
    if (!nextSource || nextSource === source) return;
    this._setSourceFromControl(nextSource, { preserveSourceBytes: true });
  };

  protected _handleSourceEdit = (intent: MermaidSourceEditIntent) => {
    if (this.store.readonly) return;
    // Source-first states can expose the source editor while the last explicit
    // shell mode is still visual. Retain source mode before the first valid
    // intermediate value can make the visual editor available again.
    this._mode = "source";
    this._setSourceFromControl(intent.source, { preserveSourceBytes: true });
  };

  protected _getEditableEventTarget(event: Event) {
    return findMermaidEditableEventTarget(event);
  }

  protected _hasActiveInlineShapeTextEditor() {
    return (
      this._inlineShapeTextEditor.hasActiveEditor() ||
      this._inlineConnectorLabelEditor.hasActiveEditor() ||
      hasActiveMermaidInlineTextEditor()
    );
  }

  protected readonly _stopEditorEvent = (event: Event) => {
    const target = this._getEditableEventTarget(event);
    if (
      target &&
      shouldRefocusMermaidEditableTarget({
        eventType: event.type,
        target,
      })
    ) {
      if (
        shouldPreventMermaidEditableFocusDefault({
          isCancelable: event.cancelable,
          target,
        })
      ) {
        event.preventDefault();
      }
      const focusTarget = () => target.focus({ preventScroll: true });
      focusTarget();
      queueMicrotask(focusTarget);
      requestAnimationFrame(focusTarget);
      setTimeout(focusTarget, 0);
    }
    event.stopPropagation();
  };

  protected _handleBlankDiagram = () => {
    this._applySourceControlChange(resolveMermaidBlankSourceControl());
  };

  protected _applySourceControlChange(
    change: MermaidSourceControlChange | null,
  ) {
    if (!change) return;
    this._setSourceFromControl(change.source, {
      templateId: change.templateId,
    });
  }

  protected _handleImportClick = () => {
    if (this.store.readonly) return;
    this.renderRoot
      .querySelector<HTMLInputElement>(".myoxus-mermaid-file-input")
      ?.click();
  };

  protected _handleFileImport = async (event: Event) => {
    event.stopPropagation();
    if (this.store.readonly) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this._setSourceFromControl(await file.text());
  };

  protected _handlePasteSource = async () => {
    if (this.store.readonly || !navigator.clipboard) return;
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return;
    this._setSourceFromControl(text);
  };
}
