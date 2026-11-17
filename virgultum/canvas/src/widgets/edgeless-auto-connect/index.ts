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
  type RootBlockModel,
  SurfaceRefBlockModel,
} from "@virgultum/core/models";
import {
  EditorChromeHostIdentifier,
  FeatureFlagService,
} from "@virgultum/core/services";
import { matchModels } from "@virgultum/core/utils";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/core/runtime";
import {
  type GfxController,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
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

export class EdgelessAutoConnectWidget extends WidgetComponent<RootBlockModel> {
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

  private _EdgelessOnlyLabels() {
    const { _edgelessOnlyNotesSet } = this;

    if (!_edgelessOnlyNotesSet.size) return nothing;

    return html`${repeat(
      _edgelessOnlyNotesSet,
      (note) => note.id,
      (note) => {
        const viewport = this._viewport;
        const { zoom } = viewport;
        const bound = Bound.deserialize(note.xywh);
        const [left, right] = viewport.toViewCoord(bound.x, bound.y);
        const [width, height] = [bound.w * zoom, bound.h * zoom];
        return html`<div
          style=${styleMap({
            position: "absolute",
            transform: `translate(${left + width / 2}px, ${right + height + INDEX_LABEL_OFFSET}px) translateX(-50%)`,
          })}
        >
          ${this.std.getOptional(EditorChromeHostIdentifier)?.renderAutoConnectLabel({ active: false, toggle: () => {} }) ?? nothing}
        </div>`;
      },
    )}`;
  }

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
    };
    getVisibility();
    this._disposables.add(
      this._selection.slots.updated.subscribe(getVisibility),
    );
    this._disposables.add(
      this.store.slots.blockUpdated.subscribe(() => {
        getVisibility();
        this.requestUpdate();
      }),
    );
    const surface = this._gfx.surface;
    if (surface) {
      this._disposables.add(
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

  private _NavigatorComponent(elements: AutoConnectElement[]) {
    const element = elements[this._index];
    const bound = Bound.deserialize(element.xywh);
    const [left, top] = this._viewport.toViewCoord(bound.center[0], bound.maxY);
    return html`<div
      style=${styleMap({
        position: "absolute",
        transform: `translate(${left}px, ${top + INDEX_LABEL_OFFSET}px) translateX(-50%)`,
      })}
    >
      ${
        this.std
          .getOptional(EditorChromeHostIdentifier)
          ?.renderAutoConnectNavigator({
            previous: this._index > 0,
            next: this._index < elements.length - 1,
            navigate: (direction) => this._navigate(direction),
          }) ?? nothing
      }
    </div>`;
  }

  private _PageVisibleIndexLabels(
    elements: AutoConnectElement[],
    counts: number[],
  ) {
    const viewport = this._viewport;
    let index = 0;
    return html`${repeat(
      elements,
      (element) => element.id,
      (element, i) => {
        const bound = Bound.deserialize(element.xywh$.value);
        const [left, top] = viewport.toViewCoord(bound.center[0], bound.maxY);
        const count = counts[i];
        const indices = Array.from({ length: count }, () => ++index);
        const positions = calculatePosition(
          this._expanded === element.id ? 5 : 24 / count - 24,
          count,
          PAGE_VISIBLE_INDEX_LABEL_HEIGHT,
        );
        return html`<div
          style=${styleMap({ position: "absolute", left: `${left}px`, top: `${top + INDEX_LABEL_OFFSET}px` })}
          @mouseenter=${() => {
            this._expanded = element.id;
          }}
          @mouseleave=${() => {
            this._expanded = null;
          }}
        >
          ${indices.map(
            (number, j) =>
              html`<div
                style=${styleMap({
                  position: "absolute",
                  transform: `translate(${positions[j][1] - 10}px, ${positions[j][0]}px) translateX(-50%)`,
                })}
              >
                ${
                  this.std
                    .getOptional(EditorChromeHostIdentifier)
                    ?.renderAutoConnectLabel({
                      index: number,
                      active: this._index === i,
                      toggle: () => {
                        if (!this._enabled) return;
                        this._updateLabels();
                        const currentIndex = [
                          ...this._pageVisibleElementsMap.keys(),
                        ].findIndex((item) => item.id === element.id);
                        this._index =
                          this._index === currentIndex ? -1 : currentIndex;
                      },
                    }) ?? nothing
                }
              </div>`,
          )}
        </div>`;
      },
    )}`;
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
  }

  override firstUpdated(): void {
    const { _disposables, std } = this;
    const slots = std.get(EdgelessLegacySlotIdentifier);
    const gfx = std.get(GfxControllerIdentifier);

    const start = () => {
      this._dragging = true;
    };
    const end = () => {
      this._dragging = false;
    };
    [
      gfx.viewport.viewportUpdated.subscribe(() => this.requestUpdate()),
      std.event.add("dragStart", start),
      std.event.add("dragEnd", end),
      slots.elementResizeStart.subscribe(start),
      slots.elementResizeEnd.subscribe(end),
    ].forEach((subscription) => _disposables.add(subscription));
  }

  override createRenderRoot() {
    return this;
  }

  override render() {
    if (!this._show || this._dragging || !this._enabled) {
      return nothing;
    }

    this._updateLabels();

    const elements = [...this._pageVisibleElementsMap.keys()];
    const counts = [...this._pageVisibleElementsMap.values()];

    return html`${this._PageVisibleIndexLabels(elements, counts)}
    ${this._EdgelessOnlyLabels()}
    ${
      this._index >= 0 && this._index < elements.length
        ? this._NavigatorComponent(elements)
        : nothing
    } `;
  }

  @state()
  private accessor _dragging = false;

  private _edgelessOnlyNotesSet = new Set<NoteBlockModel>();

  @state()
  private accessor _index = -1;

  private _pageVisibleElementsMap: Map<AutoConnectElement, number> = new Map();

  @state()
  private accessor _show = false;

  @state()
  private accessor _expanded: string | null = null;
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
