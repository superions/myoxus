/**
 * User avatar and dropdown in the sidebar footer.
 *
 * Shows the current user's avatar, display name, and an Admin badge.
 * The dropdown provides a Logout action that calls the sign-out endpoint
 * and revalidates the current-user query.
 * Supports collapsed (icon-only) and expanded layouts.
 */
import { useI18n } from "@myoxus/i18n";
import { MoonIcon, MoreVerticalIcon, SunIcon } from "@myoxus/icons/react";
import {
  Avatar,
  Badge,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  notify,
  SidebarIdentitySummary,
  SidebarIdentityText,
  SidebarUserMain,
  SidebarUserName,
  SidebarUserRow,
} from "@myoxus/ui-facade";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { useCallback } from "react";

import { signOutAdminSession } from "../../api/auth-session-api";
import { buildAdminSignInUrl } from "../auth/redirect";
import { useCurrentUser, useRevalidateCurrentUser } from "../common";

interface UserDropdownProps {
  isCollapsed: boolean;
}

function AdminBadge() {
  const i18n = useI18n();
  return (
    <Badge tone="info">
      {i18n.t("admin.organization.members.badge.admin")}
    </Badge>
  );
}

const UserInfo = ({
  name,
  email,
  avatarUrl,
}: {
  email: string;
  avatarUrl?: string | null;
  name?: string | null;
}) => {
  return (
    <SidebarIdentitySummary>
      <Avatar name={name ?? email} url={avatarUrl} size={32} colorfulFallback />
      <SidebarIdentityText>
        <SidebarUserName title={name ?? email}>
          {name ?? email.split("@")[0]}
        </SidebarUserName>
        <AdminBadge />
      </SidebarIdentityText>
    </SidebarIdentitySummary>
  );
};

const UserName = ({
  name,
  email,
}: {
  name?: string | null;
  email?: string;
}) => {
  if (name) {
    return <SidebarUserName title={name}>{name}</SidebarUserName>;
  }

  const fallback = email?.split("@")[0] ?? "";
  return <SidebarUserName title={fallback}>{fallback}</SidebarUserName>;
};

/**
 * Renders the sidebar user widget.
 * @param isCollapsed - When `true`, only the avatar icon is shown; user details appear in the dropdown.
 */
export function UserDropdown({ isCollapsed }: UserDropdownProps) {
  const i18n = useI18n();
  const currentUser = useCurrentUser();
  const relative = useRevalidateCurrentUser();
  const { theme, setTheme } = useMyoxusTheme();

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const handleLogout = useCallback(() => {
    signOutAdminSession("nav-user-dropdown")
      .then(() => {
        notify.success({ title: i18n.t("admin.auth.logged-out-successfully") });
        window.location.replace(
          buildAdminSignInUrl(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
          ),
        );
        return relative();
      })
      .catch((err) => {
        notify.error({
          title: i18n.t("admin.auth.failed-to-logout", {
            message: err.message,
          }),
        });
      });
  }, [i18n, relative]);

  const menuItems = (
    <>
      {currentUser ? (
        <UserInfo
          email={currentUser.email}
          name={currentUser.name}
          avatarUrl={currentUser.avatarUrl ?? undefined}
        />
      ) : null}
      <MenuSeparator />
      <MenuItem
        onSelect={toggleTheme}
        prefixIcon={theme === "dark" ? <SunIcon /> : <MoonIcon />}
      >
        {theme === "dark"
          ? i18n.t("admin.nav.light-mode")
          : i18n.t("admin.nav.dark-mode")}
      </MenuItem>
      <MenuItem onSelect={handleLogout}>{i18n.t("admin.auth.logout")}</MenuItem>
    </>
  );

  if (isCollapsed) {
    return (
      <Menu items={menuItems} contentOptions={{ align: "end", side: "right" }}>
        <IconButton
          variant="plain"
          aria-label={i18n.t("admin.nav.user-menu")}
          size="default"
        >
          <Avatar
            name={currentUser?.name ?? currentUser?.email}
            url={currentUser?.avatarUrl}
            size={24}
            colorfulFallback
          />
        </IconButton>
      </Menu>
    );
  }

  return (
    <SidebarUserRow>
      <SidebarUserMain>
        <Avatar
          name={currentUser?.name ?? currentUser?.email}
          url={currentUser?.avatarUrl}
          size={24}
          colorfulFallback
        />
        <UserName name={currentUser?.name} email={currentUser?.email} />
        <AdminBadge />
      </SidebarUserMain>
      <Menu items={menuItems} contentOptions={{ align: "end", side: "right" }}>
        <IconButton
          variant="plain"
          aria-label={i18n.t("admin.nav.user-menu")}
          size="default"
        >
          <MoreVerticalIcon />
        </IconButton>
      </Menu>
    </SidebarUserRow>
  );
}
