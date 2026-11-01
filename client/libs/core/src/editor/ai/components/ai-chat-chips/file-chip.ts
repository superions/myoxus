import { FileIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html } from "lit";
import { property } from "lit/decorators.js";

import type { FileChip } from "./type";
import { getChipIcon, getChipTooltip } from "./utils";

export class ChatPanelFileChip extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  @property({ attribute: false })
  accessor chip!: FileChip;

  @property({ attribute: false })
  accessor removeChip!: (chip: FileChip) => void;
  @property({ attribute: false }) accessor retryChip:
    ((chip: FileChip) => Promise<void>) | undefined;

  override render() {
    const { state, file } = this.chip;
    const tooltip = getChipTooltip(state, file.name, this.chip.tooltip);
    const icon = getChipIcon(state, FileIcon());

    return html`<chat-panel-chip
      .reactToLit=${this.reactToLit}
      .state=${state}
      .name=${file.name}
      .tooltip=${tooltip}
      .icon=${icon}
      .closeable=${true}
      .onChipDelete=${this.onChipDelete}
      .onChipRetry=${this.retryChip ? () => this.retryChip!(this.chip) : undefined}
    ></chat-panel-chip>`;
  }

  private readonly onChipDelete = () => {
    return this.removeChip(this.chip);
  };
}
