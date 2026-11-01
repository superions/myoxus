// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeltaOperation } from "@virgultum/store";
import { z } from "zod";

/** Identity only: the editable body is the attributed Yjs text itself. */
export const AnnotationSchema = z.object({ id: z.string().min(1) }).strict();
export type Annotation = z.infer<typeof AnnotationSchema>;

export type AnnotationRange = {
  id: string;
  index: number;
  length: number;
  body: string;
};

/** Derived ranges are never persisted. Adjacent deltas of one identity form one body. */
export function getAnnotationRanges(
  deltas: DeltaOperation[],
): AnnotationRange[] {
  const ranges: AnnotationRange[] = [];
  let index = 0;
  for (const delta of deltas) {
    if (typeof delta.insert !== "string") continue;
    const annotation = AnnotationSchema.safeParse(delta.attributes?.annotation);
    const previous = ranges.at(-1);
    if (annotation.success && delta.insert.length) {
      if (
        previous?.id === annotation.data.id &&
        previous.index + previous.length === index
      ) {
        previous.length += delta.insert.length;
        previous.body += delta.insert;
      } else {
        ranges.push({
          id: annotation.data.id,
          index,
          length: delta.insert.length,
          body: delta.insert,
        });
      }
    }
    index += delta.insert.length;
  }
  return ranges;
}

/** A marker copy includes its complete canonical body, even across formatted deltas. */
export function expandAnnotationSelection(
  deltas: DeltaOperation[],
  index: number,
  length: number,
): { index: number; length: number } {
  if (!length) return { index, length };
  let start = index;
  let end = index + length;
  for (const range of getAnnotationRanges(deltas)) {
    if (range.index < end && range.index + range.length > start) {
      start = Math.min(start, range.index);
      end = Math.max(end, range.index + range.length);
    }
  }
  return { index: start, length: end - start };
}

/** Copy only: share this map across the entire fragment, not each delta/block. */
export function remapAnnotationIdentities(
  value: unknown,
  generateId: () => string,
  identities = new Map<string, string>(),
): void {
  if (Array.isArray(value)) {
    value.forEach((child) =>
      remapAnnotationIdentities(child, generateId, identities),
    );
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record["$virgultum:internal:text$"] === true &&
      Array.isArray(record.delta)
    ) {
      for (const delta of record.delta as DeltaOperation[]) {
        const annotation = AnnotationSchema.safeParse(
          delta.attributes?.annotation,
        );
        if (!annotation.success) continue;
        let id = identities.get(annotation.data.id);
        if (!id) {
          id = generateId();
          identities.set(annotation.data.id, id);
        }
        delta.attributes = { ...delta.attributes, annotation: { id } };
      }
    } else {
      Object.values(record).forEach((child) =>
        remapAnnotationIdentities(child, generateId, identities),
      );
    }
  }
}
