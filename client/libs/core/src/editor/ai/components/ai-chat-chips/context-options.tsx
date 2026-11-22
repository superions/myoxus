// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CollectionsIcon,
  ImageIcon,
  MoreHorizontalIcon,
  TagsIcon,
  UploadIcon,
} from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import track, { type EventArgs } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { effect, Signal } from "@preact/signals-core";
import type {
  LinkedMenuGroup,
  LinkedMenuItem,
} from "@virgultum/editor/widgets/linked-doc";
import { useEffectEvent, useLayoutEffect, useState } from "react";

import {
  DocumentPickerIcon,
  DocumentPickerLabel,
} from "../../../view-extensions/editor-view/editor-chrome/document-picker-item";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import {
  ContextPicker,
  ContextSearch,
  type ContextSearchOption,
} from "./context-picker";
import type { ChatChip, DocDisplayConfig } from "./type";

type Mode = "all" | "tags" | "collections";
type AddContextProps = {
  disabled: boolean;
  docId?: string;
  independentMode?: boolean;
  searchMenuConfig: SearchMenuConfig;
  docDisplayConfig: DocDisplayConfig;
  addChip: (chip: ChatChip) => Promise<void>;
  addImages: (images: File[]) => void;
};

export function AddContext(props: AddContextProps) {
  return (
    <ContextPicker
      disabled={props.disabled}
      renderContent={(controller) => (
        <AddContextSearch {...props} controller={controller} />
      )}
    />
  );
}

function read<T>(value: T | Signal<T>): T {
  return value instanceof Signal ? value.value : value;
}

function useCurrentGroups(
  config: SearchMenuConfig,
  mode: Mode,
  query: string,
  controller: AbortController,
  search: (query: string, signal: AbortSignal) => LinkedMenuGroup[],
) {
  const [result, setResult] = useState<{
    config: SearchMenuConfig;
    mode: Mode;
    query: string;
    groups: Array<{
      name: string;
      maxDisplay?: number;
      overflowText?: string;
      items: LinkedMenuItem[];
    }>;
    loading: boolean;
  }>();
  const load = useEffectEvent(search);

  useLayoutEffect(() => {
    if (controller.signal.aborted) return;
    const request = new AbortController();
    const cancel = () => request.abort();
    controller.signal.addEventListener("abort", cancel);
    const groups = load(query, request.signal);
    const unsubscribe = effect(() => {
      setResult({
        config,
        mode,
        query,
        groups: groups.map((group) => ({
          name: group.name,
          items: read(group.items),
          maxDisplay: group.maxDisplay,
          overflowText: read(group.overflowText),
        })),
        loading: groups.some((group) => read(group.loading)),
      });
    });
    return () => {
      controller.signal.removeEventListener("abort", cancel);
      unsubscribe();
      request.abort();
    };
  }, [config, controller, mode, query]);

  // React may paint between the input change and acquisition of the next search.
  return result?.config === config &&
    result.mode === mode &&
    result.query === query
    ? result
    : undefined;
}

function AddContextSearch({
  controller,
  docId,
  independentMode,
  searchMenuConfig,
  docDisplayConfig,
  addChip,
  addImages,
}: AddContextProps & { controller: AbortController }) {
  const t = useI18n();
  const [mode, setMode] = useState<Mode>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number[]>([]);
  const telemetry = independentMode ? track.$.intelligence : track.$.chatPanel;
  const record = (
    method: EventArgs["addEmbeddingDoc"]["method"],
    type?: "page" | "edgeless",
  ) =>
    telemetry.chatPanelInput.addEmbeddingDoc({
      control: "addButton",
      method,
      type,
    });

  const add = async (
    chip: ChatChip,
    method: EventArgs["addEmbeddingDoc"]["method"],
    type?: "page" | "edgeless",
  ) => {
    controller.abort();
    await addChip(chip);
    record(method, type);
  };
  const result = useCurrentGroups(
    searchMenuConfig,
    mode,
    query.trim(),
    controller,
    (term, signal) => {
      const tags = () =>
        searchMenuConfig.getTagMenuGroup(
          term,
          (tag) => add({ tagId: tag.id, state: "processing" }, "tags"),
          signal,
        );
      const collections = () =>
        searchMenuConfig.getCollectionMenuGroup(
          term,
          (collection) =>
            add(
              { collectionId: collection.id, state: "processing" },
              "collections",
            ),
          signal,
        );
      if (mode === "tags") return [tags()];
      if (mode === "collections") return [collections()];

      const docs = searchMenuConfig.getDocMenuGroup(
        term,
        (meta) =>
          add(
            { docId: meta.id, state: "processing" },
            meta.id === docId ? "cur-doc" : "doc",
            docDisplayConfig.getDocPrimaryMode(meta.id),
          ),
        signal,
      );
      return term ? [docs, tags(), collections()] : [docs];
    },
  );

  const changeQuery = (value: string) => {
    setQuery(value);
    setExpanded([]);
  };
  const browse = (value: Mode) => {
    setMode(value);
    changeQuery("");
  };
  const options: ContextSearchOption[] = [];
  result?.groups.forEach((group, index) => {
    const limit = expanded.includes(index) ? undefined : group.maxDisplay;
    for (const item of group.items.slice(0, limit)) {
      options.push({
        id: `group-${index}-${item.key}`,
        value: item.key,
        group: group.name,
        title: <DocumentPickerLabel item={item} />,
        leading: <DocumentPickerIcon item={item} />,
        disabled: item.disabled,
        action: item.action,
      });
    }
    if (limit !== undefined && group.items.length > limit) {
      options.push({
        id: `more-${index}`,
        value: `more-${index}`,
        group: group.name,
        title: group.overflowText ?? t["com.myoxus.editor.toolbar.more"](),
        leading: <MoreHorizontalIcon />,
        action: () => setExpanded((groups) => [...groups, index]),
      });
    }
  });

  if (mode === "all") {
    if (!query) {
      const group = t["com.myoxus.ai.chat-panel.context-groups"]();
      options.push(
        {
          id: "tags",
          value: "tags",
          group,
          title: t["Tags"](),
          leading: <TagsIcon />,
          testId: "ai-chat-with-tags",
          action: () => browse("tags"),
        },
        {
          id: "collections",
          value: "collections",
          group,
          title: t["Collections"](),
          leading: <CollectionsIcon />,
          testId: "ai-chat-with-collections",
          action: () => browse("collections"),
        },
      );
    }
    const group = t["Upload"]();
    options.push(
      {
        id: "images",
        value: "images",
        group,
        title: t["com.myoxus.ai.chat-panel.upload-images"](),
        leading: <ImageIcon />,
        testId: "ai-chat-with-images",
        action: () => {},
      },
      {
        id: "files",
        value: "files",
        group,
        title: t["com.myoxus.ai.chat-panel.upload-files"](),
        leading: <UploadIcon />,
        testId: "ai-chat-with-files",
        action: () => {},
      },
    );
  }

  return (
    <ContextSearch
      query={query}
      options={options}
      loading={!result || result.loading}
      placeholder={
        mode === "tags"
          ? t["com.myoxus.selector-tag.search.placeholder"]()
          : mode === "collections"
            ? t["com.myoxus.selector-collection.search.placeholder"]()
            : t["com.myoxus.ai.chat-panel.context-search"]()
      }
      onQueryChange={changeQuery}
      onClose={() => controller.abort()}
      onImages={(files) => {
        controller.abort();
        addImages(files);
      }}
      onFiles={async (files) => {
        controller.abort();
        const images = files.filter((file) => file.type.startsWith("image/"));
        if (images.length) addImages(images);
        await Promise.all(
          files
            .filter((file) => !file.type.startsWith("image/"))
            .map(async (file) => {
              if (file.size > 50 * 1024 * 1024) {
                notify({
                  title: t["com.myoxus.ai.chat-panel.file-too-large"]({
                    name: file.name,
                  }),
                });
                return;
              }
              await addChip({ file, state: "processing" });
            }),
        );
        record("file");
      }}
    />
  );
}

export function ContextSuggestions({
  docs,
  config,
  controller,
  addChip,
}: {
  docs: ReadonlyArray<{ docId: string; title: string }>;
  config: DocDisplayConfig;
  controller: AbortController;
  addChip: (chip: ChatChip) => Promise<void>;
}) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  return (
    <ContextSearch
      query={query}
      placeholder={t["com.myoxus.ai.chat-panel.context-search"]()}
      options={docs
        .filter((doc) =>
          doc.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .map((doc) => ({
          id: `candidate-${doc.docId}`,
          value: doc.docId,
          title: config.getTitle(doc.docId),
          leading: config.getIcon(doc.docId),
          action: async () => {
            await addChip({ docId: doc.docId, state: "processing" });
            controller.abort();
          },
        }))}
      onQueryChange={setQuery}
      onClose={() => controller.abort()}
    />
  );
}
