// SPDX-License-Identifier: MIT
import type { TagMeta } from "@myoxus/core/components/page-list";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { computed, type Signal, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { isEqual } from "lodash-es";
import { createElement, Fragment } from "react";

import type {
  AttachmentChip,
  ChatChip,
  DocChip,
  DocDisplayConfig,
  FileChip,
} from "./type";
import {
  estimateTokenCount,
  getChipKey,
  isAttachmentChip,
  isCollectionChip,
  isDocChip,
  isFileChip,
  isSelectedContextChip,
  isTagChip,
} from "./utils";
import { ChatChipsView } from "./view";

// Existing document-context token bound; the native view does not change it.
const MAX_TOKEN_COUNT = 100000;
const MAX_CANDIDATES = 3;

export class ChatPanelChips extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor chips!: ChatChip[];
  @property({ attribute: false }) accessor isCollapsed!: boolean;
  @property({ attribute: false }) accessor independentMode: boolean | undefined;
  @property({ attribute: false }) accessor addChip!: (
    chip: ChatChip,
  ) => Promise<void>;
  @property({ attribute: false }) accessor updateChip!: (
    chip: ChatChip,
    options: Partial<DocChip | FileChip>,
  ) => void;
  @property({ attribute: false }) accessor removeChip!: (
    chip: ChatChip,
  ) => Promise<void>;
  @property({ attribute: false }) accessor retryFileChip:
    ((chip: FileChip) => Promise<void>) | undefined;
  @property({ attribute: false }) accessor retryAttachmentChip:
    ((chip: AttachmentChip) => Promise<void>) | undefined;
  @property({ attribute: false }) accessor toggleCollapse!: () => void;
  @property({ attribute: false }) accessor docDisplayConfig!: DocDisplayConfig;
  @property({ attribute: false }) accessor portalContainer: HTMLElement | null =
    null;
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "chat-panel-chips";
  @state() accessor referenceDocs: Signal<
    Array<{ docId: string; title: string }>
  > = signal([]);
  private tags: Signal<TagMeta[]> = signal([]);
  private collections: Signal<Array<{ id: string; name: string }>> = signal([]);
  private cleanup: (() => void) | null = null;
  private docIds: string[] = [];

  private renderChip(chip: ChatChip): TemplateResult | null {
    if (isDocChip(chip))
      return html`<chat-panel-doc-chip
        .reactToLit=${this.reactToLit}
        .chip=${chip}
        .independentMode=${this.independentMode}
        .addChip=${this.addChip}
        .updateChip=${this.updateChip}
        .removeChip=${this.removeChip}
        .checkTokenLimit=${this.checkTokenLimit}
        .docDisplayConfig=${this.docDisplayConfig}
      ></chat-panel-doc-chip>`;
    if (isFileChip(chip))
      return html`<chat-panel-file-chip
        .reactToLit=${this.reactToLit}
        .chip=${chip}
        .removeChip=${this.removeChip}
        .retryChip=${this.retryFileChip}
      ></chat-panel-file-chip>`;
    if (isAttachmentChip(chip))
      return html`<chat-panel-attachment-chip
        .reactToLit=${this.reactToLit}
        .chip=${chip}
        .removeChip=${this.removeChip}
        .retryChip=${this.retryAttachmentChip}
      ></chat-panel-attachment-chip>`;
    if (isTagChip(chip)) {
      const tag = this.tags.value.find((tag) => tag.id === chip.tagId);
      return tag
        ? html`<chat-panel-tag-chip
            .reactToLit=${this.reactToLit}
            .chip=${chip}
            .tag=${tag}
            .removeChip=${this.removeChip}
          ></chat-panel-tag-chip>`
        : null;
    }
    if (isCollectionChip(chip)) {
      const collection = this.collections.value.find(
        (collection) => collection.id === chip.collectionId,
      );
      return collection
        ? html`<chat-panel-collection-chip
            .reactToLit=${this.reactToLit}
            .chip=${chip}
            .collection=${collection}
            .removeChip=${this.removeChip}
          ></chat-panel-collection-chip>`
        : null;
    }
    if (isSelectedContextChip(chip))
      return html`<chat-panel-selected-chip
        .reactToLit=${this.reactToLit}
        .chip=${chip}
        .removeChip=${this.removeChip}
      ></chat-panel-selected-chip>`;
    return null;
  }

  override render() {
    if (!this.reactToLit) return nothing;
    const candidates: DocChip[] = this.referenceDocs.value.map((doc) => ({
      docId: doc.docId,
      state: "candidate",
    }));
    const all = this.chips.concat(candidates.slice(0, MAX_CANDIDATES));
    const collapsed = this.isCollapsed && all.length > 1;
    const visible = collapsed ? all.slice(0, 1) : all;
    const moreDocs = computed(() =>
      this.referenceDocs.value.slice(MAX_CANDIDATES),
    );
    return this.reactToLit(
      createElement(
        ChatChipsView,
        {
          hiddenCount: collapsed ? all.length - 1 : 0,
          onExpand: this.toggleCollapse,
          renderCandidates:
            !collapsed && candidates.length > MAX_CANDIDATES
              ? (controller) =>
                  toReactNode(
                    html`<chat-panel-candidates-popover
                      .reactToLit=${this.reactToLit}
                      .referenceDocs=${moreDocs}
                      .addChip=${this.addChip}
                      .docDisplayConfig=${this.docDisplayConfig}
                      .abortController=${controller}
                    ></chat-panel-candidates-popover>`,
                  )
              : undefined,
        },
        visible.map((chip) =>
          createElement(
            Fragment,
            { key: getChipKey(chip) },
            toReactNode(this.renderChip(chip) ?? undefined),
          ),
        ),
      ),
      true,
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    const tags = this.docDisplayConfig.getTags();
    this.tags = tags.signal;
    this._disposables.add(tags.cleanup);
    const collections = this.docDisplayConfig.getCollections();
    this.collections = collections.signal;
    this._disposables.add(collections.cleanup);
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has("chips")) this.updateReferenceDocs();
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup?.();
  }

  private readonly checkTokenLimit = (
    newChip: DocChip,
    newTokenCount: number,
  ) => {
    const count = this.chips.reduce((acc, chip) => {
      if (isFileChip(chip) || isTagChip(chip) || isCollectionChip(chip))
        return acc;
      if (isDocChip(chip) && chip.docId === newChip.docId)
        return acc + newTokenCount;
      if (isDocChip(chip) && chip.markdown?.value && chip.state === "finished")
        return (
          acc + (chip.tokenCount ?? estimateTokenCount(chip.markdown.value))
        );
      if (isSelectedContextChip(chip))
        return (
          acc +
          estimateTokenCount(chip.combinedElementsMarkdown ?? "") +
          estimateTokenCount(chip.snapshot ?? "") +
          estimateTokenCount(chip.html ?? "")
        );
      return acc;
    }, 0);
    return count <= MAX_TOKEN_COUNT;
  };

  private updateReferenceDocs() {
    const ids = this.chips
      .filter(isDocChip)
      .filter((chip) => chip.state !== "candidate")
      .map((chip) => chip.docId);
    if (isEqual(ids, this.docIds)) return;
    this.cleanup?.();
    this.docIds = ids;
    const docs = this.docDisplayConfig.getReferenceDocs(ids);
    this.referenceDocs = docs.signal;
    this.cleanup = docs.cleanup;
  }
}
