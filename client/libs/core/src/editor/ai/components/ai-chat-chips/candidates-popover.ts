// SPDX-License-Identifier: MIT
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { notify } from "@myoxus/ui-facade";
import { type Signal, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { chatI18n } from "../chat-i18n";
import { ContextSearch, type ContextSearchOption } from "./context-picker";
import type { DocChip, DocDisplayConfig } from "./type";

export class ChatPanelCandidatesPopover extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor referenceDocs: Signal<
    Array<{ docId: string; title: string }>
  > = signal([]);
  @property({ attribute: false }) accessor abortController!: AbortController;
  @property({ attribute: false }) accessor addChip!: (
    chip: DocChip,
  ) => void | Promise<void>;
  @property({ attribute: false }) accessor docDisplayConfig!: DocDisplayConfig;
  private readonly query = signal("");

  override render() {
    if (!this.reactToLit) return nothing;
    const options: ContextSearchOption[] = this.referenceDocs.value
      .filter((doc) =>
        doc.title
          .toLocaleLowerCase()
          .includes(this.query.value.toLocaleLowerCase()),
      )
      .map((doc) => {
        const icon = this.docDisplayConfig.getIcon(doc.docId);
        return {
          id: `candidate-${doc.docId}`,
          value: doc.docId,
          title: this.docDisplayConfig.getTitle(doc.docId),
          leading: toReactNode(typeof icon === "function" ? icon() : icon),
          action: () => this.add(doc.docId),
        };
      });
    return this.reactToLit(
      createElement(ContextSearch, {
        query: this.query,
        placeholder: chatI18n()["com.myoxus.ai.chat-panel.context-search"](),
        options,
        onQueryChange: (query) => {
          this.query.value = query;
        },
        onClose: () => this.abortController.abort(),
        onFiles: () => {},
        onImages: () => {},
      }),
      true,
    );
  }
  private async add(docId: string) {
    try {
      await this.addChip({ docId, state: "processing" });
      this.abortController.abort();
    } catch {
      notify({ title: chatI18n()["com.myoxus.ai.chat-panel.context-error"]() });
    }
  }
}
