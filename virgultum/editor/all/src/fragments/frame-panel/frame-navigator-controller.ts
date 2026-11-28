// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, signal, type ReadonlySignal } from "@preact/signals-core";
import {
  EdgelessFrameManager,
  PresentTool,
  type NavigatorMode,
} from "@virgultum/canvas/blocks";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { Bound, deserializeXYWH } from "@virgultum/core/primitives/gfx";
import {
  BlockStdScope,
  LifeCycleWatcher,
  type EditorHost,
} from "@virgultum/core/runtime";
import {
  generateKeyBetweenV2,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import {
  DocModeExtension,
  DocModeProvider,
  EditPropsStore,
  ViewportElementExtension,
} from "@virgultum/core/services";
import type { Doc, ExtensionType, Query, Store } from "@virgultum/core/store";

export type FrameNavigatorSettings = Readonly<{
  darkBackground: boolean;
  fillScreen: boolean;
  hideToolbar: boolean;
}>;

export type FrameNavigatorItem = Readonly<{
  id: string;
  index: number;
  presentationIndex: string;
  title: string;
  selected: boolean;
  xywh: string;
}>;

export type FrameNavigatorState = Readonly<{
  frames: readonly FrameNavigatorItem[];
  selectedIds: readonly string[];
  readonly: boolean;
  settings: FrameNavigatorSettings;
}>;

export type FrameNavigatorOptions = {
  fitPadding?: readonly number[];
};

export type FramePreviewOptions = {
  width?: number;
  height?: number;
};

const DEFAULT_PREVIEW_WIDTH = 280;
const DEFAULT_PREVIEW_HEIGHT = 166;

const PREVIEW_STYLE_ID = "myoxus-frame-navigator-preview-styles";
const PREVIEW_STYLES = `
  .frame-preview-surface-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    overflow: hidden;
  }

  .frame-preview-viewport {
    max-width: 100%;
    box-sizing: border-box;
    margin: 0 auto;
    position: relative;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }

  .frame-preview-viewport
    > editor-host
    > myoxus-edgeless-root-preview
    > .edgeless-background {
    background-color: transparent;
    background-image: none;
  }
`;

const PREVIEW_DOC_QUERY: Query = {
  mode: "loose",
  match: [
    {
      flavour: "myoxus:frame",
      viewType: "hidden",
    },
  ],
};

// Ref-count the shared readonly preview store per Doc so unmounting one frame
// thumbnail never disposes the store still used by sibling frame cards.
const previewStoreRefs = new WeakMap<Doc, { count: number; store: Store }>();

function acquirePreviewStore(doc: Doc): Store {
  const existing = previewStoreRefs.get(doc);
  if (existing) {
    existing.count += 1;
    return existing.store;
  }
  const store = doc.getStore({ readonly: true, query: PREVIEW_DOC_QUERY });
  previewStoreRefs.set(doc, { count: 1, store });
  return store;
}

function releasePreviewStore(doc: Doc): void {
  const existing = previewStoreRefs.get(doc);
  if (!existing) return;
  existing.count -= 1;
  if (existing.count <= 0) {
    previewStoreRefs.delete(doc);
    doc.removeStore({ query: PREVIEW_DOC_QUERY });
  }
}

function ensurePreviewStyles(doc: Document): void {
  if (!doc.head || doc.getElementById(PREVIEW_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PREVIEW_STYLE_ID;
  style.textContent = PREVIEW_STYLES;
  doc.head.append(style);
}

function normalizePadding(
  padding?: readonly number[],
): [number, number, number, number] {
  return [0, 1, 2, 3].map((idx) => {
    const value = padding?.[idx];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }) as [number, number, number, number];
}

function readSettings(host: EditorHost | null): FrameNavigatorSettings {
  if (!host) {
    return {
      darkBackground: true,
      fillScreen: false,
      hideToolbar: false,
    };
  }
  const editProps = host.std.getOptional(EditPropsStore);
  return {
    darkBackground: editProps?.getStorage("presentBlackBackground") ?? true,
    fillScreen: editProps?.getStorage("presentFillScreen") ?? false,
    hideToolbar: editProps?.getStorage("presentHideToolbar") ?? false,
  };
}

/**
 * Signal-driven controller owning the Edgeless frame list, selection sync,
 * presentation ordering, settings, and lightweight thumbnail preview mounts.
 *
 * Designed to stay stable across Page/Edgeless `EditorHost` swaps via
 * {@link setHost} so React consumers do not tear down preview mounts on mode
 * switches.
 */
export class FrameNavigatorController {
  private _host: EditorHost | null;
  private readonly _fitPadding: readonly number[];
  private readonly _revision$ = signal(0);
  private readonly _selected$ = signal<readonly string[]>([]);
  private readonly _settings$ = signal<FrameNavigatorSettings>({
    darkBackground: true,
    fillScreen: false,
    hideToolbar: false,
  });
  private readonly _snapshot: ReadonlySignal<FrameNavigatorState>;

  private _subscribers = 0;
  private _hostDisposables: DisposableGroup | null = null;
  private _titleDisposables: DisposableGroup | null = null;
  private _lastDocId: string | null = null;

  constructor(host: EditorHost | null, options: FrameNavigatorOptions = {}) {
    this._host = host;
    this._fitPadding = options.fitPadding ?? [];
    this._settings$.value = readSettings(host);
    this._lastDocId = host?.store.id ?? null;
    this._snapshot = computed(() => this._project());
  }

  get host(): EditorHost | null {
    return this._host;
  }

  /** Rebinds the active EditorHost without resetting controller identity. */
  setHost(host: EditorHost | null): void {
    if (this._host === host) return;
    const prevDocId = this._lastDocId;
    this._host = host;
    this._settings$.value = readSettings(host);

    if (!host) {
      this._selected$.value = [];
      this._lastDocId = null;
    } else if (prevDocId && prevDocId !== host.store.id) {
      this._selected$.value = [];
      this._lastDocId = host.store.id;
    } else {
      this._lastDocId = host.store.id;
      const selected = this._selected$.peek();
      if (selected.length > 0) {
        host.std.getOptional(GfxControllerIdentifier)?.selection.set({
          elements: [...selected],
          editing: false,
        });
      }
    }

    if (this._subscribers > 0) {
      this._attachHost();
    }
    this._bump();
  }

  getSnapshot = (): FrameNavigatorState => this._snapshot.value;

  subscribe = (listener: () => void): (() => void) => {
    if (this._subscribers++ === 0) {
      this._attachHost();
    }
    const stop = this._snapshot.subscribe(listener);
    return () => {
      stop();
      if (--this._subscribers === 0) {
        this._detachHost();
      }
    };
  };

  private _bump(): void {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private _getSortedFrames(): FrameBlockModel[] {
    if (!this._host) return [];
    const blocks = this._host.store
      .getBlocksByFlavour("myoxus:frame")
      .map((entry) => entry.model as FrameBlockModel);
    return blocks.sort(EdgelessFrameManager.framePresentationComparator);
  }

  private _project(): FrameNavigatorState {
    void this._revision$.value;
    const settings = this._settings$.value;
    const selectedSet = new Set(this._selected$.value);
    const frames = this._getSortedFrames();
    const validSelected: string[] = [];

    const items: FrameNavigatorItem[] = frames.map((frame, index) => {
      const selected = selectedSet.has(frame.id);
      if (selected) validSelected.push(frame.id);
      return {
        id: frame.id,
        index,
        presentationIndex:
          frame.props.presentationIndex ?? frame.props.index ?? "",
        title: frame.props.title.toString(),
        selected,
        xywh: frame.xywh,
      };
    });

    return {
      frames: items,
      selectedIds: validSelected,
      readonly: this._host?.store.readonly ?? true,
      settings,
    };
  }

  private _syncTitleObservers(): void {
    this._titleDisposables?.dispose();
    this._titleDisposables = null;
    if (!this._host || this._subscribers === 0) return;

    const group = new DisposableGroup();
    const onTitleChange = () => this._bump();
    for (const frame of this._getSortedFrames()) {
      const yText = frame.props.title.yText;
      yText.observe(onTitleChange);
      group.add(() => yText.unobserve(onTitleChange));
    }
    this._titleDisposables = group;
  }

  private _attachHost(): void {
    this._detachHost();
    const host = this._host;
    if (!host) return;

    const group = new DisposableGroup();
    const syncFrames = () => {
      if (this._host !== host || this._subscribers === 0) return;
      const frameIds = new Set(this._getSortedFrames().map((f) => f.id));
      const pruned = this._selected$.peek().filter((id) => frameIds.has(id));
      if (pruned.length !== this._selected$.peek().length) {
        this._selected$.value = pruned;
      }
      this._syncTitleObservers();
      this._bump();
    };

    group.add(
      host.store.slots.blockUpdated.subscribe(({ type, flavour }) => {
        if (flavour !== "myoxus:frame") return;
        syncFrames();
        // Store emits `delete` before removing the entry from its flavour index;
        // re-sync on the microtask once the deletion has settled.
        if (type === "delete") {
          queueMicrotask(syncFrames);
        }
      }),
    );

    const legacySlots = host.std.getOptional(EdgelessLegacySlotIdentifier);
    if (legacySlots) {
      const sub = legacySlots.navigatorSettingUpdated.subscribe(
        ({ blackBackground, fillScreen, hideToolbar }) => {
          const prev = this._settings$.peek();
          this._settings$.value = {
            darkBackground: blackBackground ?? prev.darkBackground,
            fillScreen: fillScreen ?? prev.fillScreen,
            hideToolbar: hideToolbar ?? prev.hideToolbar,
          };
        },
      );
      group.add(() => sub.unsubscribe());
    }

    this._hostDisposables = group;
    this._syncTitleObservers();
  }

  private _detachHost(): void {
    this._titleDisposables?.dispose();
    this._titleDisposables = null;
    this._hostDisposables?.dispose();
    this._hostDisposables = null;
  }

  /** Selects or toggles a frame card and mirrors selection onto the canvas. */
  select = (frameId: string, multiselect: boolean): void => {
    const current = this._selected$.peek();
    const alreadySelected = current.includes(frameId);
    let next: string[];

    if (alreadySelected) {
      next = current.filter((id) => id !== frameId);
    } else if (multiselect) {
      next = [...current, frameId];
    } else {
      next = [frameId];
    }

    this._selected$.value = next;
    this._host?.std.getOptional(GfxControllerIdentifier)?.selection.set({
      elements: next,
      editing: false,
    });
  };

  /** Clears card selection and canvas selection. */
  clearSelection = (): void => {
    if (this._selected$.peek().length === 0) return;
    this._selected$.value = [];
    this._host?.std.getOptional(GfxControllerIdentifier)?.selection.set({
      elements: [],
      editing: false,
    });
  };

  /** Centers the Edgeless viewport on the frame, switching from Page mode if needed. */
  fitFrame = (frameId: string): void => {
    const host = this._host;
    if (!host) return;
    const frame = this._getSortedFrames().find((f) => f.id === frameId);
    if (!frame) return;

    const padding = normalizePadding(this._fitPadding);
    const docMode = host.std.get(DocModeProvider);
    if (docMode.getEditorMode() !== "edgeless") {
      host.std.get(EditPropsStore).setStorage("viewport", {
        xywh: frame.xywh,
        referenceId: frame.id,
        padding,
      });
      docMode.setEditorMode("edgeless");
      return;
    }

    host.std
      .get(GfxControllerIdentifier)
      .viewport.setViewportByBound(
        Bound.deserialize(frame.xywh),
        padding,
        true,
      );
  };

  /** Renames a frame's Y.Text title in place when the document is editable. */
  renameFrame = (frameId: string, nextTitle: string): void => {
    const host = this._host;
    if (!host || host.store.readonly) return;
    const frame = this._getSortedFrames().find((f) => f.id === frameId);
    if (!frame) return;

    const currentTitle = frame.props.title.toString();
    if (currentTitle === nextTitle) return;

    host.store.captureSync();
    frame.props.title.replace(0, currentTitle.length, nextTitle);
    host.store.captureSync();
    this._bump();
  };

  /**
   * Reorders the selected frames to `insertIndex` within the sorted frame list
   * by rewriting their `presentationIndex` keys via fractional indexing.
   */
  reorderFrames = (
    selectedIds: readonly string[],
    insertIndex: number,
  ): void => {
    const host = this._host;
    if (!host || host.store.readonly) return;

    const allFrames = this._getSortedFrames();
    if (
      allFrames.length <= 1 ||
      insertIndex < 0 ||
      insertIndex > allFrames.length
    ) {
      return;
    }

    const selectedSet = new Set(selectedIds);
    const moving = allFrames.filter((frame) => selectedSet.has(frame.id));
    if (moving.length === 0) return;

    let before = allFrames[insertIndex - 1]?.props.presentationIndex || null;
    const after = allFrames[insertIndex]?.props.presentationIndex || null;

    for (const frame of moving) {
      const nextKey = generateKeyBetweenV2(before, after);
      host.store.updateBlock(frame, { presentationIndex: nextKey });
      before = nextKey;
    }

    host.store.captureSync();
    this._bump();
  };

  /** Persists a presentation setting and broadcasts it through legacy canvas slots. */
  setSetting = <K extends keyof FrameNavigatorSettings>(
    key: K,
    value: FrameNavigatorSettings[K],
  ): void => {
    const host = this._host;
    this._settings$.value = {
      ...this._settings$.peek(),
      [key]: value,
    };
    if (!host) return;

    const editProps = host.std.get(EditPropsStore);
    const slots = host.std.getOptional(EdgelessLegacySlotIdentifier);
    if (key === "fillScreen") {
      editProps.setStorage("presentFillScreen", value);
      slots?.navigatorSettingUpdated.next({ fillScreen: value });
    } else if (key === "darkBackground") {
      editProps.setStorage("presentBlackBackground", value);
      slots?.navigatorSettingUpdated.next({ blackBackground: value });
    } else {
      editProps.setStorage("presentHideToolbar", value);
      slots?.navigatorSettingUpdated.next({ hideToolbar: value });
    }
  };

  /** Switches to Edgeless mode if necessary and activates Presentation mode. */
  enterPresentationMode = (): void => {
    const host = this._host;
    if (!host) return;

    const docMode = host.std.get(DocModeProvider);
    if (docMode.getEditorMode() !== "edgeless") {
      docMode.setEditorMode("edgeless");
    }

    const mode: NavigatorMode = this._settings$.peek().fillScreen
      ? "fill"
      : "fit";
    window.setTimeout(() => {
      const activeHost = this._host;
      if (!activeHost) return;
      activeHost.std
        .getOptional(GfxControllerIdentifier)
        ?.tool.setTool(PresentTool, { mode });
    }, 100);
  };

  /**
   * Mounts a readonly `preview-edgeless` thumbnail for `frameId` into
   * `container` and keeps its viewport fitted to the frame's bounds and
   * `fillScreen` setting.
   */
  mountPreview = (
    container: HTMLElement,
    frameId: string,
    options: FramePreviewOptions = {},
  ): (() => void) => {
    const host = this._host;
    if (!host) return () => {};
    const frame = this._getSortedFrames().find((f) => f.id === frameId);
    if (!frame || !frame.xywh) return () => {};

    const doc = frame.store.workspace.getDoc(frame.store.id);
    if (!doc) return () => {};

    const ownerDoc = container.ownerDocument;
    ensurePreviewStyles(ownerDoc);

    const surfaceWidth = options.width ?? DEFAULT_PREVIEW_WIDTH;
    const surfaceHeight = options.height ?? DEFAULT_PREVIEW_HEIGHT;

    const surfaceEl = ownerDoc.createElement("div");
    surfaceEl.className = "frame-preview-surface-container";
    surfaceEl.style.width = `${surfaceWidth}px`;
    surfaceEl.style.height = `${surfaceHeight}px`;

    const viewportEl = ownerDoc.createElement("div");
    viewportEl.className = "frame-preview-viewport";
    surfaceEl.append(viewportEl);
    container.replaceChildren(surfaceEl);

    const previewStore = acquirePreviewStore(doc);
    let previewHost: EditorHost | null = null;
    let disposed = false;

    const refreshViewport = () => {
      if (disposed || !previewHost || !frame.xywh) return;
      const gfx = previewHost.std.getOptional(GfxControllerIdentifier);
      if (!gfx) return;
      gfx.viewport.setViewportByBound(Bound.deserialize(frame.xywh));
    };

    const syncDimensions = () => {
      if (disposed || !frame.xywh) return;
      const [, , w, h] = deserializeXYWH(frame.xywh);
      if (w <= 0 || h <= 0) return;
      const fill = this._settings$.peek().fillScreen;
      const scale = fill
        ? Math.max(surfaceWidth / w, surfaceHeight / h)
        : Math.min(surfaceWidth / w, surfaceHeight / h);
      viewportEl.style.width = `${w * scale}px`;
      viewportEl.style.height = `${h * scale}px`;
      refreshViewport();
    };

    class FrameThumbnailWatcher extends LifeCycleWatcher {
      static override key = "frame-thumbnail-watcher";

      override mounted() {
        const std = this.std;
        std.view.viewUpdated.subscribe((payload) => {
          if (
            payload.type !== "block" ||
            payload.method !== "add" ||
            payload.view.model.flavour !== "myoxus:page"
          ) {
            return;
          }
          const viewport = std.get(GfxControllerIdentifier).viewport;
          const subscription = viewport.sizeUpdated.subscribe(() => {
            subscription.unsubscribe();
            refreshViewport();
          });
        });
      }
    }

    const viewManager = host.std.get(ViewExtensionManagerIdentifier);
    const docModeService = host.std.get(DocModeProvider);
    const runtimeExtensions: ExtensionType[] = [
      ViewportElementExtension(".frame-preview-viewport"),
      FrameThumbnailWatcher,
      DocModeExtension(docModeService),
    ];

    previewHost = new BlockStdScope({
      store: previewStore,
      extensions: viewManager.get("preview-edgeless").concat(runtimeExtensions),
    }).render();
    viewportEl.replaceChildren(previewHost);
    syncDimensions();

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const propsSub = frame.propsUpdated.subscribe(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        syncDimensions();
      }, 10);
    });
    const stopSettings = this._settings$.subscribe(() => {
      syncDimensions();
    });

    return () => {
      disposed = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      propsSub.unsubscribe();
      stopSettings();
      previewHost = null;
      surfaceEl.remove();
      releasePreviewStore(doc);
    };
  };
}
