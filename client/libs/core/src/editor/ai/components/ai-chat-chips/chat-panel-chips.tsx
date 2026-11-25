// SPDX-License-Identifier: MIT

import type { TagMeta } from "@myoxus/core/components/page-list";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import {
  CollectionsIcon,
  FileIcon,
  TagsIcon,
  UngroupIcon,
} from "@myoxus/icons/react";
import track from "@myoxus/track";
import { Box, notify } from "@myoxus/ui-facade";
import { signal, type Signal } from "@preact/signals-core";
import { isEqual } from "lodash-es";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { chatI18n } from "../chat-i18n";
import { ContextSuggestions } from "./context-options";
import { DocumentContextChip } from "./document-context-chip";
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
  getChipTooltip,
  isAttachmentChip,
  isCollectionChip,
  isDocChip,
  isFileChip,
  isSelectedContextChip,
  isTagChip,
} from "./utils";
import { ChatChipsView, ChatChipView } from "./view";

// Existing document-context token bound; the native view does not change it.
const MAX_TOKEN_COUNT = 100000;
const MAX_CANDIDATES = 3;

const EMPTY_TAGS = signal<TagMeta[]>([]);
const EMPTY_COLLECTIONS = signal<Array<{ id: string; name: string }>>([]);
const EMPTY_REFS = signal<Array<{ docId: string; title: string }>>([]);

export interface ChatPanelChipsProps {
  chips: ChatChip[];
  isCollapsed: boolean;
  independentMode?: boolean;
  addChip: (chip: ChatChip) => Promise<void>;
  updateChip: (chip: ChatChip, options: Partial<DocChip | FileChip>) => void;
  removeChip: (chip: ChatChip) => Promise<void>;
  retryFileChip?: (chip: FileChip) => Promise<void>;
  retryAttachmentChip?: (chip: AttachmentChip) => Promise<void>;
  toggleCollapse: () => void;
  docDisplayConfig: DocDisplayConfig;
  testId?: string;
}

export function ChatPanelChips({
  chips,
  isCollapsed,
  independentMode,
  addChip,
  updateChip,
  removeChip,
  retryFileChip,
  retryAttachmentChip,
  toggleCollapse,
  docDisplayConfig,
  testId = "chat-panel-chips",
}: ChatPanelChipsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tagsSignal, setTagsSignal] = useState<Signal<TagMeta[]>>(EMPTY_TAGS);
  const [collectionsSignal, setCollectionsSignal] =
    useState<Signal<Array<{ id: string; name: string }>>>(EMPTY_COLLECTIONS);
  const [referenceDocsSignal, setReferenceDocsSignal] =
    useState<Signal<Array<{ docId: string; title: string }>>>(EMPTY_REFS);
  const docIdsRef = useRef<string[]>([]);
  const refCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const tags = docDisplayConfig.getTags();
    const collections = docDisplayConfig.getCollections();
    setTagsSignal(tags.signal);
    setCollectionsSignal(collections.signal);
    return () => {
      tags.cleanup();
      collections.cleanup();
    };
  }, [docDisplayConfig]);

  const docIds = useMemo(
    () =>
      chips
        .filter(isDocChip)
        .filter((chip) => chip.state !== "candidate")
        .map((chip) => chip.docId),
    [chips],
  );

  useEffect(() => {
    if (isEqual(docIds, docIdsRef.current) && refCleanupRef.current) return;
    docIdsRef.current = docIds;
    // Acquire retained sources before releasing the previous chip set, so a
    // shared reference read does not lose its final subscriber in between.
    const docs = docDisplayConfig.getReferenceDocs(docIds);
    refCleanupRef.current?.();
    setReferenceDocsSignal(docs.signal);
    refCleanupRef.current = docs.cleanup;
  }, [docDisplayConfig, docIds]);

  useEffect(() => {
    return () => {
      refCleanupRef.current?.();
      refCleanupRef.current = null;
      docIdsRef.current = [];
    };
  }, [docDisplayConfig]);

  const tags = useSignalValue(tagsSignal) ?? [];
  const collections = useSignalValue(collectionsSignal) ?? [];
  const referenceDocs = useSignalValue(referenceDocsSignal) ?? [];

  const act = useCallback(
    async (action: () => void | Promise<void>, removing = false) => {
      const composer = containerRef.current?.closest(
        '[data-myoxus-ui-role="chat-composer"]',
      );
      const focused = document.activeElement;
      try {
        await action();
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
        notify({
          title: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
        });
      }
    },
    [],
  );

  const checkTokenLimit = useCallback(
    (newChip: DocChip, newTokenCount: number) => {
      const count = chips.reduce((acc, chip) => {
        if (isFileChip(chip) || isTagChip(chip) || isCollectionChip(chip))
          return acc;
        if (isDocChip(chip) && chip.docId === newChip.docId)
          return acc + newTokenCount;
        if (
          isDocChip(chip) &&
          chip.markdown?.value &&
          chip.state === "finished"
        )
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
    },
    [chips],
  );

  const renderChip = (chip: ChatChip): ReactNode => {
    if (isDocChip(chip)) {
      return (
        <DocumentContextChip
          chip={chip}
          config={docDisplayConfig}
          update={updateChip}
          fits={checkTokenLimit}
          onRemove={() => void act(() => removeChip(chip), true)}
          onAdd={() =>
            void act(async () => {
              await addChip({ ...chip, state: "processing" });
              const scope = independentMode
                ? track.$.intelligence
                : track.$.chatPanel;
              scope.chatPanelInput.addEmbeddingDoc({
                control: "addButton",
                method: "suggestion",
                type: docDisplayConfig.getDocPrimaryMode(chip.docId),
              });
            })
          }
        />
      );
    }

    let name: string;
    let icon: ReactNode;
    let tagColor: string | undefined;
    let closeable = chip.state !== "processing";
    let retry: (() => Promise<void>) | undefined;

    if (isFileChip(chip) || isAttachmentChip(chip)) {
      name = isFileChip(chip) ? chip.file.name : chip.name;
      icon = <FileIcon />;
      closeable = true;
      if (isFileChip(chip) && retryFileChip) retry = () => retryFileChip(chip);
      if (isAttachmentChip(chip) && retryAttachmentChip)
        retry = () => retryAttachmentChip(chip);
    } else if (isTagChip(chip)) {
      const tag = tags.find((t) => t.id === chip.tagId);
      if (!tag) return null;
      name = tag.name;
      tagColor = tag.color;
      icon = <TagsIcon />;
    } else if (isCollectionChip(chip)) {
      const collection = collections.find((c) => c.id === chip.collectionId);
      if (!collection) return null;
      name = collection.name;
      icon = <CollectionsIcon />;
    } else if (isSelectedContextChip(chip)) {
      name = chatI18n()["com.myoxus.ai.chat-panel.selected-content"]();
      icon = <UngroupIcon />;
    } else {
      return null;
    }

    return (
      <ChatChipView
        state={chip.state}
        name={name}
        icon={icon}
        tagColor={tagColor}
        closeable={closeable}
        tooltip={getChipTooltip(chip.state, name, chip.tooltip)}
        onAdd={() => {}}
        onRemove={() => void act(() => removeChip(chip), true)}
        onRetry={retry ? () => void act(retry!) : undefined}
      />
    );
  };

  const candidates: DocChip[] = referenceDocs.map((doc) => ({
    docId: doc.docId,
    state: "candidate",
  }));
  const all = chips.concat(candidates.slice(0, MAX_CANDIDATES));
  const collapsed = isCollapsed && all.length > 1;
  const visible = collapsed ? all.slice(0, 1) : all;
  const moreDocs = referenceDocs.slice(MAX_CANDIDATES);

  return (
    <Box ref={containerRef} data-testid={testId}>
      <ChatChipsView
        hiddenCount={collapsed ? all.length - 1 : 0}
        onExpand={toggleCollapse}
        renderCandidates={
          !collapsed && candidates.length > MAX_CANDIDATES
            ? (controller) => (
                <ContextSuggestions
                  docs={moreDocs}
                  addChip={addChip}
                  config={docDisplayConfig}
                  controller={controller}
                />
              )
            : undefined
        }
      >
        {visible.map((chip) => (
          <Fragment key={getChipKey(chip)}>{renderChip(chip)}</Fragment>
        ))}
      </ChatChipsView>
    </Box>
  );
}
