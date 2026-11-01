import { BadgeList, BadgeListItem } from "@myoxus/ui-facade";
import type { HTMLAttributes, PropsWithChildren } from "react";

import { TagItem } from "./tag";
import type { TagLike } from "./types";

interface InlineTagListProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange"
> {
  onRemoved?: (id: string) => void;
  tags: TagLike[];
  tagMode: "inline-tag" | "db-label";
  focusedIndex?: number;
}

export const InlineTagList = ({
  children,
  focusedIndex,
  tags,
  onRemoved,
  tagMode,
}: PropsWithChildren<InlineTagListProps>) => {
  return (
    <BadgeList data-testid="inline-tags-list" grow>
      {tags.map((tag, idx) => {
        if (!tag) {
          return null;
        }
        const handleRemoved = onRemoved
          ? () => {
              onRemoved?.(tag.id);
            }
          : undefined;
        return (
          <BadgeListItem key={tag.id}>
            <TagItem
              idx={idx}
              focused={focusedIndex === idx}
              onRemoved={handleRemoved}
              mode={tagMode}
              tag={tag}
            />
          </BadgeListItem>
        );
      })}
      {children ? <BadgeListItem grow>{children}</BadgeListItem> : null}
    </BadgeList>
  );
};
