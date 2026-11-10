import { BlockComponent, type BlockService } from "@virgultum/std";
import type { BlockModel } from "@virgultum/store";
import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { type StyleInfo, styleMap } from "lit/directives/style-map.js";

import type { BlockCaptionEditor } from "./caption-session.js";
import { styles } from "./styles.js";

export enum SelectedStyle {
  Background = "Background",
  Border = "Border",
}

export class CaptionedBlockComponent<
  Model extends BlockModel = BlockModel,
  Service extends BlockService = BlockService,
  WidgetName extends string = string,
> extends BlockComponent<Model, Service, WidgetName> {
  static override styles = styles;

  get captionEditor() {
    // Block wrappers differ; the consumed model identifies the owning caption,
    // including when a synced-document preview contains other captions.
    return [
      ...this.querySelectorAll<BlockCaptionEditor>("block-caption-editor"),
    ].find((caption) => caption.model === this.model);
  }

  constructor() {
    super();
    this.addRenderer(this._renderWithWidget);
  }

  private _renderWithWidget(content: unknown) {
    const style = styleMap({
      position: "relative",
      ...this.blockContainerStyles,
    });

    return html`<div
      style=${style}
      class=${classMap({
        "myoxus-block-component": true,
        border: this.selectedStyle === SelectedStyle.Border,
      })}
    >
      ${content}
      ${
        this.useCaptionEditor
          ? html`<block-caption-editor></block-caption-editor>`
          : nothing
      }
      ${
        this.selectedStyle === SelectedStyle.Background
          ? html`<myoxus-block-selection
              .selected=${this.selected$.value}
            ></myoxus-block-selection>`
          : null
      }
      ${
        this.useZeroWidth && !this.store.readonly
          ? html`<block-zero-width .block=${this}></block-zero-width>`
          : nothing
      }
    </div>`;
  }

  protected accessor blockContainerStyles: StyleInfo | undefined = undefined;

  protected accessor selectedStyle = SelectedStyle.Background;

  protected accessor useCaptionEditor = false;

  protected accessor useZeroWidth = false;
}
