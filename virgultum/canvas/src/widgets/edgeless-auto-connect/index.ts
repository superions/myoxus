import { effect } from "@preact/signals-core";
import {
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
  isNoteBlock,
} from "@virgultum/canvas-runtime/surface";
import { Bound } from "@virgultum/core/primitives/gfx";
import {
  FrameBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
  SurfaceRefBlockModel,
} from "@virgultum/core/models";
import {
  EditorChromeHostIdentifier,
  FeatureFlagService,
} from "@virgultum/core/services";
import { matchModels } from "@virgultum/core/utils";
import { WidgetViewExtension } from "@virgultum/core/runtime";
import {
  type GfxController,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import { nothing, render } from "lit";
import { NativeCanvasWidget } from "../native-canvas-widget";
import { literal, unsafeStatic } from "lit/static-html.js";

const PAGE_VISIBLE_INDEX_LABEL_HEIGHT = 24;
const INDEX_LABEL_OFFSET = 16;

// Fan out repeated references around the same renderer anchor without changing their order.
function calculatePosition(gap: number, count: number, iconWidth: number) {
  return Array.from({ length: count }, (_, index) => [
    0,
    10 + (index - (count - 1) / 2) * (gap + iconWidth),
  ]);
}

type AutoConnectElement = NoteBlockModel | FrameBlockModel;

function isAutoConnectElement(element: unknown): element is AutoConnectElement {
  return (
    element instanceof NoteBlockModel || element instanceof FrameBlockModel
  );
}

export const MYOXUS_EDGELESS_AUTO_CONNECT_WIDGET =
  "myoxus-edgeless-auto-connect-widget";

export class EdgelessAutoConnectWidget extends NativeCanvasWidget {
  private readonly labels = new Map<
    string,
    { anchor: HTMLDivElement; items: HTMLDivElement[] }
  >();
  private navigator?: HTMLDivElement;

  private get _gfx(): GfxController {
    return this.std.get(GfxControllerIdentifier);
  }

  private get _crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  private get _viewport() {
    return this._gfx.viewport;
  }

  private get _selection() {
    return this._gfx.selection;
  }

  private get _enabled() {
    return (
      this.isConnected &&
      this.store
        .get(FeatureFlagService)
        .getFlag("enable_advanced_block_visibility")
    );
  }

  private readonly _updateLabels = () => {
    const doc = this.std.store;
    const root = doc.root;
    if (!root) return;
    const pageVisibleBlocks = new Map<AutoConnectElement, number>();
    const notes = root.children.filter((child) =>
      matchModels(child, [NoteBlockModel]),
    );

    const edgelessOnlyNotesSet = new Set<NoteBlockModel>();

    notes.forEach((note) => {
      if (isNoteBlock(note)) {
        if (note.props.displayMode$.value === NoteDisplayMode.EdgelessOnly) {
          edgelessOnlyNotesSet.add(note);
        } else if (
          note.props.displayMode$.value === NoteDisplayMode.DocAndEdgeless
        ) {
          pageVisibleBlocks.set(note, 1);
        }
      }

      note.children.forEach((model) => {
        if (matchModels(model, [SurfaceRefBlockModel])) {
          const reference = this._crud.getElementById(model.props.reference);

          if (!isAutoConnectElement(reference)) return;

          if (!pageVisibleBlocks.has(reference)) {
            pageVisibleBlocks.set(reference, 1);
          } else {
            pageVisibleBlocks.set(
              reference,
              pageVisibleBlocks.get(reference)! + 1,
            );
          }
        }
      });
    });

    this._edgelessOnlyNotesSet = edgelessOnlyNotesSet;
    this._pageVisibleElementsMap = pageVisibleBlocks;
  };

  private _initLabels() {
    const getVisibility = () => {
      const selected = this._selection.selectedElements;
      const references = this.store.getBlocksByFlavour("myoxus:surface-ref");
      this._show =
        selected.length === 1 &&
        !this._selection.editing &&
        (isNoteBlock(selected[0]) ||
          references.some(
            (ref) =>
              (ref.model as SurfaceRefBlockModel).props.reference ===
              selected[0].id,
          ));
      if (!this._show) this._index = -1;
      this.requestUpdate();
    };
    getVisibility();
    this.disposables.add(
      this._selection.slots.updated.subscribe(getVisibility),
    );
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(() => {
        getVisibility();
        this.requestUpdate();
      }),
    );
    const surface = this._gfx.surface;
    if (surface) {
      this.disposables.add(
        surface.elementUpdated.subscribe((payload) => {
          if (
            payload.props["xywh"] &&
            this.store
              .getBlocksByFlavour("myoxus:surface-ref")
              .some(
                (ref) =>
                  (ref.model as SurfaceRefBlockModel).props.reference ===
                  payload.id,
              )
          ) {
            this.requestUpdate();
          }
        }),
      );
    }
  }

  private _navigate(direction: -1 | 1) {
    if (!this._enabled) return;
    this._updateLabels();
    const elements = [...this._pageVisibleElementsMap.keys()];
    const next = this._index + direction;
    const element = elements[next];
    if (this._index < 0 || !element) return;
    this._index = next;
    const bound = Bound.deserialize(element.xywh);
    this._selection.set({ elements: [element.id], editing: false });
    this._viewport.setViewportByBound(bound, [80, 80, 80, 80], true);
  }

  private label(key: string, count: number) {
    let entry = this.labels.get(key);
    if (!entry) {
      const anchor = this.ownerDocument.createElement("div");
      anchor.style.position = "absolute";
      entry = { anchor, items: [] };
      this.labels.set(key, entry);
      this.append(anchor);
    }
    const { anchor, items } = entry;
    while (items.length > count) {
      const item = items.pop()!;
      render(nothing, item);
      item.remove();
    }
    while (items.length < count) {
      const item = this.ownerDocument.createElement("div");
      item.style.position = "absolute";
      items.push(item);
      anchor.append(item);
    }
    return entry;
  }

  private removeLabelsExcept(required: Set<string>) {
    for (const [key, { anchor, items }] of this.labels) {
      if (required.has(key)) continue;
      for (const item of items) render(nothing, item);
      if (key.startsWith("hidden:")) render(nothing, anchor);
      anchor.remove();
      this.labels.delete(key);
    }
  }

  private hideNavigator() {
    if (!this.navigator) return;
    render(nothing, this.navigator);
    this.navigator.remove();
    this.navigator = undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();

    Object.assign(this.style, {
      position: "absolute",
      top: "0",
      left: "0",
      zIndex: "1",
    });
    this._initLabels();
    const { disposables, std } = this;
    disposables.add(
      effect(() => {
        if (!this._enabled) this._index = -1;
        this.requestUpdate();
      }),
    );
    const slots = std.get(EdgelessLegacySlotIdentifier);
    const gfx = std.get(GfxControllerIdentifier);

    const start = () => {
      this._dragging = true;
      this.requestUpdate();
    };
    const end = () => {
      this._dragging = false;
      this.requestUpdate();
    };
    [
      gfx.viewport.viewportUpdated.subscribe(() => this.requestUpdate()),
      std.event.add("dragStart", start),
      std.event.add("dragEnd", end),
      slots.elementResizeStart.subscribe(start),
      slots.elementResizeEnd.subscribe(end),
    ].forEach((subscription) => disposables.add(subscription));
  }

  override disconnectedCallback() {
    this.removeLabelsExcept(new Set());
    this.hideNavigator();
    super.disconnectedCallback();
  }

  protected paint() {
    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (!this._show || this._dragging || !this._enabled || !chrome) {
      this.removeLabelsExcept(new Set());
      this.hideNavigator();
      return;
    }
    this._updateLabels();
    const elements = [...this._pageVisibleElementsMap.keys()];
    const required = new Set<string>();
    let number = 0;

    elements.forEach((element, i) => {
      const bound = Bound.deserialize(element.xywh);
      const [left, top] = this._viewport.toViewCoord(
        bound.center[0],
        bound.maxY,
      );
      const count = this._pageVisibleElementsMap.get(element) ?? 0;
      const key = `visible:${element.id}`;
      required.add(key);
      const { anchor, items } = this.label(key, count);
      Object.assign(anchor.style, {
        left: `${left}px`,
        top: `${top + INDEX_LABEL_OFFSET}px`,
      });
      anchor.onmouseenter = () => {
        this._expanded = element.id;
        this.requestUpdate();
      };
      anchor.onmouseleave = () => {
        this._expanded = null;
        this.requestUpdate();
      };
      const positions = calculatePosition(
        this._expanded === element.id ? 5 : 24 / count - 24,
        count,
        PAGE_VISIBLE_INDEX_LABEL_HEIGHT,
      );
      items.forEach((item, j) => {
        item.style.transform = `translate(${positions[j][1] - 10}px, ${positions[j][0]}px) translateX(-50%)`;
        render(
          chrome.renderAutoConnectLabel({
            index: ++number,
            active: this._index === i,
            toggle: () => {
              if (!this._enabled) return;
              this._updateLabels();
              const selected = [
                ...this._pageVisibleElementsMap.keys(),
              ].findIndex((entry) => entry.id === element.id);
              this._index = this._index === selected ? -1 : selected;
              this.requestUpdate();
            },
          }),
          item,
        );
      });
    });

    for (const note of this._edgelessOnlyNotesSet) {
      const key = `hidden:${note.id}`;
      required.add(key);
      const { anchor } = this.label(key, 0);
      const bound = Bound.deserialize(note.xywh);
      const [left, top] = this._viewport.toViewCoord(
        bound.center[0],
        bound.maxY,
      );
      anchor.style.transform = `translate(${left}px, ${top + INDEX_LABEL_OFFSET}px) translateX(-50%)`;
      render(
        chrome.renderAutoConnectLabel({ active: false, toggle: () => {} }),
        anchor,
      );
    }
    this.removeLabelsExcept(required);

    const current = elements[this._index];
    if (!current) {
      this.hideNavigator();
      return;
    }
    const anchor = (this.navigator ??= this.ownerDocument.createElement("div"));
    const bound = Bound.deserialize(current.xywh);
    const [left, top] = this._viewport.toViewCoord(bound.center[0], bound.maxY);
    Object.assign(anchor.style, {
      position: "absolute",
      transform: `translate(${left}px, ${top + INDEX_LABEL_OFFSET}px) translateX(-50%)`,
    });
    if (!anchor.parentElement) this.append(anchor);
    render(
      chrome.renderAutoConnectNavigator({
        previous: this._index > 0,
        next: this._index < elements.length - 1,
        navigate: (direction) => this._navigate(direction),
      }),
      anchor,
    );
  }

  private _dragging = false;
  private _edgelessOnlyNotesSet = new Set<NoteBlockModel>();
  private _index = -1;
  private _pageVisibleElementsMap = new Map<AutoConnectElement, number>();
  private _show = false;
  private _expanded: string | null = null;
}

export const autoConnectWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_EDGELESS_AUTO_CONNECT_WIDGET,
  literal`${unsafeStatic(MYOXUS_EDGELESS_AUTO_CONNECT_WIDGET)}`,
);

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-auto-connect-widget": EdgelessAutoConnectWidget;
  }
}
