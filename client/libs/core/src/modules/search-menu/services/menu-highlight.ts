// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** Search transport markers become plain text and UTF-16 ranges, never HTML. */
export function decodeMenuHighlight(text: string) {
  let name = "";
  let start: number | undefined;
  const highlights: [number, number][] = [];
  for (const part of text.split(/([\uE000\uE001])/)) {
    if (part === "\uE000") start = name.length;
    else if (part === "\uE001") {
      if (start !== undefined) highlights.push([start, name.length]);
      start = undefined;
    } else name += part;
  }
  return { name, highlights };
}
