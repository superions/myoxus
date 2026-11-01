import { DocGrantedUsersService } from "@myoxus/core/modules/permissions";
import { DocRole } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  AvatarStack,
  MenuDetailRow,
  MenuInlineText,
  Skeleton,
  SurfaceListAction,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListText,
  Tooltip,
} from "@myoxus/ui-facade";
import { useEffect, useMemo } from "react";

export { MemberManagement } from "./member-management";

export const MembersRow = ({ onClick }: { onClick: () => void }) => {
  const t = useI18n();
  const docGrantedUsersService = useService(DocGrantedUsersService);

  const grantedUserList = useLiveData(docGrantedUsersService.grantedUsers$);
  const grantedUserCount = useLiveData(
    docGrantedUsersService.grantedUserCount$,
  );
  const loading = useLiveData(docGrantedUsersService.isLoading$);
  const docOwner = useLiveData(
    docGrantedUsersService.grantedUsers$.map((users) =>
      users.find((user) => user.role === DocRole.Owner),
    ),
  );

  const topThreeMembers = useMemo(
    () =>
      grantedUserList
        ?.slice(0, Math.min(3, grantedUserList.length))
        .map((grantedUser) => ({
          name: grantedUser.user.name,
          avatarUrl: grantedUser.user.avatarUrl,
          id: grantedUser.user.id,
        })),
    [grantedUserList],
  );

  const description = useMemo(() => {
    if (!grantedUserCount || !topThreeMembers || topThreeMembers.length <= 1) {
      return "";
    }
    switch (grantedUserCount) {
      case 2:
        return t["com.myoxus.share-menu.member-management.member-count-2"]({
          member1: topThreeMembers[0].name,
          member2: topThreeMembers[1].name,
        });
      case 3:
        return t["com.myoxus.share-menu.member-management.member-count-3"]({
          member1: topThreeMembers[0].name,
          member2: topThreeMembers[1].name,
          member3: topThreeMembers[2].name,
        });
      default:
        return t["com.myoxus.share-menu.member-management.member-count-more"]({
          member1: topThreeMembers[0].name,
          member2: topThreeMembers[1].name,
          memberCount: (grantedUserCount - 2).toString(),
        });
    }
  }, [grantedUserCount, t, topThreeMembers]);

  useEffect(() => {
    docGrantedUsersService.reset();
    docGrantedUsersService.loadMore();
  }, [docGrantedUsersService]);

  if (
    grantedUserCount &&
    topThreeMembers &&
    topThreeMembers.length > 1 &&
    grantedUserCount > 1
  ) {
    return (
      <Tooltip content={description}>
        <SurfaceListAction
          onClick={onClick}
          data-myoxus-ui-role="share-menu-members-row"
        >
          <MenuDetailRow
            justify="start"
            right={
              <SurfaceListItemIcon size="sm">
                <ArrowRightSmallIcon />
              </SurfaceListItemIcon>
            }
          >
            <AvatarStack kind="user">
              {topThreeMembers.map((member) => (
                <Avatar
                  key={member.id}
                  url={member.avatarUrl || ""}
                  name={member.name || ""}
                />
              ))}
            </AvatarStack>
            <SurfaceListText kind="description">{description}</SurfaceListText>
          </MenuDetailRow>
        </SurfaceListAction>
      </Tooltip>
    );
  }

  if (!docOwner && loading) {
    // is loading
    return (
      <MenuDetailRow>
        <Skeleton />
      </MenuDetailRow>
    );
  }

  // TODO(@JimmFly): handle the case when there is only one member
  return (
    <SurfaceListAction
      onClick={onClick}
      data-myoxus-ui-role="share-menu-members-row"
    >
      <MenuDetailRow
        justify="start"
        right={
          <>
            {docOwner ? (
              <MenuInlineText tone="secondary">{t["Owner"]()}</MenuInlineText>
            ) : null}
            <SurfaceListItemIcon size="sm">
              <ArrowRightSmallIcon />
            </SurfaceListItemIcon>
          </>
        }
      >
        {docOwner ? (
          <>
            <Avatar
              url={docOwner.user.avatarUrl || ""}
              name={docOwner.user.name}
            />
            <SurfaceListItemMain compact>
              <SurfaceListText kind="title">
                {docOwner.user.name}
              </SurfaceListText>
            </SurfaceListItemMain>
          </>
        ) : (
          <SurfaceListText kind="title">
            {t["com.myoxus.share-menu.invite-editor.manage-members"]()}
          </SurfaceListText>
        )}
      </MenuDetailRow>
    </SurfaceListAction>
  );
};
