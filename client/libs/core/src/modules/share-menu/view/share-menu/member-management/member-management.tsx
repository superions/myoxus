import { useGuard } from "@myoxus/core/components/guard";
import { DocService } from "@myoxus/core/modules/doc";
import {
  DocGrantedUsersService,
  type GrantedUser,
} from "@myoxus/core/modules/permissions";
import { useI18n } from "@myoxus/i18n";
import { ArrowLeftBigIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Divider,
  Group,
  InlineActionButton,
  MenuScrollableSection,
  Skeleton,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";
import { Virtuoso } from "react-virtuoso";

import { Scroller, SHARE_MENU_VIRTUAL_LIST_HEIGHT } from "../scroller";
import { MemberItem } from "./member-item";

export const MemberManagement = ({
  onClickBack,
  onClickInvite,
}: {
  onClickBack: () => void;
  onClickInvite: () => void;
}) => {
  const docGrantedUsersService = useService(DocGrantedUsersService);

  const grantedUserList = useLiveData(docGrantedUsersService.grantedUsers$);
  const grantedUserCount = useLiveData(
    docGrantedUsersService.grantedUserCount$,
  );
  const docService = useService(DocService);

  const canManageUsers = useGuard("Doc_Users_Manage", docService.doc.id);

  const t = useI18n();

  useEffect(() => {
    // reset the list when mounted
    docGrantedUsersService.reset();
    docGrantedUsersService.loadMore();
  }, [docGrantedUsersService]);

  const loadMore = useCallback(() => {
    docGrantedUsersService.loadMore();
  }, [docGrantedUsersService]);

  return (
    <Stack
      flex="1 1 auto"
      mih={0}
      data-myoxus-ui-role="share-menu-member-management"
    >
      <Button
        justifyContent="flex-start"
        onClick={onClickBack}
        prefix={<ArrowLeftBigIcon />}
        variant="plain"
        data-myoxus-ui-role="share-menu-back-button"
      >
        {t["com.myoxus.share-menu.member-management.header"]({
          memberCount: grantedUserCount?.toString() || "??",
        })}
      </Button>
      <Divider space="xs" />
      {grantedUserList ? (
        <MemberList
          grantedUserList={grantedUserList}
          grantedUserCount={grantedUserCount}
          loadMore={loadMore}
          canManageUsers={!!canManageUsers}
        />
      ) : (
        <Skeleton
          height={SHARE_MENU_VIRTUAL_LIST_HEIGHT}
          data-myoxus-ui-role="share-menu-members-loading"
        />
      )}
      <Divider space="xs" />
      <Group justify="flex-start">
        {canManageUsers ? (
          <InlineActionButton onClick={onClickInvite}>
            {t["com.myoxus.share-menu.member-management.add-collaborators"]()}
          </InlineActionButton>
        ) : null}
      </Group>
    </Stack>
  );
};

const MemberList = ({
  grantedUserList,
  grantedUserCount,
  loadMore,
  canManageUsers,
}: {
  canManageUsers: boolean;
  grantedUserList: GrantedUser[];
  grantedUserCount?: number;
  loadMore: () => void;
}) => {
  const itemContentRenderer = useCallback(
    (_index: number, data: GrantedUser) => {
      return (
        <MemberItem
          key={data.user.id}
          grantedUser={data}
          canManageUsers={canManageUsers}
        />
      );
    },
    [canManageUsers],
  );
  return (
    <Stack
      flex="1 1 auto"
      mah={SHARE_MENU_VIRTUAL_LIST_HEIGHT}
      mih={0}
      data-myoxus-ui-role="share-menu-managed-members-list"
    >
      {grantedUserList.length < 8 ? (
        <MenuScrollableSection maxHeight="default">
          {grantedUserList.map((item) => (
            <MemberItem
              key={item.user.id}
              grantedUser={item}
              canManageUsers={canManageUsers}
            />
          ))}
        </MenuScrollableSection>
      ) : (
        <Virtuoso
          components={{
            Scroller,
          }}
          data={grantedUserList}
          itemContent={itemContentRenderer}
          totalCount={grantedUserCount}
          endReached={loadMore}
        />
      )}
    </Stack>
  );
};
