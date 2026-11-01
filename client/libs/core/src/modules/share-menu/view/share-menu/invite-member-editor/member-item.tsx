import type { Member } from "@myoxus/core/modules/permissions";
import {
  Avatar,
  MenuDetailRow,
  SurfaceListAction,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

export const MemberItem = ({
  member,
  onSelect,
}: {
  member: Member;
  onSelect: (item: Member) => void;
}) => {
  const handleSelect = useCallback(() => {
    onSelect(member);
  }, [member, onSelect]);
  return (
    <SurfaceListAction
      onClick={handleSelect}
      data-myoxus-ui-role="share-menu-member-search-result"
    >
      <MenuDetailRow justify="start">
        <Avatar url={member.avatarUrl || ""} name={member.name || ""} />
        <SurfaceListItemMain compact>
          <SurfaceListText kind="title">{member.name}</SurfaceListText>
          <SurfaceListText kind="description">{member.email}</SurfaceListText>
        </SurfaceListItemMain>
      </MenuDetailRow>
    </SurfaceListAction>
  );
};
