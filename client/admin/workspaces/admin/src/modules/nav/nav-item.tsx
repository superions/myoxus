/**
 * Single navigation link used inside the admin sidebar.
 * Supports a collapsed icon-only mode and highlights the active route.
 */
import { NavigationLink } from "@myoxus/ui-facade";
import { NavLink as RouterNavLink, useLocation } from "react-router";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  to: string;
  isCollapsed?: boolean;
}

/**
 * Renders a single sidebar navigation link.
 * When `isCollapsed` is `true`, only the icon is shown (label hidden).
 */
export const NavItem = ({ icon, label, to, isCollapsed }: NavItemProps) => {
  const { pathname } = useLocation();
  const isActive = pathname === to || pathname.startsWith(`${to}/`);

  return (
    <NavigationLink
      component={RouterNavLink}
      to={to}
      active={isActive}
      label={label}
      leftSection={icon}
      collapsed={isCollapsed}
      variant="sidebar"
    />
  );
};
