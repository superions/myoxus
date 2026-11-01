import { CollectionsIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html } from "lit";
import { property } from "lit/decorators.js";

import type { CollectionChip } from "./type";
import { getChipIcon, getChipTooltip } from "./utils";

export class ChatPanelCollectionChip extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  @property({ attribute: false })
  accessor chip!: CollectionChip;

  @property({ attribute: false })
  accessor removeChip!: (chip: CollectionChip) => void;

  @property({ attribute: false })
  accessor collection!: { id: string; name: string };

  override render() {
    const { state } = this.chip;
    const { name } = this.collection;
    const isLoading = state === "processing";
    const tooltip = getChipTooltip(state, name, this.chip.tooltip);
    const collectionIcon = CollectionsIcon();
    const icon = getChipIcon(state, collectionIcon);

    return html`<chat-panel-chip
      .reactToLit=${this.reactToLit}
      .state=${state}
      .name=${name}
      .tooltip=${tooltip}
      .icon=${icon}
      .closeable=${!isLoading}
      .onChipDelete=${this.onChipDelete}
    ></chat-panel-chip>`;
  }

  private readonly onChipDelete = () => {
    return this.removeChip(this.chip);
  };
}
