// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import { useCallback, useEffect, useState } from "react";

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

const ACCEPTED_ROLE_LABEL: Partial<Record<Permission, I18nString>> = {
  [Permission.Owner]: "Owner",
  [Permission.Admin]: "Admin",
  [Permission.Collaborator]: "Collaborator",
  [Permission.Commenter]: "Commenter",
  [Permission.Manager]: "Manager",
  [Permission.Reader]: "Reader",
  [Permission.External]: "com.myoxus.workspace-content-operation.role.external",
};

function getMemberStatusLabel(member: Member): I18nString {
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
      return ACCEPTED_ROLE_LABEL[member.permission] ?? "Member";
    default:
      return "Pending";
  }
}

function getMemberStatusTone(
  member: Member,
): "neutral" | "success" | "warning" | "error" {
  if (member.status === WorkspaceMemberStatus.NeedMoreSeat) return "error";
  if (member.status !== WorkspaceMemberStatus.Accepted) return "warning";
  return "neutral";
}

function canOpenMemberMenu({
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
}): boolean {
  if (
    !member.directRole ||
    member.id === currentAccountId ||
    member.permission === Permission.Owner
  ) {
    return false;
  }
  return member.directRole === Permission.Admin
    ? canManageAdmins || canTransferOwner
    : canManageUsers || canTransferOwner;
}

function MemberRow({
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
}) {
  const t = useI18n();
  const membersService = useService(WorkspaceMembersService);
  const workspace = useService(WorkspaceService).workspace;
  const workspaceName = useLiveData(workspace.name$);

  const [assignOpen, setAssignOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  const memberLabel = member.name || member.email || member.id;
  const showMenu = canOpenMemberMenu({
    member,
    currentAccountId: currentAccount.id,
    canManageUsers,
    canManageAdmins,
    canTransferOwner,
  });

  const handleOpenAssign = useCallback(() => {
    setConfirmInput("");
    setAssignOpen(true);
  }, []);

  const handleConfirmAssign = useCallback(() => {
    membersService
      .adjustMemberPermission(member.id, Permission.Owner)
      .then((updated) => {
        if (!updated) return;
        setAssignOpen(false);
        notify.success({
          title: t["com.myoxus.member.assign.notify.title"](),
          message: t["com.myoxus.member.assign.notify.message"]({
            name: memberLabel,
          }),
        });
        membersService.members.revalidate();
      })
      .catch((error) => {
        notify.error({
          title: t["com.myoxus.common.operation-failed"](),
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [member.id, memberLabel, membersService, t]);

  return (
    <SurfaceListItem
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
        {member.directRole ? (
          <SettingsListItemMeta>
            {t["com.myoxus.member.role.direct"]({
              role: t.t(
                member.directRole === Permission.External
                  ? "com.myoxus.workspace-content-operation.role.external"
                  : member.directRole,
              ),
            })}
          </SettingsListItemMeta>
        ) : null}
        {member.ouRole ? (
          <SettingsListItemMeta>
            {t["com.myoxus.member.role.inherited"]({
              role: t.t(
                member.ouRole === Permission.External
                  ? "com.myoxus.workspace-content-operation.role.external"
                  : member.ouRole,
              ),
              units: member.ouNames.join(", "),
            })}
          </SettingsListItemMeta>
        ) : null}
        <Badge tone={getMemberStatusTone(member)}>
          {t.t(getMemberStatusLabel(member))}
        </Badge>
        <Menu
          items={
            <MemberOptions
              member={member}
              openAssignModal={handleOpenAssign}
              canManageUsers={canManageUsers}
              canManageAdmins={canManageAdmins}
              canTransferOwner={canTransferOwner}
            />
          }
        >
          <IconButton
            aria-label={`${t["Members"]()}: ${memberLabel}`}
            disabled={!showMenu}
          >
            <MoreVerticalIcon />
          </IconButton>
        </Menu>
      </SurfaceListMeta>
      <ConfirmAssignModal
        open={assignOpen}
        setOpen={setAssignOpen}
        member={member}
        inputValue={confirmInput}
        placeholder={workspaceName}
        setInputValue={setConfirmInput}
        isEquals={workspaceName === confirmInput}
        onConfirm={handleConfirmAssign}
      />
    </SurfaceListItem>
  );
}

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

export const MemberList = () => {
  const t = useI18n();
  const membersService = useService(WorkspaceMembersService);
  const account = useLiveData(useService(AuthService).session.account$);

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

  const handlePageChange = useCallback(
    (_: number, nextPage: number) => {
      membersService.members.setPageNum(nextPage);
      membersService.members.revalidate();
    },
    [membersService],
  );

  if (!account) return null;

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
        pageMembers.map((member) => (
          <MemberRow
            key={member.id}
            currentAccount={account}
            member={member}
            canManageUsers={canManageUsers}
            canManageAdmins={canManageAdmins}
            canTransferOwner={canTransferOwner}
          />
        ))
      )}
      {memberCount !== undefined &&
      memberCount > membersService.members.PAGE_SIZE ? (
        <Pagination
          totalCount={memberCount}
          countPerPage={membersService.members.PAGE_SIZE}
          pageNum={pageNum}
          onPageChange={handlePageChange}
        />
      ) : null}
    </Stack>
  );
};
