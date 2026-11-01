// SPDX-License-Identifier: MIT
import type { TagMeta } from "@myoxus/core/components/page-list";
import { TagsIcon } from "@myoxus/icons/lit";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html } from "lit";
import { property } from "lit/decorators.js";

import type { TagChip } from "./type";
import { getChipTooltip } from "./utils";

export class ChatPanelTagChip extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor chip!: TagChip;
  @property({ attribute: false }) accessor removeChip!: (chip: TagChip) => void;
  @property({ attribute: false }) accessor tag!: TagMeta;

  override render() {
    const { state } = this.chip;
    const { name, color } = this.tag;
    return html`<chat-panel-chip
      .reactToLit=${this.reactToLit}
      .state=${state}
      .name=${name}
      .tagColor=${color}
      .icon=${TagsIcon()}
      .tooltip=${getChipTooltip(state, name, this.chip.tooltip)}
      .closeable=${state !== "processing"}
      .onChipDelete=${() => this.removeChip(this.chip)}
    ></chat-panel-chip>`;
  }
}
