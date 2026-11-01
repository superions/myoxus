import { BadgeList } from "@myoxus/ui-facade";
import type { HTMLAttributes } from "react";

import { MemberItem } from "./item";

interface InlineMemberListProps extends Omit<
  HTMLAttributes<HTMLUListElement>,
  "onChange"
> {
  members: string[];
  focusedIndex?: number;
  onRemove?: (id: string) => void;
}

export const InlineMemberList = ({
  className,
  children,
  members,
  focusedIndex,
  onRemove,
  ...props
}: InlineMemberListProps) => {
  return (
    <BadgeList className={className} {...props}>
      {members.map((member, idx) => (
        <MemberItem
          key={member}
          userId={member}
          focused={focusedIndex === idx}
          onRemove={onRemove ? () => onRemove(member) : undefined}
        />
      ))}
      {children}
    </BadgeList>
  );
};
