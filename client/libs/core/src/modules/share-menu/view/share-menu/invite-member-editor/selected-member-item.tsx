import type { Member } from "@myoxus/core/modules/permissions";
import { Badge, BadgeListItem, RemovableBadge } from "@myoxus/ui-facade";

export interface TagItemProps {
  member: Member;
  idx?: number;
  onRemoved?: () => void;
}

export const SelectedMemberItem = ({
  member,
  idx,
  onRemoved,
}: TagItemProps) => {
  const content = onRemoved ? (
    <RemovableBadge
      removeLabel={member.name ? `Remove ${member.name}` : "Remove member"}
      onRemove={onRemoved}
    >
      {member.name}
    </RemovableBadge>
  ) : (
    <Badge>{member.name}</Badge>
  );

  return <BadgeListItem data-idx={idx}>{content}</BadgeListItem>;
};
