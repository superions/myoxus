// SPDX-License-Identifier: MIT
import type { TagMeta } from "@myoxus/core/components/page-list";
import type { CollectionMeta } from "@myoxus/core/modules/collection";
import {
  CollectionsIcon,
  ImageIcon,
  MoreHorizontalIcon,
  TagsIcon,
  UploadIcon,
} from "@myoxus/icons/lit";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import track, { type EventArgs } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { Signal, signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import type { DocMeta } from "@virgultum/editor/store";
import { nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { createElement } from "react";
import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { LinkedMenuItem } from "@virgultum/editor/widgets/linked-doc";
import {
  DocumentPickerIcon,
  DocumentPickerLabel,
} from "../../../view-extensions/editor-view/editor-chrome/document-picker-item";

import type { SearchMenuConfig } from "../ai-chat-add-context";
import { chatI18n } from "../chat-i18n";
import { ContextSearch, type ContextSearchOption } from "./context-picker";
import type { ChatChip, DocDisplayConfig } from "./type";

enum AddPopoverMode {
  Default = "default",
  Tags = "tags",
  Collections = "collections",
}
export type MenuGroup = {
  name: string;
  loading?: boolean | Signal<boolean>;
  items: MenuItem[] | Signal<MenuItem[]>;
  maxDisplay?: number;
  overflowText?: string | Signal<string>;
  divider?: () => TemplateResult<1>;
  noResult?: () => TemplateResult<1>;
};
export type MenuItem = Pick<
  LinkedMenuItem,
  "avatar" | "highlights" | "color"
> & {
  key: string;
  name: string | TemplateResult<1>;
  icon: TemplateResult<1> | MyoxusIconExportName;
  action: MenuAction;
  suffix?: string | TemplateResult<1>;
  testId?: string;
  disabled?: boolean | Signal<boolean>;
};
export type MenuAction = () => Promise<void> | void;
export function resolveSignal<T>(data: T | Signal<T>): T {
  return data instanceof Signal ? data.value : data;
}

/** Keeps search callbacks/identities in the existing controller; React owns chrome. */
export class ChatPanelAddPopover extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor independentMode: boolean | undefined;
  @property({ attribute: false }) accessor docId: string | undefined;
  @property({ attribute: false }) accessor searchMenuConfig!: SearchMenuConfig;
  @property({ attribute: false }) accessor docDisplayConfig!: DocDisplayConfig;
  @property({ attribute: false }) accessor addChip!: (
    chip: ChatChip,
  ) => Promise<void>;
  @property({ attribute: false }) accessor addImages!: (images: File[]) => void;
  @property({ attribute: false }) accessor abortController!: AbortController;
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "ai-search-input";
  @state() private accessor mode = AddPopoverMode.Default;
  @state() private accessor searchGroups: MenuGroup[] = [];
  private readonly query = signal("");
  private menuGroupController = new AbortController();

  override connectedCallback() {
    super.connectedCallback();
    this.updateSearchGroups();
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    this.menuGroupController.abort();
  }

  private readonly updateQuery = (query: string) => {
    this.query.value = query;
    this.updateSearchGroups();
  };
  private readonly toggleMode = (mode: AddPopoverMode) => {
    this.mode = mode;
    this.updateQuery("");
  };

  private get placeholder() {
    if (this.mode === AddPopoverMode.Tags)
      return chatI18n()["com.myoxus.selector-tag.search.placeholder"]();
    if (this.mode === AddPopoverMode.Collections)
      return chatI18n()["com.myoxus.selector-collection.search.placeholder"]();
    return chatI18n()["com.myoxus.ai.chat-panel.context-search"]();
  }

  private get groups(): MenuGroup[] {
    const groups = this.searchGroups.slice();
    if (this.mode !== AddPopoverMode.Default) return groups;
    if (!this.query.value)
      groups.push({
        name: chatI18n()["com.myoxus.ai.chat-panel.context-groups"](),
        items: [
          {
            key: "tags",
            name: chatI18n()["Tags"](),
            testId: "ai-chat-with-tags",
            icon: TagsIcon(),
            action: () => this.toggleMode(AddPopoverMode.Tags),
          },
          {
            key: "collections",
            name: chatI18n()["Collections"](),
            testId: "ai-chat-with-collections",
            icon: CollectionsIcon(),
            action: () => this.toggleMode(AddPopoverMode.Collections),
          },
        ],
      });
    groups.push({
      name: chatI18n()["Upload"](),
      items: [
        {
          key: "images",
          name: chatI18n()["com.myoxus.ai.chat-panel.upload-images"](),
          testId: "ai-chat-with-images",
          icon: ImageIcon(),
          action: () => {},
        },
        {
          key: "files",
          name: chatI18n()["com.myoxus.ai.chat-panel.upload-files"](),
          testId: "ai-chat-with-files",
          icon: UploadIcon(),
          action: () => {},
        },
      ],
    });
    return groups;
  }

  override render() {
    if (!this.reactToLit) return nothing;
    const options: ContextSearchOption[] = [];
    this.groups.forEach((group, groupIndex) => {
      const items = resolveSignal(group.items);
      const max = group.maxDisplay ?? items.length;
      const visible = items.slice(0, max);
      if (items.length > max)
        visible.push({
          key: `more-${groupIndex}`,
          name:
            resolveSignal(group.overflowText) ??
            chatI18n()["com.myoxus.editor.toolbar.more"](),
          icon: MoreHorizontalIcon(),
          action: () => {
            group.maxDisplay = undefined;
            this.requestUpdate();
          },
        });
      visible.forEach((item, index) =>
        options.push({
          id: `context-${groupIndex}-${index}`,
          value: item.key,
          title:
            typeof item.name === "string"
              ? createElement(DocumentPickerLabel, {
                  item: { name: item.name, highlights: item.highlights },
                })
              : toReactNode(item.name),
          group: group.name,
          leading:
            typeof item.icon === "string"
              ? createElement(DocumentPickerIcon, {
                  item: {
                    name: typeof item.name === "string" ? item.name : "",
                    icon: item.icon,
                    avatar: item.avatar,
                    color: item.color,
                  },
                })
              : toReactNode(item.icon),
          testId: item.testId,
          disabled: !!resolveSignal(item.disabled),
          action: () => this.run(item.action),
        }),
      );
    });
    return this.reactToLit(
      createElement(ContextSearch, {
        query: this.query,
        placeholder: this.placeholder,
        options,
        loading: this.groups.some((group) => !!resolveSignal(group.loading)),
        onQueryChange: this.updateQuery,
        onClose: () => this.abortController.abort(),
        onImages: (files) => {
          this.abortController.abort();
          this.addImages(files);
        },
        onFiles: (files) => {
          void this.run(() => this.addFiles(files));
        },
      }),
      true,
    );
  }

  private async run(action: MenuAction) {
    try {
      await action();
    } catch {
      notify({ title: chatI18n()["com.myoxus.ai.chat-panel.context-error"]() });
    }
  }

  private readonly addFiles = async (files: File[]) => {
    this.abortController.abort();
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length) this.addImages(images);
    await Promise.all(
      files
        .filter((file) => !file.type.startsWith("image/"))
        .map(async (file) => {
          if (file.size > 50 * 1024 * 1024) {
            notify({
              title: chatI18n()["com.myoxus.ai.chat-panel.file-too-large"]({
                name: file.name,
              }),
            });
            return;
          }
          await this.addChip({ file, state: "processing" });
        }),
    );
    this.track("file");
  };

  private updateSearchGroups() {
    this.menuGroupController.abort();
    this.menuGroupController = new AbortController();
    const query = this.query.value.trim();
    const signal = this.menuGroupController.signal;
    if (this.mode === AddPopoverMode.Tags) {
      this.searchGroups = [
        this.searchMenuConfig.getTagMenuGroup(query, this.addTag, signal),
      ];
      return;
    }
    if (this.mode === AddPopoverMode.Collections) {
      this.searchGroups = [
        this.searchMenuConfig.getCollectionMenuGroup(
          query,
          this.addCollection,
          signal,
        ),
      ];
      return;
    }
    this.searchGroups = [
      this.searchMenuConfig.getDocMenuGroup(query, this.addDoc, signal),
    ];
    if (query)
      this.searchGroups = [
        ...this.searchGroups,
        this.searchMenuConfig.getTagMenuGroup(query, this.addTag, signal),
        this.searchMenuConfig.getCollectionMenuGroup(
          query,
          this.addCollection,
          signal,
        ),
      ];
  }

  private readonly addDoc = async (meta: DocMeta) => {
    this.abortController.abort();
    await this.addChip({ docId: meta.id, state: "processing" });
    this.track(
      meta.id === this.docId ? "cur-doc" : "doc",
      this.docDisplayConfig.getDocPrimaryMode(meta.id),
    );
  };
  private readonly addTag = async (tag: TagMeta) => {
    this.abortController.abort();
    await this.addChip({ tagId: tag.id, state: "processing" });
    this.track("tags");
  };
  private readonly addCollection = async (collection: CollectionMeta) => {
    this.abortController.abort();
    await this.addChip({ collectionId: collection.id, state: "processing" });
    this.track("collections");
  };
  private track(
    method: EventArgs["addEmbeddingDoc"]["method"],
    type?: "page" | "edgeless",
  ) {
    const page = this.independentMode
      ? track.$.intelligence
      : track.$.chatPanel;
    page.chatPanelInput.addEmbeddingDoc({ control: "addButton", method, type });
  }
}
