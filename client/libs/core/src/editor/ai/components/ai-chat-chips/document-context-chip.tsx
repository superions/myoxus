// SPDX-License-Identifier: AGPL-3.0-or-later
import { signal } from "@preact/signals-core";
import throttle from "lodash-es/throttle";
import { useEffect, useEffectEvent, useState } from "react";

import { extractMarkdownFromDoc } from "../../utils/extract";
import { chatI18n } from "../chat-i18n";
import type { DocChip, DocDisplayConfig } from "./type";
import { estimateTokenCount, getChipTooltip } from "./utils";
import { ChatChipView } from "./view";

export function DocumentContextChip({
  chip,
  config,
  fits,
  update,
  onAdd,
  onRemove,
}: {
  chip: DocChip;
  config: DocDisplayConfig;
  fits: (chip: DocChip, tokens: number) => boolean;
  update: (chip: DocChip, change: Partial<DocChip>) => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const { docId, state } = chip;
  const [title, setTitle] = useState(() => config.getTitle(docId));
  useEffect(() => {
    const source = config.getTitleSignal(docId);
    const unsubscribe = source.signal.subscribe(setTitle);
    return () => {
      unsubscribe();
      source.cleanup();
    };
  }, [config, docId]);

  const applyText = useEffectEvent((text: string) => {
    const tokenCount = estimateTokenCount(text);
    if (fits(chip, tokenCount)) {
      const markdown = chip.markdown ?? signal("");
      markdown.value = text;
      update(chip, { markdown, tokenCount });
    } else {
      update(chip, {
        state: "failed",
        tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-too-large"](),
      });
    }
  });
  const fail = useEffectEvent(() => {
    update(chip, {
      state: "failed",
      tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
    });
  });
  const selected = state !== "candidate";
  useEffect(() => {
    if (!selected) return;
    const doc = config.getDoc(docId);
    if (!doc) {
      fail();
      return;
    }
    // A slow extraction must not overwrite a newer edit or revive a removed chip.
    let revision = 0;
    const refresh = throttle(async (version: number) => {
      try {
        if (!doc.ready) doc.load();
        const text = await extractMarkdownFromDoc(doc);
        if (version === revision) applyText(text);
      } catch {
        if (version === revision) fail();
      }
    }, 1000);
    const changes = doc.slots.blockUpdated.subscribe(() => {
      void refresh(++revision);
    });
    void refresh(++revision);
    return () => {
      ++revision;
      changes.unsubscribe();
      refresh.cancel();
    };
  }, [selected, config, docId]);

  return (
    <ChatChipView
      state={state}
      name={title}
      tooltip={getChipTooltip(state, title, chip.tooltip)}
      icon={config.getIcon(docId)}
      closeable={state !== "processing"}
      onAdd={onAdd}
      onRemove={onRemove}
    />
  );
}
