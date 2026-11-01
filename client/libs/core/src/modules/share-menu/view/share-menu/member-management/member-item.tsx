import { useGuard } from "@myoxus/core/components/guard";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { DocService } from "@myoxus/core/modules/doc";
import {
  DocGrantedUsersService,
  type GrantedUser,
  WorkspacePermissionService,
} from "@myoxus/core/modules/permissions";
import { UserFriendlyError } from "@myoxus/error";
import { DocRole } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import {
  Avatar,
  Menu,
  MenuDetailRow,
  MenuInlineText,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  notify,
  SurfaceListItemMain,
  SurfaceListText,
  Tooltip,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

export const MemberItem = ({
  grantedUser,
  canManageUsers,
}: {
  grantedUser: GrantedUser;
  canManageUsers: boolean;
}) => {
  const user = grantedUser.user;
  const disableManage = grantedUser.role === DocRole.Owner || !canManageUsers;

  const role = useMemo(() => {
    switch (grantedUser.role) {
      case DocRole.Owner:
        return "Owner";
      case DocRole.Manager:
        return "Can manage";
      case DocRole.Editor:
        return "Can edit";
      case DocRole.Reader:
        return "Can read";
      default:
        return "";
    }
  }, [grantedUser.role]);

  return (
    <MenuDetailRow
      justify="start"
      right={
        disableManage ? (
          <MenuInlineText tone="disabled">{role}</MenuInlineText>
        ) : (
          <Menu
            items={<Options userId={user.id} memberRole={grantedUser.role} />}
            contentOptions={{
              align: "start",
            }}
          >
            <MenuTrigger variant="plain">{role}</MenuTrigger>
          </Menu>
        )
      }
      data-myoxus-ui-role="share-menu-managed-member-row"
    >
      <Avatar url={user.avatarUrl || ""} name={user.name} />
      <SurfaceListItemMain compact>
        <Tooltip content={user.name} rootOptions={{ delayDuration: 1000 }}>
          <SurfaceListText kind="title">{user.name}</SurfaceListText>
        </Tooltip>
        <Tooltip content={user.email} rootOptions={{ delayDuration: 1000 }}>
          <SurfaceListText kind="description">{user.email}</SurfaceListText>
        </Tooltip>
      </SurfaceListItemMain>
    </MenuDetailRow>
  );
};

const Options = ({
  memberRole,
  userId,
}: {
  userId: string;
  memberRole: DocRole;
}) => {
  const t = useI18n();
  const docGrantedUsersService = useService(DocGrantedUsersService);
  const docService = useService(DocService);
  const workspacePermissionService = useService(WorkspacePermissionService);
  const isWorkspaceOwner = useLiveData(
    workspacePermissionService.permission.isOwner$,
  );

  const { openConfirmModal } = useConfirmModal();

  const canTransferOwner =
    useGuard("Doc_TransferOwner", docService.doc.id) && !!isWorkspaceOwner;
  const canManageUsers = useGuard("Doc_Users_Manage", docService.doc.id);

  const updateUserRole = useCallback(
    async (userId: string, role: DocRole) => {
      track.$.sharePanel.$.modifyUserDocRole({ control: "Update", role });
      try {
        const res = await docGrantedUsersService.updateUserRole(userId, role);
        if (res) {
          notify.success({
            title:
              t["com.myoxus.share-menu.member-management.update-success"](),
          });
        } else {
          notify.error({
            title: t["com.myoxus.share-menu.member-management.update-fail"](),
          });
        }
      } catch (error) {
        const err = UserFriendlyError.fromAny(error);
        notify.error({
          title: t[`error.${err.name}`](err.data),
        });
      }
    },
    [docGrantedUsersService, t],
  );

  const changeToManager = useAsyncCallback(async () => {
    await updateUserRole(userId, DocRole.Manager);
  }, [updateUserRole, userId]);

  const changeToEditor = useAsyncCallback(async () => {
    await updateUserRole(userId, DocRole.Editor);
  }, [updateUserRole, userId]);

  const changeToReader = useAsyncCallback(async () => {
    await updateUserRole(userId, DocRole.Reader);
  }, [updateUserRole, userId]);

  const changeToOwner = useAsyncCallback(async () => {
    await updateUserRole(userId, DocRole.Owner);
  }, [updateUserRole, userId]);

  const openTransferOwnerModal = useCallback(() => {
    openConfirmModal({
      title:
        t[
          "com.myoxus.share-menu.member-management.set-as-owner.confirm.title"
        ](),
      description:
        t[
          "com.myoxus.share-menu.member-management.set-as-owner.confirm.description"
        ](),
      onConfirm: changeToOwner,
      confirmText: t["Confirm"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      cancelText: t["Cancel"](),
    });
  }, [changeToOwner, openConfirmModal, t]);

  const removeMember = useAsyncCallback(async () => {
    track.$.sharePanel.$.modifyUserDocRole({ control: "Remove" });
    try {
      await docGrantedUsersService.revokeUsersRole(userId);
      docGrantedUsersService.loadMore();
    } catch (error) {
      const err = UserFriendlyError.fromAny(error);
      notify.error({
        title: t[`error.${err.name}`](err.data),
      });
    }
  }, [docGrantedUsersService, userId, t]);

  const operationButtonInfo = useMemo(() => {
    return [
      {
        label: t["com.myoxus.share-menu.option.permission.can-manage"](),
        onClick: changeToManager,
        role: DocRole.Manager,
      },
      {
        label: t["com.myoxus.share-menu.option.permission.can-edit"](),
        onClick: changeToEditor,
        role: DocRole.Editor,
      },
      {
        label: t["com.myoxus.share-menu.option.permission.can-read"](),
        onClick: changeToReader,
        role: DocRole.Reader,
      },
    ];
  }, [changeToEditor, changeToManager, changeToReader, t]);

  return (
    <>
      {operationButtonInfo.map((item) => (
        <MenuItem
          key={item.label}
          onSelect={item.onClick}
          selected={memberRole === item.role}
          disabled={!canManageUsers}
        >
          {item.label}
        </MenuItem>
      ))}
      <MenuItem onSelect={openTransferOwnerModal} disabled={!canTransferOwner}>
        {t["com.myoxus.share-menu.member-management.set-as-owner"]()}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        onSelect={removeMember}
        type="danger"
        disabled={!canManageUsers}
      >
        {t["com.myoxus.share-menu.member-management.remove"]()}
      </MenuItem>
    </>
  );
};
