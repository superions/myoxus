// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export type CompactEmoji = {
  label: string;
  annotation?: string;
  group?: number;
  hexcode: string;
  order?: number;
  shortcodes?: string[];
  tags?: string[];
  unicode: string;
  skins?: Array<Omit<CompactEmoji, "skins">>;
};

export type EmojiGroup = { name: string; emojis: CompactEmoji[] };
export type IconKeyword = { name: string; keywords: string[] };

let emojiRequest: Promise<EmojiGroup[]> | undefined;
let keywordRequest: Promise<IconKeyword[]> | undefined;

// Panels request their own data. Successful imports and in-flight work survive
// panel disposal; failures release only that resource so an explicit retry works.
export function loadEmojiGroups(): Promise<EmojiGroup[]> {
  return (emojiRequest ??= import("../emoji-data.en.json")
    .then((module) => module.default as EmojiGroup[])
    .catch((error: unknown) => {
      emojiRequest = undefined;
      throw error;
    }));
}

export function loadIconKeywords(): Promise<IconKeyword[]> {
  return (keywordRequest ??= import("@myoxus/icons/keywords/en")
    .then((module) =>
      Object.values(
        module.default as Record<string, IconKeyword[] | undefined>,
      ).flatMap((group) => (Array.isArray(group) ? group : [])),
    )
    .catch((error: unknown) => {
      keywordRequest = undefined;
      throw error;
    }));
}
