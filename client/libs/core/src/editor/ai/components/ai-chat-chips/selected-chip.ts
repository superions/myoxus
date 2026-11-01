import { UngroupIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html } from "lit";
import { property } from "lit/decorators.js";

import type { SelectedContextChip } from "./type";
import { getChipIcon, getChipTooltip } from "./utils";
import { chatI18n } from "../chat-i18n";

export class ChatPanelSelectedChip extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  @property({ attribute: false })
  accessor chip!: SelectedContextChip;

  @property({ attribute: false })
  accessor removeChip!: (chip: SelectedContextChip) => void;

  override render() {
    const { state } = this.chip;
    const isLoading = state === "processing";
    const tooltip = getChipTooltip(
      state,
      chatI18n()["com.myoxus.ai.chat-panel.selected-content"](),
      this.chip.tooltip,
    );

    const icon = getChipIcon(state, UngroupIcon());

    return html`<chat-panel-chip
      .reactToLit=${this.reactToLit}
      .state=${state}
      .name=${chatI18n()["com.myoxus.ai.chat-panel.selected-content"]()}
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
