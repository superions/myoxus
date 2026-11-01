import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { type AuthAccountInfo, AuthService } from "@myoxus/core/modules/server";
import {
  AccountIcon as UserAccountIcon,
  MoreVerticalIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  Menu,
  type MenuProps,
  MenuSeparator,
  MyoxusText,
  SidebarIdentityText,
  SidebarNavItem,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

import { Account } from "./account";
import { AccountMenu } from "./account-menu";

export default function UserInfo() {
  const session = useService(AuthService).session;
  const account = useLiveData(session.account$);
  return account ? (
    <AuthorizedUserInfo account={account} />
  ) : (
    <UnauthorizedUserInfo />
  );
}

const menuContentOptions: MenuProps["contentOptions"] = {
  panelWidth: "wide",
};
const AuthorizedUserInfo = ({ account }: { account: AuthAccountInfo }) => {
  return (
    <Menu items={<OperationMenu />} contentOptions={menuContentOptions}>
      <SidebarNavItem
        data-testid="sidebar-user-avatar"
        data-myoxus-ui-role="sidebar-user-row"
        leading={
          <Avatar colorfulFallback name={account.label} url={account.avatar} />
        }
        actions={<MoreVerticalIcon />}
      >
        <SidebarIdentityText>
          <MyoxusText
            component="span"
            truncate
            data-myoxus-ui-role="sidebar-user-name"
          >
            {account.label}
          </MyoxusText>
        </SidebarIdentityText>
      </SidebarNavItem>
    </Menu>
  );
};

const UnauthorizedUserInfo = () => {
  const globalDialogService = useService(GlobalDialogService);

  const openSignInModal = useCallback(() => {
    globalDialogService.open("sign-in", {});
  }, [globalDialogService]);

  return (
    <SidebarNavItem
      onClick={openSignInModal}
      data-testid="sidebar-user-avatar"
      data-myoxus-ui-role="sidebar-user-row"
      leading={
        <Avatar name="User">
          <UserAccountIcon aria-hidden />
        </Avatar>
      }
    >
      User
    </SidebarNavItem>
  );
};

const OperationMenu = () => {
  return (
    <>
      <Account />
      <MenuSeparator />
      <AccountMenu />
    </>
  );
};
