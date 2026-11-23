// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { RichText } from "@virgultum/content/rich-text";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { FrameBlockModel } from "@virgultum/core/models";
import {
  NativeViewElement,
  type BlockComponent,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/core/runtime/inline";
import { ThemeProvider } from "@virgultum/core/services";

import {
  frameTitleEditorCSS,
  positionFrameTitleEditor,
} from "./edgeless-frame-title-editor";

export class EdgelessFrameTitleEditor extends NativeViewElement {
  edgeless!: BlockComponent;
  frameModel!: FrameBlockModel;

  private active?: DisposableGroup;

  connectedCallback() {
    const { std } = this.edgeless;
    const { selection, viewport } = std.get(GfxControllerIdentifier);
    const active = new DisposableGroup();
    this.active = active;
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");

    const style = this.ownerDocument.createElement("style");
    style.textContent = frameTitleEditorCSS;
    const container = this.ownerDocument.createElement("div");
    container.className = "frame-title-editor";
    const richText = this.ownerDocument.createElement("rich-text") as RichText;
    richText.yText = this.frameModel.props.title.yText;
    richText.enableFormat = false;
    richText.enableAutoScrollHorizontally = false;
    richText.style.height = "fit-content";
    container.append(richText);

    const position = () =>
      positionFrameTitleEditor(container, this.frameModel, std);
    const close = () => {
      if (this.active !== active) return;
      this.active = undefined;
      active.dispose();
      selection.set({ elements: [], editing: false });
      this.remove();
    };
    position();
    this.replaceChildren(style, container);
    active.add(viewport.viewportUpdated.subscribe(position));
    active.add(this.frameModel.propsUpdated.subscribe(position));
    active.add(std.get(ThemeProvider).theme$.subscribe(position));
    active.add(
      std.store.readonly$.subscribe((readonly) => {
        if (readonly) close();
      }),
    );
    active.add(
      std.event.add("keyDown", (context) => {
        const { raw } = context.get("keyboardState");
        if (raw.key !== "Enter" || raw.isComposing) return false;
        close();
        return true;
      }),
    );
    active.add(std.event.add("click", () => true));
    active.add(std.event.add("doubleClick", () => true));
    void richText.updateComplete
      .then(() => {
        const inline = richText.inlineEditor;
        if (this.active !== active || !inline?.rootElement) return;
        inline.selectAll();
        active.addFromEvent(inline.rootElement, "blur", close);
      })
      .catch(console.error);
  }

  disconnectedCallback() {
    this.active?.dispose();
    this.active = undefined;
    this.replaceChildren();
  }
}
