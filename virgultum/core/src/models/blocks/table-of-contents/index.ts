// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "../../../store/index";

export type TocHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type TableOfContentsProps = {
  title: string;
  minLevel: TocHeadingLevel;
  maxLevel: TocHeadingLevel;
};

function clampTocLevel(
  value: unknown,
  fallback: TocHeadingLevel,
): TocHeadingLevel {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded <= 1) return 1;
  if (rounded >= 6) return 6;
  return rounded as TocHeadingLevel;
}

export function normalizeTocLevelRange(
  minLevel: unknown,
  maxLevel: unknown,
): { minLevel: TocHeadingLevel; maxLevel: TocHeadingLevel } {
  const min = clampTocLevel(minLevel, 1);
  const max = clampTocLevel(maxLevel, 3);
  return min <= max
    ? { minLevel: min, maxLevel: max }
    : { minLevel: min, maxLevel: min };
}

export function defaultTableOfContentsProps(): TableOfContentsProps {
  return {
    title: "",
    minLevel: 1,
    maxLevel: 3,
  };
}

/**
 * Native in-body table of contents block. Persists only authored title and
 * heading-level range; heading entries are always projected live from readable
 * document content without writing derived results to Yjs.
 */
export const TableOfContentsBlockSchema = defineBlockSchema({
  flavour: "myoxus:table-of-contents",
  props: defaultTableOfContentsProps,
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:note",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:callout",
    ],
    children: [],
  },
  toModel: () => new TableOfContentsBlockModel(),
});

export const TableOfContentsBlockSchemaExtension = BlockSchemaExtension(
  TableOfContentsBlockSchema,
);

export class TableOfContentsBlockModel extends BlockModel<TableOfContentsProps> {}
