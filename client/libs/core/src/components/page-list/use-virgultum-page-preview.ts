// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { Store } from "@virgultum/editor/store";
import { type Atom, atom } from "jotai";

const PREVIEW_CHAR_LIMIT = 150;
const PREVIEW_BLOCK_LIMIT = 30;

const previewAtoms = new WeakMap<Store, Atom<string>>();
const EMPTY_PREVIEW_ATOM = atom<string>("");

export const getPagePreviewText = (page: Store): string => {
  const root = page.root;
  if (!root) {
    return "";
  }

  const segments: string[] = [];
  const stack = [root];
  let remainingChars = PREVIEW_CHAR_LIMIT;
  let remainingBlocks = PREVIEW_BLOCK_LIMIT;

  while (stack.length > 0 && remainingChars > 0 && remainingBlocks-- > 0) {
    if (segments.join(" ").trim().length >= PREVIEW_CHAR_LIMIT) {
      break;
    }

    const block = stack.shift();
    if (!block) break;

    // Exclude edgeless canvas surface blocks from text-based page snippets.
    if (block.flavour === "myoxus:surface") {
      continue;
    }

    if (block.children?.length) {
      stack.unshift(...block.children);
    }

    if (block.role !== "content") {
      continue;
    }

    if (block.text) {
      const value = block.text.toString();
      if (value.length > 0) {
        remainingChars -= value.length;
        segments.push(value);
      }
    } else {
      const kind = block.flavour.split("myoxus:")[1];
      if (kind) {
        remainingChars -= kind.length + 2;
        segments.push(`[${kind}]`);
      }
    }
  }

  return segments.join(" ").trim().slice(0, PREVIEW_CHAR_LIMIT);
};

export function useVirgultumPagePreview(page: Store | null): Atom<string> {
  if (!page) {
    return EMPTY_PREVIEW_ATOM;
  }

  const cached = previewAtoms.get(page);
  if (cached) {
    return cached;
  }

  const previewAtom = atom<string>("");
  previewAtom.onMount = (setValue) => {
    const refresh = () => setValue(getPagePreviewText(page));
    const subscriptions = [
      page.slots.ready.subscribe(refresh),
      page.slots.blockUpdated.subscribe(refresh),
    ];
    refresh();
    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    };
  };

  previewAtoms.set(page, previewAtom);
  return previewAtom;
}
