// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
  if (!account) return null;

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

  const handleOpenSignIn = useCallback(() => {
    globalDialogService.open("sign-in", {});
  }, [globalDialogService]);

  return (
    <SidebarNavItem
      data-testid="settings-signin-button"
      data-myoxus-ui-role="settings-account-card"
      icon={
        <BrandAssetImage
          slot="productMark"
          width="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
          height="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
          alt="Myoxus Product Mark"
        />
      }
      onClick={handleOpenSignIn}
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

type SidebarNavRow = {
  key: string;
  isActive: boolean;
  icon: ReactNode;
  title: string;
  testId?: string;
  beta?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  "data-event-arg"?: string;
};

function SettingSidebarSection({
  title,
  items,
}: {
  title?: string;
  items: SidebarNavRow[];
}) {
  return (
    <SidebarNavSection>
      {title ? <SidebarNavSectionLabel>{title}</SidebarNavSectionLabel> : null}
      {items.map(
        ({ key, isActive, icon, title: itemTitle, testId, beta, ...rest }) => (
          <SidebarNavItem
            key={key}
            {...rest}
            active={isActive}
            actions={
              beta ? (
                <Badge data-myoxus-ui-role="settings-sidebar-beta-badge">
                  Beta
                </Badge>
              ) : undefined
            }
            icon={icon}
            title={itemTitle}
            data-myoxus-ui-role="settings-sidebar-item"
            data-testid={testId}
          >
            {itemTitle}
          </SidebarNavItem>
        ),
      )}
    </SidebarNavSection>
  );
}

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

  const selectTab = useCallback(
    (tab: UserSettingTab) => {
      track.$.settingsPanel.menu.openSettings({ to: tab });
      onTabChange(tab);
    },
    [onTabChange],
  );

  const handleAccountClick = useCallback(
    () => selectTab("account"),
    [selectTab],
  );

  const items = useMemo<SidebarNavRow[]>(
    () =>
      generalList.map((item) => ({
        ...item,
        isActive: item.key === activeTab,
        "data-event-arg": item.key,
        onClick: () => selectTab(item.key),
      })),
    [activeTab, generalList, selectTab],
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
            onAccountSettingClick={handleAccountClick}
            active={activeTab === "account"}
          />
        </Suspense>
      ) : null}
      <SidebarNavSectionDivider />
      <SettingsSidebarContent>
        <SettingSidebarSection items={items} />
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

  const selectTab = useCallback(
    (tab: WorkspaceSettingTab) => {
      track.$.settingsPanel.menu.openSettings({ to: tab });
      onTabChange(tab);
    },
    [onTabChange],
  );

  const items = useMemo<SidebarNavRow[]>(
    () =>
      workspaceSettingList.map((item) => ({
        ...item,
        isActive: item.key === activeTab,
        "data-event-arg": item.key,
        onClick: () => selectTab(item.key),
      })),
    [activeTab, selectTab, workspaceSettingList],
  );

  return (
    <SettingsSidebarRoot data-testid="workspace-settings-sidebar">
      <SettingsSidebarTitle>
        {t["com.myoxus.settingSidebar.settings.workspace"]()}
      </SettingsSidebarTitle>
      <SettingsSidebarContent>
        <SettingSidebarSection items={items} />
      </SettingsSidebarContent>
    </SettingsSidebarRoot>
  );
};
