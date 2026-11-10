// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Avatar, ColorDot } from "@myoxus/ui-facade";
import { LinkIcon } from "@myoxus/icons/react";
import { getEditorGlyph } from "./glyphs";
import type { EditorDocumentPickerItem } from "@virgultum/editor/shared/services";

export function DocumentPickerIcon({
  item,
}: {
  item: Pick<EditorDocumentPickerItem, "icon" | "avatar" | "name" | "color">;
}) {
  const Glyph = getEditorGlyph(item.icon) ?? LinkIcon;
  if (item.color) return <ColorDot color={item.color} />;
  return item.avatar ? (
    <Avatar name={item.name} url={item.avatar} size="xs" />
  ) : (
    <Glyph aria-hidden />
  );
}

/** Plain provider text stays escaped, including highlighted search/member names. */
export function DocumentPickerLabel({
  item,
}: {
  item: Pick<EditorDocumentPickerItem, "name" | "highlights">;
}) {
  let offset = 0;
  const parts = [];
  for (const [start, end] of [...(item.highlights ?? [])].sort(
    (a, b) => a[0] - b[0],
  )) {
    const from = Math.max(offset, start);
    if (end <= from) continue;
    parts.push(
      item.name.slice(offset, from),
      <strong key={from}>{item.name.slice(from, end)}</strong>,
    );
    offset = end;
  }
  parts.push(item.name.slice(offset));
  return parts;
}
