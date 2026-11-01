import type { BaseTextAttributes, DeltaInsert } from "@virgultum/store";

import { VElement } from "../components/v-element.js";
import type { InlineEditor } from "../inline-editor.js";
import type { InlineRange } from "../types.js";

/** UI operations cannot edit half of a keyed embed; body editing uses its host. */
export function expandRangeEmbeds<TextAttributes extends BaseTextAttributes>(
  editor: InlineEditor<TextAttributes>,
  range: InlineRange,
): InlineRange {
  let start = range.index;
  let end = range.index + range.length;
  let offset = 0;
  for (const delta of editor.embedDeltas) {
    const limit = offset + delta.insert.length;
    if (typeof editor.isEmbed(delta) === "string") {
      if (!range.length && start > offset && start < limit) {
        return { index: limit, length: 0 };
      }
      if (range.length && offset < end && limit > start) {
        start = Math.min(start, offset);
        end = Math.max(end, limit);
      }
    }
    offset = limit;
  }
  return { index: start, length: end - start };
}

export function isInEmbedElement(node: Node): boolean {
  if (node instanceof Element) {
    if (node instanceof VElement) {
      return node.querySelector('[data-v-embed="true"]') !== null;
    }
    const vElement = node.closest('[data-v-embed="true"]');
    return !!vElement;
  } else {
    const vElement = node.parentElement?.closest('[data-v-embed="true"]');
    return !!vElement;
  }
}

export function isInEmbedGap(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return false;
  return !!el.closest('[data-v-embed-gap="true"]');
}

export function transformDeltasToEmbedDeltas<
  TextAttributes extends BaseTextAttributes = BaseTextAttributes,
>(
  editor: InlineEditor<TextAttributes>,
  deltas: DeltaInsert<TextAttributes>[],
): DeltaInsert<TextAttributes>[] {
  // Legacy embeds remain single-character nodes. Keyed embeds retain the whole
  // canonical Yjs range (including line breaks), independent of formatting splits.
  const result: DeltaInsert<TextAttributes>[] = [];
  let previousKey: string | undefined;
  for (const delta of deltas) {
    const embed = editor.isEmbed(delta);
    if (typeof embed === "string") {
      if (!delta.insert.length) continue;
      const previous = result.at(-1);
      if (previous && previousKey === embed) {
        previous.insert += delta.insert;
      } else {
        result.push({ ...delta });
      }
      previousKey = embed;
      continue;
    }
    previousKey = undefined;
    if (embed) {
      const dividedDeltas = [...delta.insert].map((subInsert) => ({
        insert: subInsert,
        attributes: delta.attributes,
      }));
      result.push(...dividedDeltas);
    } else {
      result.push(delta);
    }
  }
  return result;
}
