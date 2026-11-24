// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GfxController } from "./controller.js";
import type { GfxBlockElementModel } from "./model/gfx-block-model.js";
import { GfxViewportRendering, gfxViewportStyle } from "./viewport-element.js";

export interface GfxViewportElement extends HTMLElement {
  gfx: GfxController;
  maxConcurrentRenders: number;
  enableChildrenSchedule: boolean;
  getModelsInViewport(): Set<GfxBlockElementModel>;
  setBlocksActive(blockIds: string[]): void;
  setBlocksIdle(blockIds: string[]): void;
}

/** Keep browser element construction out of the server and model entry points. */
export function registerGfxViewportElement() {
  const styled = new WeakSet<Node>();

  class CanvasViewportElement
    extends HTMLElement
    implements GfxViewportElement
  {
    gfx!: GfxController;
    maxConcurrentRenders = 2;
    enableChildrenSchedule = true;

    private rendering: GfxViewportRendering | undefined;
    declare scheduleUpdateChildren?: () => Promise<void>;

    connectedCallback() {
      const root = this.getRootNode();
      if (!styled.has(root)) {
        const style = this.ownerDocument.createElement("style");
        style.textContent = gfxViewportStyle;
        if (root instanceof ShadowRoot) root.prepend(style);
        else this.ownerDocument.head.append(style);
        styled.add(root);
      }

      const rendering = new GfxViewportRendering(
        this.gfx,
        () => this.maxConcurrentRenders,
      );
      this.rendering = rendering;
      if (this.enableChildrenSchedule)
        this.scheduleUpdateChildren = rendering.scheduleUpdateChildren;
    }

    disconnectedCallback() {
      delete this.scheduleUpdateChildren;
      this.rendering?.dispose();
      this.rendering = undefined;
    }

    getModelsInViewport() {
      return (
        this.rendering?.getModelsInViewport() ?? new Set<GfxBlockElementModel>()
      );
    }

    setBlocksActive(blockIds: string[]) {
      this.rendering?.setBlockVisibility(blockIds, "active");
    }

    setBlocksIdle(blockIds: string[]) {
      this.rendering?.setBlockVisibility(blockIds, "idle");
    }
  }

  customElements.define("gfx-viewport", CanvasViewportElement);
}
