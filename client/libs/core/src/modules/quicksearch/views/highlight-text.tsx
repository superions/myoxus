// SPDX-License-Identifier: AGPL-3.0-or-later

import { Mark } from "@myoxus/ui-facade";
import { Fragment, useMemo } from "react";

type HighlightProps = {
  text: string;
  start: string;
  end: string;
};

type HighlightChunk = {
  value: string;
  highlighted: boolean;
};

/**
 * Projects positional search highlighter markers (`start` ... `end`, typically `<b>...</b>`)
 * onto Mantine's native `Mark` component without global substring false-positives.
 */
export const HighlightText = ({ text = "", end, start }: HighlightProps) => {
  const chunks = useMemo<HighlightChunk[]>(() => {
    if (!start || !end || !text.includes(start)) {
      return text ? [{ value: text, highlighted: false }] : [];
    }
    const result: HighlightChunk[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const startIndex = text.indexOf(start, cursor);
      if (startIndex === -1) {
        result.push({ value: text.slice(cursor), highlighted: false });
        break;
      }
      if (startIndex > cursor) {
        result.push({
          value: text.slice(cursor, startIndex),
          highlighted: false,
        });
      }
      const contentStart = startIndex + start.length;
      const endIndex = text.indexOf(end, contentStart);
      if (endIndex === -1) {
        result.push({ value: text.slice(contentStart), highlighted: false });
        break;
      }
      const match = text.slice(contentStart, endIndex);
      if (match) {
        result.push({ value: match, highlighted: true });
      }
      cursor = endIndex + end.length;
    }
    return result;
  }, [end, start, text]);

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.highlighted ? (
          <Mark key={index} color="myoxus">
            {chunk.value}
          </Mark>
        ) : (
          <Fragment key={index}>{chunk.value}</Fragment>
        ),
      )}
    </>
  );
};
