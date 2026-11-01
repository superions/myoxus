import type { TranscriptionBlockModel } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { BlockComponent, BlockViewExtension } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import { css, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { literal } from "lit/static-html.js";

export class LitTranscriptionBlock extends BlockComponent<TranscriptionBlockModel> {
  static override styles = [
    css`
      transcription-block {
        outline: none;
        display: flex;
        flex-direction: column;
        gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      }
    `,
  ];

  override render() {
    return this.std.host.renderChildren(this.model);
  }

  @property({ type: String, attribute: "data-block-id" })
  override accessor blockId!: string;

  constructor() {
    super();
    // questionable:
    this.widgets = {};

    // to allow text selection across paragraphs in the callout block
    this.contentEditable = "true";
  }

  override firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);
    this.disposables.addFromEvent(this, "click", this.onClick);
  }

  protected onClick(event: MouseEvent) {
    event.stopPropagation();
  }
}

export const AITranscriptionBlockSpec: ExtensionType[] = [
  BlockViewExtension("myoxus:transcription", () => {
    return literal`transcription-block`;
  }),
];
