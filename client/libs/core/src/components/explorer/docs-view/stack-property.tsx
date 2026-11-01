import { Badge, BadgeList, BadgeListItem } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export const StackProperty = ({
  icon,
  children,
}: {
  icon: ReactNode | null;
  children: ReactNode;
}) => {
  return (
    <BadgeList>
      <BadgeListItem>
        <Badge prefix={icon ?? undefined}>{children}</Badge>
      </BadgeListItem>
    </BadgeList>
  );
};
