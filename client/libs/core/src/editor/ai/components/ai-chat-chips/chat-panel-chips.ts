// SPDX-License-Identifier: MIT
import type { TagMeta } from "@myoxus/core/components/page-list";
import { type ReactToLit } from "@myoxus/lit-react";
import { type Signal, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { isEqual } from "lodash-es";
import { createElement, Fragment, type ReactNode } from "react";
import {
  FileIcon,
  TagsIcon,
  CollectionsIcon,
  UngroupIcon,
} from "@myoxus/icons/react";
import track from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { chatI18n } from "../chat-i18n";

import type {
  AttachmentChip,
  ChatChip,
  DocChip,
  DocDisplayConfig,
  FileChip,
} from "./type";
import {
  estimateTokenCount,
  getChipTooltip,
  getChipKey,
  isAttachmentChip,
  isCollectionChip,
  isDocChip,
  isFileChip,
  isSelectedContextChip,
  isTagChip,
} from "./utils";
import { ContextSuggestions } from "./context-options";
import { DocumentContextChip } from "./document-context-chip";
import { ChatChipView, ChatChipsView } from "./view";

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

  private async act(action: () => void | Promise<void>, removing = false) {
    const composer = this.closest("ai-chat-composer");
    const focused = document.activeElement;
    try {
      await action();
      // A removed chip may still be mounted until the portal commits. Restore
      // focus on acknowledgement unless the user already focused another control.
      const active = document.activeElement;
      if (
        composer?.isConnected &&
        (removing || (focused && !focused.isConnected)) &&
        (active === document.body || active === focused)
      ) {
        composer
          .querySelector<HTMLButtonElement>(
            'button[data-testid="chat-panel-with-button"]',
          )
          ?.focus();
      }
    } catch {
      notify({ title: chatI18n()["com.myoxus.ai.chat-panel.context-error"]() });
    }
  }

  private renderChip(chip: ChatChip): ReactNode {
    if (isDocChip(chip)) {
      return createElement(DocumentContextChip, {
        chip,
        config: this.docDisplayConfig,
        update: this.updateChip,
        fits: this.checkTokenLimit,
        onRemove: () => void this.act(() => this.removeChip(chip), true),
        onAdd: () =>
          void this.act(async () => {
            await this.addChip({ ...chip, state: "processing" });
            const scope = this.independentMode
              ? track.$.intelligence
              : track.$.chatPanel;
            scope.chatPanelInput.addEmbeddingDoc({
              control: "addButton",
              method: "suggestion",
              type: this.docDisplayConfig.getDocPrimaryMode(chip.docId),
            });
          }),
      });
    }
    let name: string;
    let icon: ReactNode;
    let tagColor: string | undefined;
    let closeable = chip.state !== "processing";
    let retry: (() => Promise<void>) | undefined;
    if (isFileChip(chip) || isAttachmentChip(chip)) {
      name = isFileChip(chip) ? chip.file.name : chip.name;
      icon = createElement(FileIcon);
      closeable = true;
      if (isFileChip(chip) && this.retryFileChip)
        retry = () => this.retryFileChip!(chip);
      if (isAttachmentChip(chip) && this.retryAttachmentChip)
        retry = () => this.retryAttachmentChip!(chip);
    } else if (isTagChip(chip)) {
      const tag = this.tags.value.find((tag) => tag.id === chip.tagId);
      if (!tag) return null;
      name = tag.name;
      tagColor = tag.color;
      icon = createElement(TagsIcon);
    } else if (isCollectionChip(chip)) {
      const collection = this.collections.value.find(
        (collection) => collection.id === chip.collectionId,
      );
      if (!collection) return null;
      name = collection.name;
      icon = createElement(CollectionsIcon);
    } else if (isSelectedContextChip(chip)) {
      name = chatI18n()["com.myoxus.ai.chat-panel.selected-content"]();
      icon = createElement(UngroupIcon);
    } else return null;
    return createElement(ChatChipView, {
      state: chip.state,
      name,
      icon,
      tagColor,
      closeable,
      tooltip: getChipTooltip(chip.state, name, chip.tooltip),
      onAdd: () => {},
      onRemove: () => void this.act(() => this.removeChip(chip), true),
      onRetry: retry ? () => void this.act(retry!) : undefined,
    });
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
    const moreDocs = this.referenceDocs.value.slice(MAX_CANDIDATES);
    return this.reactToLit(
      createElement(
        ChatChipsView,
        {
          hiddenCount: collapsed ? all.length - 1 : 0,
          onExpand: this.toggleCollapse,
          renderCandidates:
            !collapsed && candidates.length > MAX_CANDIDATES
              ? (controller) =>
                  createElement(ContextSuggestions, {
                    docs: moreDocs,
                    addChip: this.addChip,
                    config: this.docDisplayConfig,
                    controller,
                  })
              : undefined,
        },
        visible.map((chip) =>
          createElement(
            Fragment,
            { key: getChipKey(chip) },
            this.renderChip(chip),
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
    this.cleanup = null;
    this.docIds = [];
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
    this.docIds = ids;
    // Acquire retained sources before releasing the previous chip set, so a
    // shared reference read does not lose its final subscriber in between.
    const docs = this.docDisplayConfig.getReferenceDocs(ids);
    this.cleanup?.();
    this.referenceDocs = docs.signal;
    this.cleanup = docs.cleanup;
  }
}
