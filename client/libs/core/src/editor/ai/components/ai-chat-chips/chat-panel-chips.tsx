// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

const MAX_CONTEXT_TOKENS = 100_000;
const MAX_INLINE_CANDIDATES = 3;

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

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, idx) => item === b[idx]);
}

/**
 * Renders active context chips and linked-document candidate suggestions,
 * preserving focus return into the owning chat composer when chips are removed.
 */
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
  const subscribedDocIdsRef = useRef<string[]>([]);
  const refCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const tagsSub = docDisplayConfig.getTags();
    const collectionsSub = docDisplayConfig.getCollections();
    setTagsSignal(tagsSub.signal);
    setCollectionsSignal(collectionsSub.signal);
    return () => {
      tagsSub.cleanup();
      collectionsSub.cleanup();
    };
  }, [docDisplayConfig]);

  const activeDocIds = useMemo(
    () =>
      chips
        .filter(isDocChip)
        .filter((chip) => chip.state !== "candidate")
        .map((chip) => chip.docId),
    [chips],
  );

  useEffect(() => {
    if (
      sameStringList(activeDocIds, subscribedDocIdsRef.current) &&
      refCleanupRef.current
    ) {
      return;
    }
    subscribedDocIdsRef.current = activeDocIds;
    // Acquire the replacement reference subscription before releasing the old
    // one so shared observables do not drop to zero subscribers mid-update.
    const nextRefs = docDisplayConfig.getReferenceDocs(activeDocIds);
    refCleanupRef.current?.();
    setReferenceDocsSignal(nextRefs.signal);
    refCleanupRef.current = nextRefs.cleanup;
  }, [activeDocIds, docDisplayConfig]);

  useEffect(
    () => () => {
      refCleanupRef.current?.();
      refCleanupRef.current = null;
      subscribedDocIdsRef.current = [];
    },
    [docDisplayConfig],
  );

  const tags = useSignalValue(tagsSignal) ?? [];
  const collections = useSignalValue(collectionsSignal) ?? [];
  const referenceDocs = useSignalValue(referenceDocsSignal) ?? [];

  const runChipAction = useCallback(
    async (action: () => void | Promise<void>, removing = false) => {
      const composer = containerRef.current?.closest(
        '[data-myoxus-ui-role="chat-composer"]',
      );
      const previousFocus = document.activeElement;
      try {
        await action();
        const currentFocus = document.activeElement;
        if (
          composer?.isConnected &&
          (removing || (previousFocus && !previousFocus.isConnected)) &&
          (currentFocus === document.body || currentFocus === previousFocus)
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

  const withinTokenBudget = useCallback(
    (target: DocChip, candidateTokens: number) => {
      let total = 0;
      for (const chip of chips) {
        if (isFileChip(chip) || isTagChip(chip) || isCollectionChip(chip)) {
          continue;
        }
        if (isDocChip(chip) && chip.docId === target.docId) {
          total += candidateTokens;
        } else if (
          isDocChip(chip) &&
          chip.markdown?.value &&
          chip.state === "finished"
        ) {
          total += chip.tokenCount ?? estimateTokenCount(chip.markdown.value);
        } else if (isSelectedContextChip(chip)) {
          total +=
            estimateTokenCount(chip.combinedElementsMarkdown ?? "") +
            estimateTokenCount(chip.snapshot ?? "") +
            estimateTokenCount(chip.html ?? "");
        }
      }
      return total <= MAX_CONTEXT_TOKENS;
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
          fits={withinTokenBudget}
          onRemove={() => void runChipAction(() => removeChip(chip), true)}
          onAdd={() =>
            void runChipAction(async () => {
              await addChip({ ...chip, state: "processing" });
              const tracker = independentMode
                ? track.$.intelligence
                : track.$.chatPanel;
              tracker.chatPanelInput.addEmbeddingDoc({
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
    let onRetry: (() => Promise<void>) | undefined;

    if (isFileChip(chip) || isAttachmentChip(chip)) {
      name = isFileChip(chip) ? chip.file.name : chip.name;
      icon = <FileIcon />;
      closeable = true;
      if (isFileChip(chip) && retryFileChip) {
        onRetry = () => retryFileChip(chip);
      } else if (isAttachmentChip(chip) && retryAttachmentChip) {
        onRetry = () => retryAttachmentChip(chip);
      }
    } else if (isTagChip(chip)) {
      const tag = tags.find((entry) => entry.id === chip.tagId);
      if (!tag) return null;
      name = tag.name;
      tagColor = tag.color;
      icon = <TagsIcon />;
    } else if (isCollectionChip(chip)) {
      const collection = collections.find(
        (entry) => entry.id === chip.collectionId,
      );
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
        onRemove={() => void runChipAction(() => removeChip(chip), true)}
        onRetry={onRetry ? () => void runChipAction(onRetry!) : undefined}
      />
    );
  };

  const candidates: DocChip[] = referenceDocs.map((doc) => ({
    docId: doc.docId,
    state: "candidate",
  }));
  const allItems = [...chips, ...candidates.slice(0, MAX_INLINE_CANDIDATES)];
  const collapsed = isCollapsed && allItems.length > 1;
  const displayed = collapsed ? allItems.slice(0, 1) : allItems;
  const overflowDocs = referenceDocs.slice(MAX_INLINE_CANDIDATES);

  return (
    <Box ref={containerRef} data-testid={testId}>
      <ChatChipsView
        hiddenCount={collapsed ? allItems.length - 1 : 0}
        onExpand={toggleCollapse}
        renderCandidates={
          !collapsed && candidates.length > MAX_INLINE_CANDIDATES
            ? (controller) => (
                <ContextSuggestions
                  docs={overflowDocs}
                  addChip={addChip}
                  config={docDisplayConfig}
                  controller={controller}
                />
              )
            : undefined
        }
      >
        {displayed.map((chip) => (
          <Fragment key={getChipKey(chip)}>{renderChip(chip)}</Fragment>
        ))}
      </ChatChipsView>
    </Box>
  );
}
