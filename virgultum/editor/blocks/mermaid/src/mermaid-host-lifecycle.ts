import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { type PropertyValues } from "lit";

import { MermaidHostState } from "./mermaid-host-state.js";
import { reconcileMermaidTitleProjectionFromSource } from "./mermaid-title-projection.js";
import { MermaidOwnerMigrationExtension } from "./presentation/mermaid-owner-migration-extension.js";
import { getMermaidBlockSource } from "./utils.js";
import { subscribeMermaidNativeValidation } from "./families/runtime/native-validation.js";

export abstract class MermaidHostLifecycle extends MermaidHostState {
  private _observedSource = "";
  private _themeProjectionObserver: MutationObserver | null = null;
  private _themeProjectionRefreshQueued = false;

  private readonly _handleThemeProjectionChange = () => {
    if (this._themeProjectionRefreshQueued) return;
    this._themeProjectionRefreshQueued = true;
    queueMicrotask(() => {
      this._themeProjectionRefreshQueued = false;
      if (!this.isConnected) return;
      this.store.get(MermaidOwnerMigrationExtension).migrate();
      this._pauseProjectionOwnerSourceSync();
      this._ensureProjectionOwner(false, true);
      this._acceptProjectionOwnerSourceSyncKey();
      this._scheduleRender();
      this.requestUpdate();
    });
  };

  private readonly _handleThemeResourceLoad = (event: Event) => {
    const target = event.target;
    if (
      target instanceof HTMLLinkElement &&
      target.relList.contains("stylesheet")
    ) {
      this._handleThemeProjectionChange();
    }
  };

  private readonly _handleThemeProjectionMutations = (
    records: MutationRecord[],
  ) => {
    const isRuntimeThemeNode = (node: Node | null) => {
      const element =
        node instanceof Element ? node : (node?.parentElement ?? null);
      return Boolean(
        element?.matches("#myoxus-branding-css, [data-myoxus-branding]") ||
        element?.closest("#myoxus-branding-css, [data-myoxus-branding]") ||
        element?.querySelector?.(
          "#myoxus-branding-css, [data-myoxus-branding]",
        ),
      );
    };
    if (
      records.some(
        (record) =>
          isRuntimeThemeNode(record.target) ||
          [...record.addedNodes, ...record.removedNodes].some(
            isRuntimeThemeNode,
          ),
      )
    ) {
      this._handleThemeProjectionChange();
    }
  };

  private _observeThemeProjection() {
    this._themeProjectionObserver = new MutationObserver((records) => {
      if (
        records.some((record) => record.target === document.documentElement)
      ) {
        this._handleThemeProjectionChange();
        return;
      }
      this._handleThemeProjectionMutations(records);
    });
    this._themeProjectionObserver.observe(document.documentElement, {
      attributeFilter: ["class", "data-theme", "style"],
      attributes: true,
    });
    if (document.head) {
      this._themeProjectionObserver.observe(document.head, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    document.fonts?.addEventListener(
      "loadingdone",
      this._handleThemeProjectionChange,
    );
    document.addEventListener("load", this._handleThemeResourceLoad, true);
    void document.fonts?.ready.then(this._handleThemeProjectionChange);
  }

  private _stopObservingThemeProjection() {
    this._themeProjectionObserver?.disconnect();
    this._themeProjectionObserver = null;
    document.fonts?.removeEventListener(
      "loadingdone",
      this._handleThemeProjectionChange,
    );
    document.removeEventListener("load", this._handleThemeResourceLoad, true);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = "false";
    if (!this.hasAttribute("tabindex")) this.tabIndex = -1;
    this.addEventListener(
      "keydown",
      this._handleDocumentKeydown as EventListener,
    );
    window.addEventListener("keydown", this._handleDocumentKeydown, true);
    this.store.get(MermaidOwnerMigrationExtension).migrate();
    // Derive the display title from Source on mount. Repairing persisted
    // title/hash here marks an untouched document as edited.
    this._observeThemeProjection();
    this._disposables.add(
      subscribeMermaidNativeValidation((source) => {
        if (source === getMermaidBlockSource(this.model.props)) {
          this._handleThemeProjectionChange();
        }
      }),
    );
    // Source is authoritative across remounts. In particular, undo/redo can
    // restore a source/layout checkpoint before the owner child
    // relation has been replayed. Mounting must resize and reconcile that
    // projection from source instead of accepting stale owner children back into
    // source.
    this._pauseProjectionOwnerSourceSync();
    this._ensureProjectionOwner(false, true);
    this._acceptProjectionOwnerSourceSyncKey();
    this._scheduleRender();
    this._observedSource = getMermaidBlockSource(this.model.props);
    this._disposables.add(
      this.model.props.source$.subscribe(() => {
        const source = getMermaidBlockSource(this.model.props);
        // Y.Text can receive a remote delete+insert transaction whose final
        // bytes are identical, for example from a participant that still owns
        // an older projection. It is a CRDT event, but not a source change and
        // must not restart title projection, rendering or GFX reconciliation.
        if (source === this._observedSource) return;
        const focused = document.activeElement;
        const anchor = this._visualSelection.anchor;
        if (
          anchor &&
          focused instanceof HTMLElement &&
          focused.matches(".myoxus-mermaid-gfx-object-focus-proxy") &&
          focused.dataset.mermaidEditKey === anchor.editKey &&
          this.renderRoot.contains(focused)
        ) {
          // History and remote Source updates replace the scoped renderer too.
          // Hand its focused semantic carrier to the existing ready callback.
          this._queueVisualSelectionForProjection([anchor], { focus: true });
        }
        const previousSource = this._observedSource;
        this._observedSource = source;
        if (!this.store.readonly) {
          this.store.transact(
            () =>
              reconcileMermaidTitleProjectionFromSource(
                this.model,
                previousSource,
              ),
            false,
          );
        }
        this._scheduleRender();
      }),
    );
    this._disposables.add(
      this.store.history.onUpdated.subscribe(() => this.requestUpdate()),
    );
    const hostViewport = this.std.get(GfxControllerIdentifier).viewport;
    const hostSelection = this.std.get(GfxControllerIdentifier).selection;
    this._disposables.add(
      hostSelection.slots.updated.subscribe(() => {
        if (!this._isInEdgelessMode()) return;
        const note = this.store.getParent(this.model.id);
        const ownsOpenedNote = () =>
          this.isConnected &&
          !this.store.readonly &&
          note?.flavour === "myoxus:note" &&
          this.store.getParent(this.model.id) === note &&
          note.children.length === 1 &&
          note.children[0].id === this.model.id &&
          this._canConsumeScopedGfxEvent();
        if (!this._isActiveEmbeddedGfxEditor() && ownsOpenedNote()) {
          // Native Note entry finishes its range/focus handoff after rendering.
          // A sole diagram then owns editing; mixed Notes retain text selection.
          requestAnimationFrame(() => {
            if (!ownsOpenedNote()) return;
            this.selection.clear(["text"]);
            this._activateEmbeddedGfxEditor();
          });
        }
        if (!this._isActiveEmbeddedGfxEditor()) {
          if (MermaidHostState.activeKeyboardBlock === this) {
            MermaidHostState.activeKeyboardBlock = null;
          }
          this._stopTransientPointerInteractions();
          this._clearVisualSelection();
        }
        this.requestUpdate();
      }),
    );
    this._disposables.add(
      hostViewport.viewportUpdated.subscribe(() => {
        if (!this._isInEdgelessMode()) return;
        this._gfxViewportBridge.refreshClientRect();
      }),
    );
  }

  override disconnectedCallback() {
    this.removeEventListener(
      "keydown",
      this._handleDocumentKeydown as EventListener,
    );
    window.removeEventListener("keydown", this._handleDocumentKeydown, true);
    this._stopObservingThemeProjection();
    this._removeScopedGfxDocumentNativeListeners();
    if (MermaidHostState.activeKeyboardBlock === this) {
      MermaidHostState.activeKeyboardBlock = null;
    }
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    this._ownerSourceSync.dispose();
    this._stopTransientPointerInteractions();
    this._clearPendingVisualSelectionProjection();
    this._inlineShapeTextEditor.dispose();
    this._inlineConnectorLabelEditor.dispose();
    this._ownerGfx.dispose();
    if (this._scopedGfxViewportElement) {
      this._removeScopedGfxNativeListeners(this._scopedGfxViewportElement);
      this._scopedGfxViewportElement = null;
    }
    this._clearScopedGfxNestedNativeObserver();
    this._clearScopedGfxNestedNativeListeners();
    super.disconnectedCallback();
  }

  protected _stopTransientPointerInteractions() {
    this._gfxViewportBridge.cancelPageSelectionGesture();
    this._gfxSession.stopTransientPointerInteractions();
    this._gfxViewportInteraction.stopTransientPointerInteractions();
  }

  protected override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    this._ownerGfx.watchOwnerSurface();
    this._attachScopedGfxViewportNativeListeners();
    requestAnimationFrame(() => {
      if (this.isConnected) {
        this._attachScopedGfxViewportNativeListeners();
        this._restoreVisualObjectFocus();
      }
    });
    this._fitScopedGfxViewportIfNeeded();
  }

  protected _isInEdgelessMode() {
    return (
      this.std.get(GfxControllerIdentifier).getMode() === "edgeless" ||
      Boolean(this.closest("myoxus-edgeless-root"))
    );
  }

  protected _attachScopedGfxViewportNativeListeners() {
    const next =
      this._getDisplayMode() === "display"
        ? null
        : this._getScopedGfxViewport();
    if (next === this._scopedGfxViewportElement) {
      if (next) this._addScopedGfxDocumentNativeListeners();
      this._syncScopedGfxNestedNativeListeners(next);
      return;
    }
    if (this._scopedGfxViewportElement) {
      this._removeScopedGfxNativeListeners(this._scopedGfxViewportElement);
    } else {
      this._removeScopedGfxDocumentNativeListeners();
    }
    this._clearScopedGfxNestedNativeObserver();
    this._scopedGfxViewportElement = next;
    this._syncScopedGfxNestedNativeListeners(next);
    if (!next) {
      this._removeScopedGfxDocumentNativeListeners();
      return;
    }
    this._addScopedGfxDocumentNativeListeners();
    this._addScopedGfxNativeListeners(next);
    this._observeScopedGfxNestedNativeListeners(next);
  }

  protected _addScopedGfxDocumentNativeListeners() {
    // Native nested GFX hosts can consume surface events before they bubble
    // back to the Mermaid viewport. Capture at both document and window level
    // keeps Mermaid-owned edge/node hit testing authoritative for the scoped
    // editor without depending on editor-host propagation details.
    this._addScopedGfxNativeListeners(document);
    this._addScopedGfxNativeListeners(window);
  }

  protected _removeScopedGfxDocumentNativeListeners() {
    this._removeScopedGfxNativeListeners(document);
    this._removeScopedGfxNativeListeners(window);
  }

  protected _addScopedGfxNativeListeners(element: EventTarget) {
    element.addEventListener(
      "click",
      this._gfxViewportInteraction.clickListener,
      true,
    );
    element.addEventListener(
      "contextmenu",
      this._gfxViewportInteraction.contextMenuListener,
      true,
    );
    element.addEventListener(
      "dblclick",
      this._gfxViewportInteraction.doubleClickListener,
      true,
    );
    element.addEventListener(
      "pointerdown",
      this._gfxViewportInteraction.pointerDownListener,
      true,
    );
  }

  protected _removeScopedGfxNativeListeners(element: EventTarget) {
    element.removeEventListener(
      "click",
      this._gfxViewportInteraction.clickListener,
      true,
    );
    element.removeEventListener(
      "contextmenu",
      this._gfxViewportInteraction.contextMenuListener,
      true,
    );
    element.removeEventListener(
      "dblclick",
      this._gfxViewportInteraction.doubleClickListener,
      true,
    );
    element.removeEventListener(
      "pointerdown",
      this._gfxViewportInteraction.pointerDownListener,
      true,
    );
  }

  protected _clearScopedGfxNestedNativeListeners() {
    for (const element of this._scopedGfxNestedListenerElements) {
      this._removeScopedGfxNativeListeners(element);
    }
    this._scopedGfxNestedListenerElements = [];
  }

  protected _clearScopedGfxNestedNativeObserver() {
    this._scopedGfxNestedListenerObserver?.disconnect();
    this._scopedGfxNestedListenerObserver = null;
  }

  protected _observeScopedGfxNestedNativeListeners(viewport: Element) {
    this._scopedGfxNestedListenerObserver = new MutationObserver(() => {
      this._syncScopedGfxNestedNativeListeners(viewport);
    });
    this._scopedGfxNestedListenerObserver.observe(viewport, {
      childList: true,
      subtree: true,
    });
  }

  protected _syncScopedGfxNestedNativeListeners(viewport: Element | null) {
    // Page mode embeds a scoped GFX surface inside the Mermaid block viewport.
    // Some native GFX overlays retarget or stop events before the outer
    // viewport sees them, so the same controller listeners are also attached to
    // the nested hosts. The controller gates editable/native-control targets.
    const nestedHosts = viewport
      ? Array.from(viewport.querySelectorAll("editor-host, myoxus-surface"))
      : [];
    const nextElements: EventTarget[] = nestedHosts.flatMap((element) =>
      element.shadowRoot ? [element, element.shadowRoot] : [element],
    );
    for (const element of this._scopedGfxNestedListenerElements) {
      if (nextElements.includes(element)) continue;
      this._removeScopedGfxNativeListeners(element);
    }
    for (const element of nextElements) {
      if (this._scopedGfxNestedListenerElements.includes(element)) continue;
      this._addScopedGfxNativeListeners(element);
    }
    this._scopedGfxNestedListenerElements = nextElements;
  }
}
