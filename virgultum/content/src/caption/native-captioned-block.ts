// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect, signal } from "@preact/signals-core";
import {
  blockVersionWarning,
  installEditorStyles,
  NativeBlockComponent,
  type BlockService,
} from "@virgultum/core/runtime";
import type { BlockModel } from "@virgultum/core/store";
import type {} from "@virgultum/core/view/block-selection";
import type {} from "@virgultum/core/view/block-zero-width";

import type { BlockCaptionEditor } from "./caption-session.js";

export enum SelectedStyle {
  Background = "Background",
  Border = "Border",
}

const captionedBorderStyles = `
  @media screen {
    .myoxus-block-component.border .selected-style {
      border-radius: 8px;
      box-shadow: 0px 0px 0px 1px var(--myoxus-brand-color);
    }
  }
`;

export type BlockStyleMap = Record<string, string | undefined>;

/** Native DOM base for captioned document and embed blocks. */
export abstract class NativeCaptionedBlockComponent<
  Model extends BlockModel = BlockModel,
  Service extends BlockService = BlockService,
> extends NativeBlockComponent<Model, Service> {
  protected blockStyles = "";
  protected useCaptionEditor = false;
  protected useZeroWidth = false;

  protected readonly selectedStyle$ = signal<SelectedStyle>(
    SelectedStyle.Background,
  );
  protected readonly blockContainerStyles$ = signal<BlockStyleMap | undefined>(
    undefined,
  );
  protected readonly revision$ = signal(0);

  get selectedStyle() {
    return this.selectedStyle$.value;
  }
  set selectedStyle(value: SelectedStyle) {
    this.selectedStyle$.value = value;
  }

  get blockContainerStyles() {
    return this.blockContainerStyles$.value;
  }
  set blockContainerStyles(value: BlockStyleMap | undefined) {
    this.blockContainerStyles$.value = value;
  }

  get captionEditor() {
    // Block wrappers differ; the bound model identifies the owning caption,
    // including when a synced-document preview contains other captions.
    return [
      ...this.querySelectorAll<BlockCaptionEditor>("block-caption-editor"),
    ].find((caption) => caption.model === this.model);
  }

  override get updateComplete() {
    return Promise.resolve(this.isConnected);
  }

  override requestUpdate() {
    this.revision$.value = this.revision$.peek() + 1;
  }

  protected abstract mountBlock(container: HTMLElement): void;

  connectedCallback() {
    if (!this.connectBlock()) return;
    installEditorStyles(this, captionedBorderStyles);
    if (this.blockStyles) installEditorStyles(this, this.blockStyles);
    if (this.viewType === "hidden") return;
    if (this.isVersionMismatch) {
      this.replaceChildren(blockVersionWarning(this.ownerDocument, this.model));
      return;
    }

    const doc = this.ownerDocument;
    const frame = doc.createElement("div");
    frame.className = "myoxus-block-component";
    frame.style.position = "relative";

    const contentHost = doc.createElement("div");
    contentHost.style.display = "contents";
    frame.append(contentHost);

    let captionEl: BlockCaptionEditor | null = null;
    if (this.useCaptionEditor) {
      captionEl = doc.createElement(
        "block-caption-editor",
      ) as BlockCaptionEditor;
      captionEl.model = this.model as unknown as BlockCaptionEditor["model"];
      captionEl.std = this.std;
      frame.append(captionEl);
    }

    const selectionEl = doc.createElement("myoxus-block-selection");
    const zeroWidthEl = doc.createElement("block-zero-width");
    zeroWidthEl.block = this;

    this.replaceChildren(frame);

    let appliedKeys: string[] = [];
    this.disposables.add(
      effect(() => {
        const style = this.blockContainerStyles$.value;
        for (const key of appliedKeys) {
          if (!style || style[key] === undefined) {
            frame.style.setProperty(
              key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
              "",
            );
          }
        }
        appliedKeys = [];
        frame.style.position = "relative";
        if (style) {
          for (const [key, value] of Object.entries(style)) {
            if (value !== undefined) {
              (frame.style as unknown as Record<string, string>)[key] = value;
              appliedKeys.push(key);
            }
          }
        }
      }),
    );

    this.disposables.add(
      effect(() => {
        const mode = this.selectedStyle$.value;
        frame.classList.toggle("border", mode === SelectedStyle.Border);
        if (mode === SelectedStyle.Background) {
          selectionEl.selected = this.selected$.value;
          if (!selectionEl.parentNode) {
            frame.insertBefore(
              selectionEl,
              zeroWidthEl.parentNode === frame ? zeroWidthEl : null,
            );
          }
        } else if (selectionEl.parentNode) {
          selectionEl.remove();
        }
      }),
    );

    if (this.useZeroWidth) {
      this.disposables.add(
        effect(() => {
          if (this.store.readonly$.value) {
            zeroWidthEl.remove();
          } else if (!zeroWidthEl.parentNode) {
            frame.append(zeroWidthEl);
          }
        }),
      );
    }

    this.disposables.add(
      this.model.propsUpdated.subscribe(() => {
        this.requestUpdate();
      }),
    );

    this.mountBlock(contentHost);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.replaceChildren();
  }
}
