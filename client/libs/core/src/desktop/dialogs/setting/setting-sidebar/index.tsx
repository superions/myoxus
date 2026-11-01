import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import type {
  UserSettingTab,
  WorkspaceSettingTab,
} from "@myoxus/core/modules/dialogs/constant";
import { AuthService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  Avatar,
  Badge,
  BrandAssetImage,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSidebarContent,
  SettingsSidebarRoot,
  SettingsSidebarTitle,
  SidebarIdentityText,
  SidebarNavItem,
  SidebarNavSection,
  SidebarNavSectionDivider,
  SidebarNavSectionLabel,
} from "@myoxus/ui-facade";
import {
  type MouseEventHandler,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
} from "react";

import { useGeneralSettingList } from "../general-setting";
import { useWorkspaceSettingList } from "../workspace-setting";

export type UserInfoProps = {
  onAccountSettingClick: () => void;
  active?: boolean;
};

export const UserInfo = ({ onAccountSettingClick, active }: UserInfoProps) => {
  const account = useLiveData(useService(AuthService).session.account$);

  if (!account) {
    // TODO(@eyhn): loading ui
    return;
  }
  return (
    <SidebarNavItem
      active={active}
      data-testid="user-info-card"
      data-myoxus-ui-role="settings-account-card"
      icon={
        <Avatar
          size="sm"
          name={account.label}
          url={account.avatar}
          colorfulFallback
        />
      }
      onClick={onAccountSettingClick}
    >
      <SidebarIdentityText>
        <SettingsListItemTitle truncate title={account.label}>
          {account.label}
        </SettingsListItemTitle>
      </SidebarIdentityText>
    </SidebarNavItem>
  );
};

export const SignInButton = () => {
  const t = useI18n();
  const globalDialogService = useService(GlobalDialogService);

  return (
    <SidebarNavItem
      data-testid="settings-signin-button"
      data-myoxus-ui-role="settings-account-card"
      icon={
        <BrandAssetImage
          slot="productMark"
          width={"calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"}
          height={"calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"}
          alt="Myoxus Product Mark"
        />
      }
      onClick={useCallback(() => {
        globalDialogService.open("sign-in", {});
      }, [globalDialogService])}
    >
      <SidebarIdentityText>
        <SettingsListItemTitle truncate title={t["com.myoxus.settings.sign"]()}>
          {t["com.myoxus.settings.sign"]()}
        </SettingsListItemTitle>
        <SettingsListItemMeta
          truncate
          title={t["com.myoxus.setting.sign.message"]()}
        >
          {t["com.myoxus.setting.sign.message"]()}
        </SettingsListItemMeta>
      </SidebarIdentityText>
    </SidebarNavItem>
  );
};

type SettingSidebarItemProps = {
  isActive: boolean;
  icon: ReactNode;
  title: string;
  testId?: string;
  beta?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  "data-event-arg"?: string;
};

const SettingSidebarItem = ({
  isActive,
  icon,
  title,
  testId,
  beta,
  ...props
}: SettingSidebarItemProps) => {
  return (
    <SidebarNavItem
      {...props}
      active={isActive}
      actions={
        beta ? (
          <Badge data-myoxus-ui-role="settings-sidebar-beta-badge">Beta</Badge>
        ) : undefined
      }
      icon={icon}
      title={title}
      data-myoxus-ui-role="settings-sidebar-item"
      data-testid={testId}
    >
      {title}
    </SidebarNavItem>
  );
};

const SettingSidebarGroup = ({
  title,
  items,
}: {
  title?: string;
  items: Array<SettingSidebarItemProps & { key: string }>;
}) => {
  return (
    <SidebarNavSection>
      {title ? <SidebarNavSectionLabel>{title}</SidebarNavSectionLabel> : null}
      {items.map(({ key, ...props }) => (
        <SettingSidebarItem key={key} {...props} />
      ))}
    </SidebarNavSection>
  );
};

export const UserSettingsSidebar = ({
  activeTab,
  onTabChange,
}: {
  activeTab: UserSettingTab;
  onTabChange: (key: UserSettingTab) => void;
}) => {
  const t = useI18n();
  const loginStatus = useLiveData(useService(AuthService).session.status$);
  const generalList = useGeneralSettingList();
  const gotoTab = useCallback(
    (tab: UserSettingTab) => {
      track.$.settingsPanel.menu.openSettings({ to: tab });
      onTabChange(tab);
    },
    [onTabChange],
  );
  const onAccountSettingClick = useCallback(() => {
    track.$.settingsPanel.menu.openSettings({ to: "account" });
    onTabChange("account");
  }, [onTabChange]);

  const items = useMemo(
    () =>
      generalList.map((item) => ({
        ...item,
        isActive: item.key === activeTab,
        "data-event-arg": item.key,
        onClick: () => gotoTab(item.key),
      })),
    [activeTab, generalList, gotoTab],
  );

  return (
    <SettingsSidebarRoot data-testid="user-settings-sidebar">
      <SettingsSidebarTitle>
        {t["com.myoxus.settingSidebar.title"]()}
      </SettingsSidebarTitle>

      {loginStatus === "unauthenticated" ? <SignInButton /> : null}
      {loginStatus === "authenticated" ? (
        <Suspense>
          <UserInfo
            onAccountSettingClick={onAccountSettingClick}
            active={activeTab === "account"}
          />
        </Suspense>
      ) : null}

      <SidebarNavSectionDivider />

      <SettingsSidebarContent>
        <SettingSidebarGroup items={items} />
      </SettingsSidebarContent>
    </SettingsSidebarRoot>
  );
};

export const WorkspaceSettingsSidebar = ({
  activeTab,
  onTabChange,
}: {
  activeTab: WorkspaceSettingTab;
  onTabChange: (key: WorkspaceSettingTab) => void;
}) => {
  const t = useI18n();
  const workspaceSettingList = useWorkspaceSettingList();
  const gotoTab = useCallback(
    (tab: WorkspaceSettingTab) => {
      track.$.settingsPanel.menu.openSettings({ to: tab });
      onTabChange(tab);
    },
    [onTabChange],
  );
  const items = useMemo(
    () =>
      workspaceSettingList.map((item) => ({
        ...item,
        isActive: item.key === activeTab,
        "data-event-arg": item.key,
        onClick: () => gotoTab(item.key),
      })),
    [activeTab, gotoTab, workspaceSettingList],
  );

  return (
    <SettingsSidebarRoot data-testid="workspace-settings-sidebar">
      <SettingsSidebarTitle>
        {t["com.myoxus.settingSidebar.settings.workspace"]()}
      </SettingsSidebarTitle>
      <SettingsSidebarContent>
        <SettingSidebarGroup items={items} />
      </SettingsSidebarContent>
    </SettingsSidebarRoot>
  );
};
