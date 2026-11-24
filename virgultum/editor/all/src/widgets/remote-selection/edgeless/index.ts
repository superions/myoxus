import { MultiCursorDuotoneIcon } from "@myoxus/icons/native";
import { EdgelessCRUDIdentifier } from "@virgultum/canvas-runtime/surface";
import type { RootBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { StoreSelectionExtension, type Store } from "@virgultum/core/store";
import {
  getSelectedRect,
  isTopLevelBlock,
  requestThrottledConnectedFrame,
} from "@virgultum/core/utils";
import {
  BlockSelection,
  CursorSelection,
  SurfaceSelection,
  TextSelection,
  NativeEditorWidget,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type GfxModel,
  type SurfaceBlockModel,
  type Viewport,
} from "@virgultum/core/runtime/gfx";
import { RemoteColorManager } from "../manager/remote-color-manager";

export const MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET =
  "myoxus-edgeless-remote-selection-widget";

const styles = `
    :host {
      pointer-events: none;
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: left top;
      contain: size layout;
      z-index: 1;
    }

    .remote-rect {
      position: absolute;
      top: 0;
      left: 0;
      border-radius: 4px;
      box-sizing: border-box;
      border-width: 3px;
      z-index: 1;
      transform-origin: center center;
    }

    .remote-cursor {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: left top;
      z-index: 1;
    }

    .remote-cursor > svg {
      display: block;
    }

    .remote-username {
      margin-left: 22px;
      margin-top: -2px;

      color: white;

      max-width: 160px;
      padding: 0px 3px;
      border: 1px solid var(--myoxus-pure-black-20);

      box-shadow: 0px 1px 6px 0px rgba(0, 0, 0, 0.16);
      border-radius: 4px;

      font-size: 12px;
      line-height: 18px;

      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

/** Both Canvas hosts paint awareness in model space with their own live camera. */
export function mountCanvasPeerOverlay(
  host: HTMLElement,
  store: Store,
  viewport: Viewport,
  surface: SurfaceBlockModel | null | undefined,
  getElement: (id: string) => GfxModel | null | undefined,
) {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const style = host.ownerDocument.createElement("style");
  style.textContent = styles;
  const overlay = host.ownerDocument.createElement("div");
  overlay.className = "myoxus-edgeless-remote-selection";
  shadow.replaceChildren(style, overlay);
  const rects = new Map<number, HTMLElement>();
  const cursors = new Map<number, HTMLElement>();
  const colors = new RemoteColorManager(store.awarenessStore);
  const selection = store.get(StoreSelectionExtension);
  const subscriptions = new DisposableGroup();
  const selections = new Map<number, CursorSelection>();
  const surfaces = new Map<number, SurfaceSelection[]>();
  const selectedIds = new Set<string>();
  const paintCursors = () => {
    const states = store.awarenessStore.getStates();
    for (const [id, cursor] of selections) {
      let node = cursors.get(id);
      if (!node) {
        node = host.ownerDocument.createElement("div");
        node.className = "remote-cursor";
        node.dataset.clientId = String(id);
        node.innerHTML = MultiCursorDuotoneIcon;
        const icon = node.querySelector("svg")!;
        icon.setAttribute("width", "24px");
        icon.setAttribute("height", "24px");
        icon.style.fill = icon.style.stroke = "currentColor";
        const label = host.ownerDocument.createElement("div");
        label.className = "remote-username";
        node.append(label);
        cursors.set(id, node);
        overlay.append(node);
      }
      const color = colors.get(id) ?? "";
      node.style.color = color;
      node.style.transform = `translate(${cursor.x}px, ${cursor.y}px) scale(calc(1/var(--v-zoom)))`;
      const label = node.lastElementChild as HTMLElement;
      label.style.backgroundColor = color;
      label.textContent = states.get(id)?.user?.name ?? "Unknown";
    }
    for (const [id, node] of cursors) {
      if (selections.has(id)) continue;
      node.remove();
      cursors.delete(id);
    }
  };
  const paintRects = () => {
    const visible = new Set<number>();
    for (const [id, selections] of surfaces) {
      for (const selection of selections) {
        const elements = selection.elements
          .map((key) => getElement(key))
          .filter((el): el is GfxModel => !!el);
        if (!elements.length) continue;
        const { left, top, width, height } = getSelectedRect(elements);
        if (!width || !height) continue;
        const rotate =
          elements.length === 1 && !isTopLevelBlock(elements[0])
            ? (elements[0].rotate ?? 0)
            : 0;
        let node = rects.get(id);
        if (!node) {
          node = host.ownerDocument.createElement("div");
          node.className = "remote-rect";
          node.dataset.clientId = String(id);
          rects.set(id, node);
          overlay.prepend(node);
        }
        visible.add(id);
        Object.assign(node.style, {
          width: `${width}px`,
          height: `${height}px`,
          borderStyle: "solid",
          borderColor: colors.get(id) ?? "",
          transform: `translate(${left}px, ${top}px) rotate(${rotate}deg)`,
        });
      }
    }
    for (const [id, node] of rects) {
      if (visible.has(id)) continue;
      node.remove();
      rects.delete(id);
    }
  };
  const receive = () => {
    selections.clear();
    surfaces.clear();
    selectedIds.clear();
    for (const [client, values] of selection.remoteSelections) {
      if (values.some((value) => value.is(TextSelection))) continue;
      const cursor = values.findLast((value) => value.is(CursorSelection));
      if (cursor) selections.set(client, cursor);
      if (values.some((value) => value.is(BlockSelection))) continue;
      const active = values.filter((value) => value.is(SurfaceSelection));
      if (active.length) {
        surfaces.set(client, active);
        for (const value of active)
          for (const id of value.elements) selectedIds.add(id);
      }
    }
    paintCursors();
    paintRects();
  };
  const elementChanged = (element: string | { id: string }) => {
    if (selectedIds.has(typeof element === "string" ? element : element.id))
      paintRects();
  };
  const transform = requestThrottledConnectedFrame(() => {
    const { translateX, translateY, zoom } = viewport;
    host.style.setProperty("--v-zoom", String(zoom));
    host.style.transform = `translate(${translateX}px, ${translateY}px) scale(var(--v-zoom))`;
  }, host);
  if (surface) {
    subscriptions.add(surface.elementAdded.subscribe(elementChanged));
    subscriptions.add(surface.elementRemoved.subscribe(elementChanged));
    subscriptions.add(surface.elementUpdated.subscribe(elementChanged));
  }
  subscriptions.add(store.slots.blockUpdated.subscribe(elementChanged));
  subscriptions.add(viewport.viewportUpdated.subscribe(transform));
  subscriptions.add(selection.slots.remoteChanged.subscribe(receive));
  transform();
  receive();
  return () => {
    subscriptions.dispose();
    shadow.replaceChildren();
  };
}

export class EdgelessRemoteSelectionWidget extends NativeEditorWidget<RootBlockModel> {
  override connectedCallback() {
    super.connectedCallback();
    const gfx = this.std.get(GfxControllerIdentifier);
    const crud = this.std.get(EdgelessCRUDIdentifier);
    this.disposables.add(
      mountCanvasPeerOverlay(
        this,
        this.store,
        gfx.viewport,
        gfx.surface,
        (id) => crud.getElementById(id),
      ),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET]: EdgelessRemoteSelectionWidget;
  }
}
