import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { DocGrantedUsersService } from "@myoxus/core/modules/permissions";
import { ShareInfoService } from "@myoxus/core/modules/share-doc";
import { UserFriendlyError } from "@myoxus/error";
import { DocRole } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { InformationIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  Menu,
  MenuDetailRow,
  MenuInlineText,
  MenuItem,
  MenuTrigger,
  notify,
  Tooltip,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

const getRoleName = (t: ReturnType<typeof useI18n>, role?: DocRole) => {
  switch (role) {
    case DocRole.Manager:
      return t["com.myoxus.share-menu.option.permission.can-manage"]();
    case DocRole.Editor:
      return t["com.myoxus.share-menu.option.permission.can-edit"]();
    case DocRole.Reader:
      return t["com.myoxus.share-menu.option.permission.can-read"]();
    case DocRole.None:
      return t["com.myoxus.share-menu.option.permission.no-access"]();
    default:
      return "";
  }
};

export const MembersPermission = ({ disabled }: { disabled?: boolean }) => {
  const t = useI18n();
  const shareInfoService = useService(ShareInfoService);
  const docGrantedUsersService = useService(DocGrantedUsersService);
  const docDefaultRole = useLiveData(
    shareInfoService.shareInfo.info$,
  )?.defaultRole;
  const currentRoleName = useMemo(
    () => getRoleName(t, docDefaultRole),
    [docDefaultRole, t],
  );
  const showTips =
    docDefaultRole === DocRole.Reader ||
    docDefaultRole === DocRole.Editor ||
    docDefaultRole === DocRole.None;
  const changePermission = useAsyncCallback(
    async (docRole: DocRole) => {
      try {
        track.$.sharePanel.$.modifyDocDefaultRole({
          role: docRole,
        });
        await docGrantedUsersService.updateDocDefaultRole(docRole);
        shareInfoService.shareInfo.revalidate();
      } catch (error) {
        const err = UserFriendlyError.fromAny(error);
        notify.error({
          title: err.name,
          message: err.message,
        });
      }
    },
    [docGrantedUsersService, shareInfoService.shareInfo],
  );

  const selectManage = useCallback(() => {
    changePermission(DocRole.Manager);
  }, [changePermission]);

  const selectEdit = useCallback(() => {
    changePermission(DocRole.Editor);
  }, [changePermission]);

  const selectRead = useCallback(() => {
    changePermission(DocRole.Reader);
  }, [changePermission]);

  const selectNone = useCallback(() => {
    changePermission(DocRole.None);
  }, [changePermission]);

  return (
    <MenuDetailRow
      right={
        disabled ? (
          <MenuInlineText
            prefixIcon={showTips ? <Tips /> : undefined}
            tone="disabled"
            truncate={false}
          >
            {currentRoleName}
          </MenuInlineText>
        ) : (
          <Menu
            contentOptions={{
              align: "end",
            }}
            items={
              <>
                <MenuItem
                  onSelect={selectManage}
                  selected={docDefaultRole === DocRole.Manager}
                >
                  {t["com.myoxus.share-menu.option.permission.can-manage"]()}
                </MenuItem>
                <MenuItem
                  onSelect={selectEdit}
                  selected={docDefaultRole === DocRole.Editor}
                >
                  {t["com.myoxus.share-menu.option.permission.can-edit"]()}
                </MenuItem>
                <MenuItem
                  onSelect={selectRead}
                  selected={docDefaultRole === DocRole.Reader}
                >
                  {t["com.myoxus.share-menu.option.permission.can-read"]()}
                </MenuItem>
                <MenuItem
                  onSelect={selectNone}
                  selected={docDefaultRole === DocRole.None}
                >
                  {t["com.myoxus.share-menu.option.permission.no-access"]()}
                </MenuItem>
              </>
            }
          >
            <MenuTrigger variant="plain">
              <MenuInlineText
                prefixIcon={showTips ? <Tips /> : undefined}
                truncate={false}
              >
                {currentRoleName}
              </MenuInlineText>
            </MenuTrigger>
          </Menu>
        )
      }
    >
      <MenuInlineText tone="primary" truncate={false}>
        {t["com.myoxus.share-menu.option.permission.label"]()}
      </MenuInlineText>
    </MenuDetailRow>
  );
};

export const Tips = () => {
  const t = useI18n();

  return (
    <Tooltip content={t["com.myoxus.share-menu.option.permission.tips"]()}>
      <InformationIcon aria-hidden="true" />
    </Tooltip>
  );
};
