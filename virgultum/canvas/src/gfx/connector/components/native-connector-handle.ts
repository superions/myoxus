// SPDX-License-Identifier: AGPL-3.0-or-later
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { ConnectorElementModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  CONNECTOR_HANDLE_SIZE,
  connectorHandleStyles,
  startConnectorReconnect,
} from "./connector-handle.js";

export interface EdgelessConnectorHandle extends HTMLElement {
  connector: ConnectorElementModel;
  std: BlockStdScope;
}

export function registerEdgelessConnectorHandle() {
  class ConnectorHandles
    extends HTMLElement
    implements EdgelessConnectorHandle
  {
    std!: BlockStdScope;
    private model!: ConnectorElementModel;
    private binding?: DisposableGroup;
    private finishReconnect?: () => void;
    private readonly start: HTMLDivElement;
    private readonly end: HTMLDivElement;

    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      const style = this.ownerDocument.createElement("style");
      style.textContent = connectorHandleStyles;
      this.start = this.ownerDocument.createElement("div");
      this.end = this.ownerDocument.createElement("div");
      this.start.className = "line-controller line-start";
      this.end.className = "line-controller line-end";
      root.append(style, this.start, this.end);
    }

    get connector() {
      return this.model;
    }

    set connector(model: ConnectorElementModel) {
      if (this.model !== model) this.finishReconnect?.();
      this.model = model;
      if (this.binding) this.updatePositions();
    }

    connectedCallback() {
      const gfx = this.std.get(GfxControllerIdentifier);
      const binding = new DisposableGroup();
      this.binding = binding;
      binding.addFromEvent(this.start, "pointerdown", (event) =>
        this.reconnect("source", this.start, event),
      );
      binding.addFromEvent(this.end, "pointerdown", (event) =>
        this.reconnect("target", this.end, event),
      );
      binding.add(gfx.viewport.viewportUpdated.subscribe(this.updatePositions));
      const surface = gfx.surface;
      if (surface) {
        binding.add(
          surface.elementUpdated.subscribe(({ id }) => {
            if (id === this.model.id) this.updatePositions();
          }),
        );
      }
      this.updatePositions();
    }

    disconnectedCallback() {
      this.finishReconnect?.();
      this.finishReconnect = undefined;
      this.binding?.dispose();
      this.binding = undefined;
    }

    private reconnect(
      endpoint: "source" | "target",
      handle: HTMLElement,
      event: PointerEvent,
    ) {
      this.finishReconnect?.();
      this.finishReconnect = startConnectorReconnect(
        this.std,
        this.model,
        endpoint,
        handle,
        event,
      );
    }

    /** Reproject the retained endpoints when zoom or a peer changes connector geometry. */
    private readonly updatePositions = () => {
      const path = this.model.path;
      const { zoom } = this.std.get(GfxControllerIdentifier).viewport;
      const half = CONNECTOR_HANDLE_SIZE / 2;
      for (const [node, point] of [
        [this.start, path[0]],
        [this.end, path.at(-1)],
      ] as const) {
        node.hidden = !point;
        if (point)
          node.style.transform = `translate3d(${point[0] * zoom - half}px,${point[1] * zoom - half}px,0)`;
      }
    };
  }

  customElements.define("edgeless-connector-handle", ConnectorHandles);
}
