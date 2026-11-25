// SPDX-License-Identifier: AGPL-3.0-or-later

import { Highlight } from "@myoxus/ui-facade";
import { useMemo } from "react";

type HighlightProps = {
  text: string;
  start: string;
  end: string;
};

/**
 * Projects search highlighter markers (`start` ... `end`, typically `<b>...</b>`)
 * onto Mantine's native `Highlight` component without custom DOM highlight wrappers.
 */
export const HighlightText = ({ text = "", end, start }: HighlightProps) => {
  const { plainText, terms } = useMemo(() => {
    if (!start || !end || !text.includes(start)) {
      return { plainText: text, terms: [] as string[] };
    }
    const extracted: string[] = [];
    let plain = "";
    let cursor = 0;
    while (cursor < text.length) {
      const startIndex = text.indexOf(start, cursor);
      if (startIndex === -1) {
        plain += text.slice(cursor);
        break;
      }
      plain += text.slice(cursor, startIndex);
      const contentStart = startIndex + start.length;
      const endIndex = text.indexOf(end, contentStart);
      if (endIndex === -1) {
        plain += text.slice(contentStart);
        break;
      }
      const match = text.slice(contentStart, endIndex);
      if (match) {
        extracted.push(match);
        plain += match;
      }
      cursor = endIndex + end.length;
    }
    return {
      plainText: plain,
      terms: Array.from(new Set(extracted)),
    };
  }, [end, start, text]);

  return (
    <Highlight component="span" highlight={terms} inherit c="inherit">
      {plainText}
    </Highlight>
  );
};
