// SPDX-License-Identifier: MIT
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";
import { ChatLoading } from "../components/message-chrome";

export class AILoading extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor stopGenerating!: () => void;
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "ai-loading";
  override render() {
    return this.reactToLit
      ? this.reactToLit(createElement(ChatLoading), true)
      : nothing;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "ai-loading": AILoading;
  }
}
