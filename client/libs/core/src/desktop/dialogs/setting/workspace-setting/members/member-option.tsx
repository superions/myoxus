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

  const openRemoveConfirmModal = useCallback(
    (successNotify: { title: string; message: string }) => {
      openConfirmModal({
        title: t["com.myoxus.member.remove.confirm.title"](),
        description: t["com.myoxus.member.remove.confirm.description"](),
        confirmText: t["com.myoxus.member.remove.confirm.confirm-button"](),
        cancelText: t["com.myoxus.member.remove.confirm.cancel"](),
        confirmButtonOptions: {
          variant: "error",
        },
        onConfirm: () =>
          membersService
            .revokeMember(member.id)
            .then((result) => {
              if (result) {
                notify.success({
                  title: successNotify.title,
                  message: successNotify.message,
                });
                membersService.members.revalidate();
              }
            })
            .catch((error) => {
              notify.error({
                title: t["com.myoxus.common.operation-failed"](),
                message: error instanceof Error ? error.message : String(error),
              });
            }),
      });
    },
    [member, membersService, openConfirmModal, t],
  );

  const handleAssignOwner = useCallback(() => {
    openAssignModal();
  }, [openAssignModal]);

  const handleRevoke = useCallback(() => {
    openRemoveConfirmModal({
      title: t["com.myoxus.member.revoke.notify.title"](),
      message: t["com.myoxus.member.revoke.notify.message"]({
        name: member.name || member.email || member.id,
      }),
    });
  }, [openRemoveConfirmModal, member, t]);

  const handleApprove = useCallback(() => {
    membersService
      .approveMember(member.id)
      .then((result) => {
        if (result) {
          notify.success({
            title: t["com.myoxus.member.approve.notify.title"](),
            message: t["com.myoxus.member.approve.notify.message"]({
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
  }, [member, membersService, t]);

  const handleDecline = useCallback(() => {
    openRemoveConfirmModal({
      title: t["com.myoxus.member.decline.notify.title"](),
      message: t["com.myoxus.member.decline.notify.message"]({
        name: member.name || member.email || member.id,
      }),
    });
  }, [member, openRemoveConfirmModal, t]);

  const handleRemove = useCallback(() => {
    openRemoveConfirmModal({
      title: t["com.myoxus.member.remove.notify.title"](),
      message: t["com.myoxus.member.remove.notify.message"]({
        name: member.name || member.email || member.id,
      }),
    });
  }, [member, openRemoveConfirmModal, t]);

  const handleChangePermission = useCallback(
    (permission: Permission) => {
      membersService
        .adjustMemberPermission(member.id, permission)
        .then((result) => {
          if (result) {
            notify.success({
              title: t["com.myoxus.member.change.notify.title"](),
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
    },
    [member.id, membersService, t],
  );

  const roleOptions = useMemo(
    () => [
      { permission: Permission.Reader, label: t["Reader"]() },
      { permission: Permission.Commenter, label: t["Commenter"]() },
      { permission: Permission.Collaborator, label: t["Collaborator"]() },
      { permission: Permission.Manager, label: t["Manager"]() },
    ],
    [t],
  );

  const canManageTarget =
    member.permission === Permission.Admin ? canManageAdmins : canManageUsers;
  const isAccepted = member.status === WorkspaceMemberStatus.Accepted;

  const operationButtonInfo = useMemo(() => {
    const roleItems = roleOptions.map(({ permission, label }) => ({
      label,
      onClick: () => handleChangePermission(permission),
      show:
        isAccepted &&
        canManageTarget &&
        member.permission !== permission &&
        member.permission !== Permission.Owner,
    }));

    return [
      {
        label: t["com.myoxus.member.approve"](),
        onClick: handleApprove,
        show:
          canManageTarget &&
          member.status === WorkspaceMemberStatus.UnderReview,
      },
      {
        label: t["com.myoxus.member.decline"](),
        onClick: handleDecline,
        show:
          canManageTarget &&
          member.status === WorkspaceMemberStatus.UnderReview,
      },
      {
        label: t["com.myoxus.member.revoke"](),
        onClick: handleRevoke,
        show:
          canManageTarget &&
          [
            WorkspaceMemberStatus.NeedMoreSeat,
            WorkspaceMemberStatus.Pending,
          ].includes(member.status),
      },
      {
        label: t["com.myoxus.member.remove"](),
        onClick: handleRemove,
        show: canManageTarget && isAccepted,
      },
      ...roleItems,
      {
        label: t["Admin"](),
        onClick: () => handleChangePermission(Permission.Admin),
        show:
          canManageAdmins &&
          isAccepted &&
          member.permission !== Permission.Owner &&
          member.permission !== Permission.Admin,
      },
      {
        label: t["com.myoxus.member.assign"](),
        onClick: handleAssignOwner,
        show: canTransferOwner && isAccepted,
      },
    ];
  }, [
    canManageAdmins,
    canManageTarget,
    canTransferOwner,
    handleApprove,
    handleAssignOwner,
    handleChangePermission,
    handleDecline,
    handleRemove,
    handleRevoke,
    isAccepted,
    member.permission,
    member.status,
    roleOptions,
    t,
  ]);

  return (
    <>
      {operationButtonInfo.map((item) =>
        item.show ? (
          <MenuItem key={item.label} onSelect={item.onClick}>
            {item.label}
          </MenuItem>
        ) : null,
      )}
    </>
  );
};
