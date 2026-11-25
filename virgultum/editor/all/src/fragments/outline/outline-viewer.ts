import {
  computed,
  effect,
  type Signal,
  signal,
  untracked,
} from "@preact/signals-core";
import { NoteDisplayMode } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/core/runtime";
import {
  DocModeProvider,
  type EditorCanvasToolControls,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  type EditorOutlineEntryControls,
  resolveLegacyEditorText,
} from "@virgultum/core/services";
import { scrollbarStyle } from "@virgultum/core/styles";

import {
  defaultOutlinePanelLabels,
  type OutlinePanelLabels,
} from "./config.js";
import { describeOutlineBlock } from "./document-outline-controller";
import { getHeadingBlocksFromDoc } from "./utils/query.js";
import {
  observeActiveHeadingDuringScroll,
  scrollToBlockWithHighlight,
} from "./utils/scroll.js";

const STYLE_ID = "myoxus-outline-viewer-styles";
const STYLES = `
  myoxus-outline-viewer {
    display: flex;
  }
  .outline-viewer-root {
    --duration: 120ms;
    --timing: cubic-bezier(0.42, 0, 0.58, 1);

    max-height: 100%;
    box-sizing: border-box;
    display: flex;
  }

  .outline-viewer-indicators-container {
    position: absolute;
    top: 0;
    right: 0;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    overflow-y: hidden;
  }

  .outline-viewer-indicator-wrapper {
    flex: 1 1 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .outline-viewer-indicator {
    width: 20px;
    height: 2px;
    border-radius: 1px;
    overflow: hidden;
    background: var(--myoxus-black-10, rgba(0, 0, 0, 0.1));
  }

  .outline-viewer-indicator.active {
    width: 24px;
    background: var(--myoxus-text-primary-color);
  }

  .outline-viewer-panel {
    position: relative;
    display: flex;
    width: 0px;
    max-height: 100%;
    box-sizing: border-box;
    flex-direction: column;
    align-items: flex-start;

    border-radius: 8px;
    border-width: 0px;
    border-style: solid;
    border-color: var(--myoxus-border-color);
    background: var(--myoxus-background-overlay-panel-color);
    box-shadow: 0px 6px 16px 0px rgba(0, 0, 0, 0.14);

    overflow-y: auto;

    opacity: 0;
    transform: translateX(0px);
    transition:
      width 0s var(--duration),
      padding 0s var(--duration),
      border-width 0s var(--duration),
      transform var(--duration) var(--timing),
      opacity var(--duration) var(--timing);
  }

  ${scrollbarStyle(".outline-viewer-panel")}

  .outline-viewer-header {
    display: flex;
    padding: 6px;
    align-items: center;
    gap: 4px;
    align-self: stretch;
  }

  .outline-viewer-header span {
    flex: 1;
    overflow: hidden;
    color: var(--myoxus-text-secondary-color);
    text-overflow: ellipsis;

    font-family: var(--myoxus-font-family);
    font-size: 12px;
    font-style: normal;
    font-weight: 500;
    line-height: 20px;
  }

  .outline-viewer-item {
    width: 100%;
  }

  .outline-viewer-root:hover .outline-viewer-indicators-container {
    visibility: hidden;
  }

  .outline-viewer-root:hover .outline-viewer-panel {
    width: 200px;
    border-width: 1px;
    padding: 8px 4px 8px 8px;
    opacity: 1;
    transform: translateX(-10px);
    transition:
      transform var(--duration) var(--timing),
      opacity var(--duration) var(--timing);
  }
`;

function ensureStyles(doc: Document) {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
}

type MountedOutlineItem = {
  el: HTMLDivElement;
  controls$: Signal<EditorOutlineEntryControls | null>;
  unmount: () => void;
};

export const MYOXUS_OUTLINE_VIEWER = "myoxus-outline-viewer";

export class OutlineViewer extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _activeHeadingId$ = signal<string | null>(null);
  private readonly _revision$ = signal(0);

  private _editor!: EditorHost;
  private _toggleOutlinePanel: (() => void) | null = null;
  private _labels: OutlinePanelLabels = defaultOutlinePanelLabels;

  private _highlightMaskDisposable = () => {};
  private _lockActiveHeadingId = false;

  private _editorDisposables: DisposableGroup | null = null;
  private _rootEl: HTMLDivElement | null = null;
  private _indicatorsEl: HTMLDivElement | null = null;
  private _panelEl: HTMLDivElement | null = null;
  private _headerTitleEl: HTMLSpanElement | null = null;
  private _toggleUnmount: (() => void) | null = null;
  private _mountedEditor: EditorHost | null = null;
  private readonly _items = new Map<string, MountedOutlineItem>();

  get editor(): EditorHost {
    return this._editor;
  }
  set editor(value: EditorHost) {
    const changed = this._editor !== value;
    this._editor = value;
    if (changed && this.isConnected) {
      this._bindEditor();
    }
    this._bump();
  }

  get toggleOutlinePanel(): (() => void) | null {
    return this._toggleOutlinePanel;
  }
  set toggleOutlinePanel(value: (() => void) | null) {
    this._toggleOutlinePanel = value;
    this._bump();
  }

  get labels(): OutlinePanelLabels {
    return this._labels;
  }
  set labels(value: OutlinePanelLabels) {
    this._labels = value;
    this._bump();
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private readonly _scrollPanel = () => {
    const activeItem = this.querySelector(
      ".outline-viewer-item.active",
    ) as HTMLElement | null;
    activeItem?.scrollIntoView({
      behavior: "instant",
      block: "center",
    });
  };

  private async _scrollToBlock(blockId: string) {
    this._lockActiveHeadingId = true;
    this._activeHeadingId$.value = blockId;
    this._highlightMaskDisposable = await scrollToBlockWithHighlight(
      this.editor,
      blockId,
    );
    this._lockActiveHeadingId = false;
  }

  private _toggleOutlinePanelAction() {
    if (this._toggleOutlinePanel) {
      this._toggleOutlinePanel();
    }
  }

  private readonly _toggleControls$ = computed<EditorCanvasToolControls | null>(
    () => {
      void this._revision$.value;
      if (!this._editor || this._toggleOutlinePanel === null) return null;
      const i18n =
        this._editor.std.getOptional(EditorI18nProvider) ?? undefined;
      void i18n?.locale$.value;
      const label =
        resolveLegacyEditorText("Open in sidebar", i18n) ?? "Open in sidebar";
      return {
        action: {
          id: "toggle-outline-panel-button",
          icon: "TocIcon",
          label,
          disabled: false,
          run: () => this._toggleOutlinePanelAction(),
        },
      };
    },
  );

  private _clearItems() {
    for (const item of this._items.values()) {
      item.unmount();
      item.el.remove();
    }
    this._items.clear();
  }

  private _clearShell() {
    this._clearItems();
    this._toggleUnmount?.();
    this._toggleUnmount = null;
    this._mountedEditor = null;
    this._rootEl?.remove();
    this._rootEl = null;
    this._indicatorsEl = null;
    this._panelEl = null;
    this._headerTitleEl = null;
  }

  private _ensureShell() {
    if (this._rootEl && this._mountedEditor === this._editor) return;
    this._clearShell();

    const root = this.ownerDocument.createElement("div");
    root.className = "outline-viewer-root";
    root.addEventListener("mouseenter", this._scrollPanel);

    const indicators = this.ownerDocument.createElement("div");
    indicators.className = "outline-viewer-indicators-container";

    const panel = this.ownerDocument.createElement("div");
    panel.className = "outline-viewer-panel";

    const header = this.ownerDocument.createElement("div");
    header.className = "outline-viewer-item outline-viewer-header";

    const title = this.ownerDocument.createElement("span");
    const toggleHost = this.ownerDocument.createElement("span");
    toggleHost.style.display = "contents";

    header.append(title, toggleHost);
    panel.append(header);
    root.append(indicators, panel);
    this.replaceChildren(root);

    this._rootEl = root;
    this._indicatorsEl = indicators;
    this._panelEl = panel;
    this._headerTitleEl = title;
    this._mountedEditor = this._editor;

    const chrome = this._editor?.std.getOptional(EditorChromeHostIdentifier);
    if (chrome) {
      this._toggleUnmount = chrome.mountCanvasTool(
        toggleHost,
        this._toggleControls$,
      );
    }
  }

  private _bindEditor() {
    this._editorDisposables?.dispose();
    this._editorDisposables = null;
    if (!this._editor) return;

    this._editorDisposables = new DisposableGroup();
    this._editorDisposables.add(
      observeActiveHeadingDuringScroll(
        () => this.editor,
        (newHeadingId) => {
          if (this._lockActiveHeadingId) return;
          this._activeHeadingId$.value = newHeadingId;
        },
      ),
    );
    this._editorDisposables.add(
      this._editor.store.workspace.meta.docMetaUpdated.subscribe(() => {
        this._bump();
      }),
    );
  }

  private _sync() {
    void this._revision$.value;
    const activeHeadingId = this._activeHeadingId$.value;
    if (!this._editor) {
      untracked(() => this._clearShell());
      return;
    }

    const i18n = this._editor.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;

    const docModeService = this._editor.std.get(DocModeProvider);
    const mode = docModeService.getEditorMode();
    if (this._editor.store.root === null || mode === "edgeless") {
      untracked(() => this._clearShell());
      return;
    }

    const headingBlocks = getHeadingBlocksFromDoc(
      this._editor.store,
      [NoteDisplayMode.DocAndEdgeless, NoteDisplayMode.DocOnly],
      true,
    );

    if (headingBlocks.length === 0) {
      untracked(() => this._clearShell());
      return;
    }

    const items = [
      ...(this._editor.store.meta?.title !== ""
        ? [this._editor.store.root]
        : []),
      ...headingBlocks,
    ];

    // Pre-compute entries while tracking reactive block signals
    const described = items.map((block) => ({
      block,
      entry: describeOutlineBlock(block, this._editor.std),
    }));

    untracked(() => {
      this._ensureShell();
      if (!this._indicatorsEl || !this._panelEl || !this._headerTitleEl) return;

      this._headerTitleEl.textContent = this._labels.title;

      // Update indicators
      const indicatorFragment = this.ownerDocument.createDocumentFragment();
      for (const { block } of described) {
        const wrapper = this.ownerDocument.createElement("div");
        wrapper.className = "outline-viewer-indicator-wrapper";
        const indicator = this.ownerDocument.createElement("div");
        indicator.className =
          activeHeadingId === block.id
            ? "outline-viewer-indicator active"
            : "outline-viewer-indicator";
        wrapper.append(indicator);
        indicatorFragment.append(wrapper);
      }
      this._indicatorsEl.replaceChildren(indicatorFragment);

      // Reconcile mounted outline entry portals keyed by block id
      const chrome = this._editor.std.getOptional(EditorChromeHostIdentifier);
      const nextIds = new Set(described.map(({ block }) => block.id));
      for (const [id, mounted] of this._items) {
        if (!nextIds.has(id)) {
          mounted.unmount();
          mounted.el.remove();
          this._items.delete(id);
        }
      }

      for (const { block, entry } of described) {
        const active = activeHeadingId === block.id;
        const controls: EditorOutlineEntryControls | null = entry
          ? {
              entry,
              active,
              showIcon: false,
              activate: () => {
                this._scrollToBlock(block.id).catch(console.error);
              },
            }
          : null;

        let mounted = this._items.get(block.id);
        if (!mounted) {
          const el = this.ownerDocument.createElement("div");
          const controls$ = signal<EditorOutlineEntryControls | null>(controls);
          const unmount = chrome
            ? chrome.mountOutlineEntry(el, controls$)
            : () => {};
          mounted = { el, controls$, unmount };
          this._items.set(block.id, mounted);
        } else {
          mounted.controls$.value = controls;
        }

        mounted.el.className = active
          ? "outline-viewer-item active"
          : "outline-viewer-item";
        this._panelEl.append(mounted.el);
      }
    });
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    ensureStyles(this.ownerDocument);
    this._bindEditor();
    this.disposables.add(
      effect(() => {
        this._sync();
      }),
    );
  }

  disconnectedCallback() {
    this._editorDisposables?.dispose();
    this._editorDisposables = null;
    this._clearShell();
    this.disposables.dispose();
    this._highlightMaskDisposable();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_OUTLINE_VIEWER]: OutlineViewer;
  }
}
