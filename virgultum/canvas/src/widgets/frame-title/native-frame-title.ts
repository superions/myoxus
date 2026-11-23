// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { NativeViewElement } from "@virgultum/core/runtime";
import { effect } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { FrameBlockModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { ThemeProvider } from "@virgultum/core/services";

import {
  frameTitleColors,
  layoutFrameTitle,
  updateFrameTitleHitArea,
} from "./frame-title";
import { mountFrameTitleEditor } from "./mount-frame-title-editor";
import { frameTitleStyle } from "./styles";

export class MyoxusFrameTitle extends NativeViewElement {
  model!: FrameBlockModel;
  std!: BlockStdScope;

  private connection?: DisposableGroup;
  private scheduled = false;
  private nested = false;
  private readonly label = this.ownerDocument.createTextNode("");

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = frameTitleStyle.cssText;
    root.append(style, this.label);
  }

  get colors() {
    return frameTitleColors(this.std, this.model);
  }

  private get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  connectedCallback() {
    const { model, gfx } = this;
    const connection = new DisposableGroup();
    this.connection = connection;

    this.updateNesting();
    connection.add(gfx.viewport.viewportUpdated.subscribe(this.refresh));
    connection.add(gfx.selection.slots.updated.subscribe(this.refresh));
    connection.add(model.propsUpdated.subscribe(this.refresh));
    connection.add(
      model.store.slots.blockUpdated.subscribe((event) => {
        if (
          (event.type === "update" &&
            event.props.key === "xywh" &&
            model.store.getModelById(event.id) instanceof FrameBlockModel) ||
          (event.type === "add" && event.flavour === "myoxus:frame") ||
          (event.type === "delete" &&
            event.model instanceof FrameBlockModel &&
            event.model !== model)
        ) {
          this.updateNesting();
          this.refresh();
        }
      }),
    );

    const title = model.props.title.yText;
    title.observe(this.refresh);
    connection.add(() => title.unobserve(this.refresh));
    connection.add(
      effect(() => {
        void gfx.tool.currentToolName$.value;
        void this.std.get(ThemeProvider).theme$.value;
        this.refresh();
      }),
    );

    connection.addFromEvent(this, "click", (event) => {
      event.stopPropagation();
      gfx.selection.set({ elements: [model.id] });
    });
    connection.addFromEvent(this, "dblclick", () => {
      const root =
        this.std.store.root && this.std.view.getBlock(this.std.store.root.id);
      if (root && !model.isLocked()) mountFrameTitleEditor(model, root);
      else gfx.selection.set({ elements: [model.id] });
    });
  }

  disconnectedCallback() {
    this.connection?.dispose();
    this.connection = undefined;
    this.scheduled = false;
  }

  private updateNesting() {
    this.nested = this.gfx.grid.has(
      this.model.elementBound,
      true,
      true,
      (model) => model !== this.model && model instanceof FrameBlockModel,
    );
  }

  // Coalesce each store transaction and viewport tick before measuring the title.
  private readonly refresh = () => {
    const connection = this.connection;
    if (!connection || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      if (this.connection !== connection) return;
      this.scheduled = false;
      this.renderTitle();
    });
  };

  private renderTitle() {
    const { model, gfx } = this;
    const title = model.props.title.toString().trim();
    const editing =
      gfx.selection.selectedIds[0] === model.id && gfx.selection.editing;
    const zoom = gfx.viewport.zoom;
    const { viewportBounds } = gfx.viewport;
    if (this.label.data !== title) this.label.data = title;
    if (
      !title ||
      editing ||
      gfx.tool.currentToolName$.value === "frameNavigator"
    ) {
      this.style.display = "none";
    } else {
      layoutFrameTitle(this, model, zoom, this.nested, this.colors);
    }

    // Keep a hit area before the first frame enters the visible viewport.
    if (
      model.externalXYWH === undefined ||
      viewportBounds.contains(model.elementBound) ||
      viewportBounds.isIntersectWithBound(model.elementBound)
    ) {
      updateFrameTitleHitArea(
        gfx,
        model,
        zoom,
        this.nested,
        this.clientWidth,
        this.clientHeight,
      );
    }
  }
}
