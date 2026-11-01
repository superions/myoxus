import { useGuard } from "@myoxus/core/components/guard/use-guard";
import {
  type Member,
  WorkspaceMembersService,
} from "@myoxus/core/modules/permissions";
import { type AuthAccountInfo, AuthService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { Permission, WorkspaceMemberStatus } from "@myoxus/graphql";
import { type I18nString, useI18n } from "@myoxus/i18n";
import { MoreVerticalIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Avatar,
  Badge,
  IconButton,
  Loading,
  Menu,
  notify,
  Pagination,
  SettingsControlEmpty,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  Stack,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListMeta,
} from "../../primitives";
import { ConfirmAssignModal } from "./confirm-assign-modal";
import { MemberOptions } from "./member-option";

export const MemberList = () => {
  const membersService = useService(WorkspaceMembersService);
  const t = useI18n();
  const canManageUsers = useGuard("Workspace_Users_Manage");
  const canManageAdmins = useGuard("Workspace_Administrators_Manage");
  const canTransferOwner = useGuard("Workspace_TransferOwner");
  const memberCount = useLiveData(membersService.members.memberCount$);
  const pageNum = useLiveData(membersService.members.pageNum$);
  const isLoading = useLiveData(membersService.members.isLoading$);
  const error = useLiveData(membersService.members.error$);
  const pageMembers = useLiveData(membersService.members.pageMembers$);

  useEffect(() => {
    membersService.members.revalidate();
  }, [membersService]);

  const session = useService(AuthService).session;
  const account = useLiveData(session.account$);

  const handlePageChange = useCallback(
    (_: number, pageNum: number) => {
      membersService.members.setPageNum(pageNum);
      membersService.members.revalidate();
    },
    [membersService],
  );

  if (!account) {
    return null;
  }

  return (
    <Stack data-myoxus-ui-role="settings-member-list" role="list">
      {pageMembers === undefined ? (
        isLoading ? (
          <MemberListFallback />
        ) : (
          <SettingsNotice tone="error" role="alert">
            {error
              ? UserFriendlyError.fromAny(error).message
              : t["com.myoxus.settings.common.load-error"]()}
          </SettingsNotice>
        )
      ) : (
        pageMembers?.map((member) => (
          <MemberItem
            currentAccount={account}
            key={member.id}
            member={member}
            canManageUsers={canManageUsers}
            canManageAdmins={canManageAdmins}
            canTransferOwner={canTransferOwner}
          />
        ))
      )}
      {memberCount !== undefined &&
        memberCount > membersService.members.PAGE_SIZE && (
          <Pagination
            totalCount={memberCount}
            countPerPage={membersService.members.PAGE_SIZE}
            pageNum={pageNum}
            onPageChange={handlePageChange}
          />
        )}
    </Stack>
  );
};

const getShouldShow = ({
  member,
  currentAccountId,
  canManageUsers,
  canManageAdmins,
  canTransferOwner,
}: {
  member: Member;
  currentAccountId: string;
  canManageUsers: boolean;
  canManageAdmins: boolean;
  canTransferOwner: boolean;
}) => {
  if (
    member.id === currentAccountId ||
    member.permission === Permission.Owner
  ) {
    return false;
  }
  return member.permission === Permission.Admin
    ? canManageAdmins || canTransferOwner
    : canManageUsers || canTransferOwner;
};

const MemberItem = ({
  member,
  canManageUsers,
  canManageAdmins,
  canTransferOwner,
  currentAccount,
}: {
  member: Member;
  canManageUsers: boolean;
  canManageAdmins: boolean;
  canTransferOwner: boolean;
  currentAccount: AuthAccountInfo;
}) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const membersService = useService(WorkspaceMembersService);
  const workspace = useService(WorkspaceService).workspace;
  const workspaceName = useLiveData(workspace.name$);
  const isEquals = workspaceName === inputValue;

  const show = useMemo(
    () =>
      getShouldShow({
        member,
        currentAccountId: currentAccount.id,
        canManageUsers,
        canManageAdmins,
        canTransferOwner,
      }),
    [member, currentAccount, canManageUsers, canManageAdmins, canTransferOwner],
  );

  const handleOpenAssignModal = useCallback(() => {
    setInputValue("");
    setOpen(true);
  }, []);

  const confirmAssign = useCallback(() => {
    membersService
      .adjustMemberPermission(member.id, Permission.Owner)
      .then((result) => {
        if (result) {
          setOpen(false);
          notify.success({
            title: t["com.myoxus.member.assign.notify.title"](),
            message: t["com.myoxus.member.assign.notify.message"]({
              name: member.name || member.email || member.id,
            }),
          });
          membersService.members.revalidate();
        }
      })
      .catch((error) => {
        notify.error({
          title: t["com.myoxus.common.operation-failed"](),
          message: error.message,
        });
      });
  }, [member, t, membersService]);

  const memberStatus = useMemo(() => getMemberStatus(member), [member]);
  const memberStatusTone = useMemo(() => getMemberStatusTone(member), [member]);
  const memberLabel = member.name || member.email || member.id;

  return (
    <SurfaceListItem
      key={member.id}
      component="li"
      appearance="row"
      density="compact"
      layout="row"
      alignItems="center"
      justifyContent="space-between"
      data-myoxus-ui-role="settings-member-row"
      data-testid="member-item"
    >
      <Avatar
        size="sm"
        url={member.avatarUrl}
        name={memberLabel}
        colorfulFallback
      />
      <SurfaceListItemMain compact grow>
        {member.name ? (
          <>
            <SettingsListItemTitle title={member.name} truncate>
              {member.name}
            </SettingsListItemTitle>
            <SettingsListItemMeta title={member.email} truncate>
              {member.email}
            </SettingsListItemMeta>
          </>
        ) : (
          <SettingsListItemTitle title={member.email} truncate>
            {member.email}
          </SettingsListItemTitle>
        )}
      </SurfaceListItemMain>
      <SurfaceListMeta layout="row-cluster">
        <Badge tone={memberStatusTone}>{t.t(memberStatus)}</Badge>
        <Menu
          items={
            <MemberOptions
              member={member}
              openAssignModal={handleOpenAssignModal}
              canManageUsers={canManageUsers}
              canManageAdmins={canManageAdmins}
              canTransferOwner={canTransferOwner}
            />
          }
        >
          <IconButton
            aria-label={`${t["Members"]()}: ${memberLabel}`}
            disabled={!show}
          >
            <MoreVerticalIcon />
          </IconButton>
        </Menu>
      </SurfaceListMeta>
      <ConfirmAssignModal
        open={open}
        setOpen={setOpen}
        member={member}
        inputValue={inputValue}
        placeholder={workspaceName}
        setInputValue={setInputValue}
        isEquals={isEquals}
        onConfirm={confirmAssign}
      />
    </SurfaceListItem>
  );
};

const getMemberStatus = (member: Member): I18nString => {
  switch (member.status) {
    case WorkspaceMemberStatus.NeedMoreSeat:
      return "insufficient-team-seat";
    case WorkspaceMemberStatus.Pending:
      return "Pending";
    case WorkspaceMemberStatus.UnderReview:
      return "Under-Review";
    case WorkspaceMemberStatus.AllocatingSeat:
      return "Allocating Seat";
    case WorkspaceMemberStatus.Accepted:
      switch (member.permission) {
        case Permission.Owner:
          return "Owner";
        case Permission.Admin:
          return "Admin";
        case Permission.Collaborator:
          return "Collaborator";
        case Permission.Commenter:
          return "Commenter";
        case Permission.Manager:
          return "Manager";
        case Permission.Reader:
          return "Reader";
        default:
          return "Member";
      }
    default:
      return "Pending";
  }
};

const getMemberStatusTone = (
  member: Member,
): "neutral" | "success" | "warning" | "error" => {
  if (member.status === WorkspaceMemberStatus.NeedMoreSeat) {
    return "error";
  }
  if (member.status !== WorkspaceMemberStatus.Accepted) {
    return "warning";
  }
  return "neutral";
};

export const MemberListFallback = () => {
  const t = useI18n();

  return (
    <SurfaceListItem
      component="div"
      appearance="row"
      density="compact"
      layout="row"
      alignItems="center"
      data-myoxus-ui-role="settings-member-loading-row"
    >
      <Loading />
      <SettingsControlEmpty>
        {t["com.myoxus.settings.member.loading"]()}
      </SettingsControlEmpty>
    </SurfaceListItem>
  );
};
