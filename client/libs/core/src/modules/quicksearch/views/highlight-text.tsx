import {
  CommandPaletteHighlight,
  CommandPaletteHighlightKeyword,
} from "@myoxus/ui-facade";
import { Fragment, useMemo } from "react";

type HighlightProps = {
  text: string;
  start: string;
  end: string;
};

export const HighlightText = ({ text = "", end, start }: HighlightProps) => {
  const parts = useMemo(
    () =>
      text.split(start).flatMap((part) => {
        if (part.includes(end)) {
          const [highlighted, ...ending] = part.split(end);

          return [
            {
              h: highlighted,
            },
            ending.join(),
          ];
        } else {
          return part;
        }
      }),
    [end, start, text],
  );

  // Full matches leave repeated empty fragments on both sides of the keyword.
  return (
    <CommandPaletteHighlight>
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <Fragment key={index}>{part}</Fragment>
        ) : (
          <CommandPaletteHighlightKeyword key={part.h + "." + index}>
            {part.h}
          </CommandPaletteHighlightKeyword>
        ),
      )}
    </CommandPaletteHighlight>
  );
};
