// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { StreamObject } from "../components/ai-chat-messages";

/**
 * Coalesces consecutive text/reasoning deltas and replaces in-flight tool-call
 * entries with their matching tool-result entry while preserving item order.
 */
export function mergeStreamObjects(
  chunks: readonly StreamObject[] = [],
): StreamObject[] {
  const merged: StreamObject[] = [];
  for (const chunk of chunks) {
    const tail = merged.at(-1);
    if (
      (chunk.type === "text-delta" || chunk.type === "reasoning") &&
      tail?.type === chunk.type
    ) {
      merged[merged.length - 1] = {
        ...tail,
        textDelta: tail.textDelta + chunk.textDelta,
      };
      continue;
    }

    if (chunk.type === "tool-result") {
      const existingIndex = merged.findIndex(
        (entry) =>
          entry.type === "tool-call" &&
          entry.toolCallId === chunk.toolCallId &&
          entry.toolName === chunk.toolName,
      );
      if (existingIndex !== -1) {
        merged[existingIndex] = chunk;
        continue;
      }
    }

    merged.push(chunk);
  }
  return merged;
}

/** Concatenates only visible text-delta chunks from a stream object list. */
export function mergeStreamContent(chunks: readonly StreamObject[]): string {
  let out = "";
  for (const chunk of chunks) {
    if (chunk.type === "text-delta") {
      out += chunk.textDelta;
    }
  }
  return out;
}
