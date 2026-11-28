// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type Member,
  WorkspaceMembersService,
} from "@myoxus/core/modules/permissions";
import { Permission, WorkspaceMemberStatus } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useCallback, useMemo } from "react";

import { MenuItem, notify, useConfirmModal } from "../../primitives";

export const MemberOptions = ({
  member,
  canManageUsers,
  canManageAdmins,
  canTransferOwner,
  openAssignModal,
}: {
  member: Member;
  canManageUsers: boolean;
  canManageAdmins: boolean;
  canTransferOwner: boolean;
  openAssignModal: () => void;
}) => {
  const t = useI18n();
  const membersService = useService(WorkspaceMembersService);
  const { openConfirmModal } = useConfirmModal();
  const memberName = member.name || member.email || member.id;

  const confirmRevoke = useCallback(
    (title: string, message: string) => {
      openConfirmModal({
        title: t["com.myoxus.member.remove.confirm.title"](),
        description: t["com.myoxus.member.remove.confirm.description"](),
        confirmText: t["com.myoxus.member.remove.confirm.confirm-button"](),
        cancelText: t["com.myoxus.member.remove.confirm.cancel"](),
        confirmButtonOptions: { variant: "error" },
        onConfirm: () =>
          membersService
            .revokeMember(member.id)
            .then((ok) => {
              if (!ok) return;
              notify.success({ title, message });
              membersService.members.revalidate();
            })
            .catch((error) => {
              notify.error({
                title: t["com.myoxus.common.operation-failed"](),
                message: error instanceof Error ? error.message : String(error),
              });
            }),
      });
    },
    [member.id, membersService, openConfirmModal, t],
  );

  const handleApprove = useCallback(() => {
    membersService
      .approveMember(member.id)
      .then((ok) => {
        if (!ok) return;
        notify.success({
          title: t["com.myoxus.member.approve.notify.title"](),
          message: t["com.myoxus.member.approve.notify.message"]({
            name: memberName,
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
  }, [member.id, memberName, membersService, t]);

  const handleChangeRole = useCallback(
    (permission: Permission) => {
      membersService
        .adjustMemberPermission(member.id, permission)
        .then((ok) => {
          if (!ok) return;
          notify.success({
            title: t["com.myoxus.member.change.notify.title"](),
          });
          membersService.members.revalidate();
        })
        .catch((error) => {
          notify.error({
            title: t["com.myoxus.common.operation-failed"](),
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [member.id, membersService, t],
  );

  const canManageTarget =
    member.directRole === Permission.Admin ? canManageAdmins : canManageUsers;
  const isAccepted = member.status === WorkspaceMemberStatus.Accepted;

  const actions = useMemo(() => {
    const standardRoles: Array<{ permission: Permission; label: string }> = [
      { permission: Permission.Reader, label: t["Reader"]() },
      { permission: Permission.Commenter, label: t["Commenter"]() },
      { permission: Permission.Collaborator, label: t["Collaborator"]() },
      { permission: Permission.Manager, label: t["Manager"]() },
    ];

    return [
      {
        label: t["com.myoxus.member.approve"](),
        onClick: handleApprove,
        visible:
          canManageTarget &&
          member.status === WorkspaceMemberStatus.UnderReview,
      },
      {
        label: t["com.myoxus.member.decline"](),
        onClick: () =>
          confirmRevoke(
            t["com.myoxus.member.decline.notify.title"](),
            t["com.myoxus.member.decline.notify.message"]({ name: memberName }),
          ),
        visible:
          canManageTarget &&
          member.status === WorkspaceMemberStatus.UnderReview,
      },
      {
        label: t["com.myoxus.member.revoke"](),
        onClick: () =>
          confirmRevoke(
            t["com.myoxus.member.revoke.notify.title"](),
            t["com.myoxus.member.revoke.notify.message"]({ name: memberName }),
          ),
        visible:
          canManageTarget &&
          (member.status === WorkspaceMemberStatus.NeedMoreSeat ||
            member.status === WorkspaceMemberStatus.Pending),
      },
      {
        label: t["com.myoxus.member.remove"](),
        onClick: () =>
          confirmRevoke(
            t["com.myoxus.member.remove.notify.title"](),
            t["com.myoxus.member.remove.notify.message"]({ name: memberName }),
          ),
        visible: canManageTarget && isAccepted,
      },
      ...standardRoles.map(({ permission, label }) => ({
        label,
        onClick: () => handleChangeRole(permission),
        visible:
          isAccepted &&
          canManageTarget &&
          member.directRole !== permission &&
          member.directRole !== Permission.Owner,
      })),
      {
        label: t["Admin"](),
        onClick: () => handleChangeRole(Permission.Admin),
        visible:
          canManageAdmins &&
          isAccepted &&
          member.directRole !== Permission.Owner &&
          member.directRole !== Permission.Admin,
      },
      {
        label: t["com.myoxus.member.assign"](),
        onClick: openAssignModal,
        visible: canTransferOwner && isAccepted,
      },
    ];
  }, [
    canManageAdmins,
    canManageTarget,
    canTransferOwner,
    confirmRevoke,
    handleApprove,
    handleChangeRole,
    isAccepted,
    member.directRole,
    member.status,
    memberName,
    openAssignModal,
    t,
  ]);

  return (
    <>
      {actions
        .filter((item) => item.visible)
        .map((item) => (
          <MenuItem key={item.label} onSelect={item.onClick}>
            {item.label}
          </MenuItem>
        ))}
    </>
  );
};
