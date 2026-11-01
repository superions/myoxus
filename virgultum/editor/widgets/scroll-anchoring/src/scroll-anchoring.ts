import { cssVar } from "@myoxus/theme";
import { computed, signal } from "@preact/signals-core";
import { Bound, deserializeXYWH } from "@virgultum/global/gfx";
import type { DocMode } from "@virgultum/model";
import { HighlightSelection } from "@virgultum/shared/selection";
import { WidgetComponent } from "@virgultum/std";
import { GfxControllerIdentifier, type GfxModel } from "@virgultum/std/gfx";
import { css, html, nothing, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";

type Anchor = {
  id: string;
  mode: DocMode;
  highlight: boolean;
};

export const MYOXUS_SCROLL_ANCHORING_WIDGET = "myoxus-scroll-anchoring-widget";

export class MyoxusScrollAnchoringWidget extends WidgetComponent {
  static override styles = css`
    :host {
      pointer-events: none;
      position: absolute;
      left: 0px;
      top: 0px;
      transform-origin: left top;
      contain: size layout;
      z-index: 1;

      & .highlight {
        position: absolute;
        box-sizing: border-box;

        &.edgeless {
          border-width: 1.39px;
          border-style: solid;
          border-color: ${unsafeCSS(cssVar("primaryColor"))};
          box-shadow: var(--myoxus-active-shadow);
        }

        &.page {
          border-radius: 5px;
          /* Hover surfaces may be opaque in the server theme. This overlay
             sits above document content, so mark bounds without covering it. */
          border: 1px solid ${unsafeCSS(cssVar("primaryColor"))};
        }
      }
    }
  `;

  #listened = false;

  readonly #requestUpdateFn = () => this.requestUpdate();

  readonly #resizeObserver: ResizeObserver = new ResizeObserver(
    this.#requestUpdateFn,
  );

  #layoutFrame: number | null = null;
  #scrollFrame: number | null = null;

  readonly #scheduleLayoutUpdate = () => {
    if (!this.anchor$.peek() || this.#layoutFrame !== null) return;
    this.#layoutFrame = requestAnimationFrame(() => {
      this.#layoutFrame = null;
      this.requestUpdate();
    });
  };

  anchor$ = signal<Anchor | null>(null);

  anchorBounds$ = signal<Bound | null>(null);

  highlighted$ = computed(() => this.std.selection.find(HighlightSelection));

  #getBoundsInEdgeless() {
    const controller = this.std.get(GfxControllerIdentifier);
    const bounds = this.anchorBounds$.peek();
    if (!bounds) return;

    const { x, y, w, h } = bounds;
    const zoom = controller.viewport.zoom;
    const [vx, vy] = controller.viewport.toViewCoord(x, y);

    return new Bound(vx, vy, w * zoom, h * zoom);
  }

  #getBoundsInPage(id: string) {
    const blockComponent = this.std.view.getBlock(id);
    if (!blockComponent) return;

    const containerRect = this.getBoundingClientRect();
    const { left, top, width, height } = blockComponent.getBoundingClientRect();

    return new Bound(
      left - containerRect.left,
      top - containerRect.top,
      width,
      height,
    );
  }

  #moveToAnchorInEdgeless(id: string) {
    const controller = this.std.get(GfxControllerIdentifier);
    const surface = controller.surface;
    if (!surface) return;

    const xywh = controller.getElementById<GfxModel>(id)?.xywh;
    if (!xywh) {
      if (!this.#listened) return;

      const blockUpdatedSubscription =
        this.std.store.slots.blockUpdated.subscribe((v) => {
          if (v.type === "add" && v.id === id) {
            blockUpdatedSubscription.unsubscribe();
            this.#moveToAnchorInEdgeless(id);
          }
        });

      const elementAddedSubscription = surface.elementAdded.subscribe((v) => {
        if (v.id === id && v.local === false) {
          elementAddedSubscription.unsubscribe();
          this.#moveToAnchorInEdgeless(id);
        }
      });

      // listen for document updates
      this.disposables.add(blockUpdatedSubscription);
      this.disposables.add(elementAddedSubscription);
      return;
    }

    let bounds = Bound.fromXYWH(deserializeXYWH(xywh));

    const viewport = controller.viewport;
    const blockComponent = this.std.view.getBlock(id);
    const parentComponent = blockComponent?.parentComponent;
    if (parentComponent && parentComponent.flavour === "myoxus:note") {
      const { left: x, width: w } = parentComponent.getBoundingClientRect();
      const { top: y, height: h } = blockComponent.getBoundingClientRect();
      const coord = viewport.toModelCoordFromClientCoord([x, y]);
      bounds = new Bound(
        coord[0],
        coord[1],
        w / viewport.zoom,
        h / viewport.zoom,
      );
    }

    const { zoom, centerX, centerY } = viewport.getFitToScreenData(
      bounds,
      [20, 20, 100, 20],
    );

    viewport.setZoom(zoom);
    viewport.setCenter(centerX, centerY);

    this.#listened = false;
    this.anchorBounds$.value = bounds;
  }

  #moveToAnchorInPage(id: string) {
    const blockComponent = this.std.view.getBlock(id);
    if (!blockComponent) {
      if (!this.#listened) return;

      // Store insertion precedes mounting: wait for the target view, not just
      // its model, before measuring and scrolling the rendered block.
      const subscription = this.std.view.viewUpdated.subscribe((v) => {
        if (v.type === "block" && v.method === "add" && v.id === id) {
          subscription.unsubscribe();
          if (this.anchor$.peek()?.id === id) this.#moveToAnchorInPage(id);
        }
      });
      this.disposables.add(subscription);
      return;
    }

    // use `requestAnimationFrame` to better scroll to the target
    // because sometimes it is impossible to scroll to the target
    if (this.#scrollFrame !== null) cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = null;
      if (!this.isConnected || this.anchor$.peek()?.id !== id) return;
      blockComponent.scrollIntoView({
        behavior: "instant",
        block: "center",
      });
    });

    this.#listened = false;
    this.anchorBounds$.value = Bound.fromDOMRect(
      blockComponent.getBoundingClientRect(),
    );
    this.requestUpdate();
  }

  override connectedCallback() {
    super.connectedCallback();

    this.#resizeObserver.observe(this.host);
    // The title lives outside editor-host. Its layout can move an unchanged
    // host, so observe the overlay's containing block as well as its content.
    void this.updateComplete.then(() => {
      if (this.isConnected && this.offsetParent) {
        this.#resizeObserver.observe(this.offsetParent);
      }
    });
    this.handleEvent("wheel", this.#requestUpdateFn);
    this.disposables.addFromEvent(window, "resize", this.#requestUpdateFn);
    this.disposables.addFromEvent(
      window,
      "scroll",
      this.#requestUpdateFn,
      true,
    );
    this.disposables.add(
      this.std.store.slots.blockUpdated.subscribe(this.#scheduleLayoutUpdate),
    );

    // Clears highlight
    this.disposables.addFromEvent(this.host, "pointerdown", () => {
      this.#listened = false;
      this.anchor$.value = null;
      this.anchorBounds$.value = null;
    });

    // In edgeless
    const controler = this.std.get(GfxControllerIdentifier);
    this.disposables.add(
      controler.viewport.viewportUpdated.subscribe(this.#requestUpdateFn),
    );

    this.disposables.add(
      this.anchor$.subscribe((anchor) => {
        if (!anchor) return;

        const { mode, id } = anchor;

        if (mode === "page") {
          this.#moveToAnchorInPage(id);
          return;
        }

        this.#moveToAnchorInEdgeless(id);
      }),
    );

    this.disposables.add(
      this.highlighted$.subscribe((highlighted) => {
        if (!highlighted) return;

        const {
          mode,
          blockIds: [bid],
          elementIds: [eid],
          highlight,
        } = highlighted;
        const id = mode === "page" ? bid : eid || bid;
        if (!id) return;

        // Consumes highlight selection
        this.std.selection.clear(["highlight"]);

        this.#listened = true;
        this.anchor$.value = { mode, id, highlight };
      }),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#resizeObserver.disconnect();
    if (this.#layoutFrame !== null) cancelAnimationFrame(this.#layoutFrame);
    if (this.#scrollFrame !== null) cancelAnimationFrame(this.#scrollFrame);
    this.#layoutFrame = null;
    this.#scrollFrame = null;
  }

  override render() {
    const anchor = this.anchor$.value;
    if (!anchor || !anchor.highlight) return nothing;

    const { mode, id } = anchor;

    const bounds =
      mode === "page" ? this.#getBoundsInPage(id) : this.#getBoundsInEdgeless();
    if (!bounds) return nothing;

    const classes = { highlight: true, [mode]: true };
    const style = {
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.w}px`,
      height: `${bounds.h}px`,
    };

    return html`<div
      class=${classMap(classes)}
      style=${styleMap(style)}
    ></div>`;
  }
}
