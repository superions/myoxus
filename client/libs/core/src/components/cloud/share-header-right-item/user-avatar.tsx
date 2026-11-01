import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useI18n } from "@myoxus/i18n";
import { SignOutIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  HeaderActionAvatarButton,
  Menu,
  MenuItem,
  MenuPanel,
  MenuSeparator,
  MyoxusText,
  SidebarIdentitySummary,
  SidebarIdentityText,
} from "@myoxus/ui-facade";
import { useMemo } from "react";

import { AuthService } from "../../../modules/server";
import { useNavigateHelper } from "../../hooks/use-navigate-helper";

const UserInfo = () => {
  const authService = useService(AuthService);
  const user = useLiveData(authService.session.account$);
  if (!user) {
    // TODO(@eyhn): loading UI
    return null;
  }
  return (
    <MenuPanel panelPadding="comfortable">
      <SidebarIdentitySummary>
        <Avatar
          size="md"
          name={user.label}
          url={user.avatar}
          colorfulFallback
        />

        <SidebarIdentityText>
          <MyoxusText
            component="span"
            typographySlot="nav"
            tone="primary"
            truncate
          >
            {user.label}
          </MyoxusText>
          <MyoxusText
            component="span"
            typographySlot="body-small"
            tone="secondary"
            truncate
          >
            {user.email}
          </MyoxusText>
        </SidebarIdentityText>
      </SidebarIdentitySummary>
    </MenuPanel>
  );
};

export const PublishPageUserAvatar = () => {
  const authService = useService(AuthService);
  const user = useLiveData(authService.session.account$);
  const t = useI18n();

  const navigateHelper = useNavigateHelper();
  const handleSignOut = useAsyncCallback(async () => {
    await authService.signOut();
    navigateHelper.jumpToSignIn();
  }, [authService, navigateHelper]);

  const menuItem = useMemo(() => {
    return (
      <>
        <UserInfo />
        <MenuSeparator />
        <MenuItem
          prefixIcon={<SignOutIcon />}
          data-testid="share-page-sign-out-option"
          onClick={handleSignOut}
        >
          {t["com.myoxus.workspace.cloud.account.logout"]()}
        </MenuItem>
      </>
    );
  }, [handleSignOut, t]);

  if (!user) {
    return null;
  }

  return (
    <Menu
      items={menuItem}
      contentOptions={{
        align: "end",
      }}
    >
      <HeaderActionAvatarButton
        aria-label={user.label}
        data-testid="share-page-user-avatar"
      >
        <Avatar size="sm" url={user.avatar} name={user.label} />
      </HeaderActionAvatarButton>
    </Menu>
  );
};
