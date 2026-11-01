/**
 * Main navigation component rendered inside the left sidebar panel.
 *
 * Conditionally shows navigation items based on server capabilities
 * and the deployment mode.
 * At the bottom, renders the current user dropdown and server version display.
 */
import { useI18n } from "@myoxus/i18n";
import {
  ActivityIcon,
  AiIcon,
  BarChart3Icon,
  BookTemplateIcon,
  CloudWorkspaceIcon,
  DatabaseIcon,
  DocsIcon,
  ExportToPdfIcon,
  GitBranchIcon,
  ListChecksIcon,
  OrganizationIcon,
  PaletteIcon,
  ScrollTextIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  TypeIcon,
} from "@myoxus/icons/react";
import { ROUTES } from "@myoxus/routes";
import {
  SidebarNavFooter,
  SidebarNavList,
  SidebarNavRoot,
  SidebarNavSection,
  SidebarNavSectionDivider,
  SidebarNavSectionLabel,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

import { NavItem } from "./nav-item";
import { ServerVersion } from "./server-version";
import { UserDropdown } from "./user-dropdown";

interface NavProps {
  isCollapsed?: boolean;
}

type NavItemConfig = {
  to: string;
  icon: ReactNode;
  labelKey: string;
};

const NAV_ICON_SIZE =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";

const NAV_SECTIONS: { labelKey: string; items: NavItemConfig[] }[] = [
  {
    labelKey: "admin.nav.group.overview",
    items: [
      {
        to: ROUTES.admin.dashboard,
        icon: <BarChart3Icon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.dashboard",
      },
      {
        to: ROUTES.admin.system,
        icon: <ServerCogIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.system",
      },
    ],
  },
  {
    labelKey: "admin.nav.group.governance",
    items: [
      {
        to: ROUTES.admin.security,
        icon: <ShieldCheckIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.security",
      },
      {
        to: ROUTES.admin.organization.index,
        icon: <OrganizationIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.organization",
      },
      {
        to: ROUTES.admin.auditLog,
        icon: <ScrollTextIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.audit-log",
      },
    ],
  },
  {
    labelKey: "admin.nav.group.content",
    items: [
      {
        to: ROUTES.admin.workspaces,
        icon: <CloudWorkspaceIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.workspaces",
      },
      {
        to: ROUTES.admin.storage,
        icon: <DatabaseIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.storage",
      },
      {
        to: ROUTES.admin.templates,
        icon: <BookTemplateIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.templates",
      },
      {
        to: ROUTES.admin.documents,
        icon: <DocsIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.documents",
      },
      {
        to: ROUTES.admin.pdfExport,
        icon: <ExportToPdfIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.pdf-export",
      },
    ],
  },
  {
    labelKey: "admin.nav.group.operations",
    items: [
      {
        to: ROUTES.admin.queue,
        icon: <ListChecksIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.queue",
      },
      {
        to: ROUTES.admin.gitSync,
        icon: <GitBranchIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.git-sync",
      },
      {
        to: ROUTES.admin.performance,
        icon: <ActivityIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.performance",
      },
      {
        to: ROUTES.admin.ai,
        icon: <AiIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.ai",
      },
    ],
  },
  {
    labelKey: "admin.nav.group.appearance",
    items: [
      {
        to: ROUTES.admin.design,
        icon: <PaletteIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.design",
      },
      {
        to: ROUTES.admin.typography,
        icon: <TypeIcon size={NAV_ICON_SIZE} />,
        labelKey: "admin.nav.typography",
      },
    ],
  },
];

/**
 * Sidebar navigation list.
 * @param isCollapsed - When `true`, nav items render icon-only (no labels).
 */
export function Nav({ isCollapsed = false }: NavProps) {
  const i18n = useI18n();

  return (
    <SidebarNavRoot collapsed={isCollapsed}>
      <SidebarNavList collapsed={isCollapsed}>
        {NAV_SECTIONS.map((section, sectionIndex) => (
          <SidebarNavSection key={section.labelKey} collapsed={isCollapsed}>
            {sectionIndex > 0 ? (
              <SidebarNavSectionDivider collapsed={isCollapsed} />
            ) : null}
            {isCollapsed ? null : (
              <SidebarNavSectionLabel>
                {i18n.t(section.labelKey)}
              </SidebarNavSectionLabel>
            )}
            {section.items.map((item) => (
              <NavItem
                key={item.to}
                to={item.to}
                icon={item.icon}
                label={i18n.t(item.labelKey)}
                isCollapsed={isCollapsed}
              />
            ))}
          </SidebarNavSection>
        ))}
      </SidebarNavList>
      <SidebarNavFooter collapsed={isCollapsed}>
        <UserDropdown isCollapsed={isCollapsed} />
        {isCollapsed ? null : <ServerVersion />}
      </SidebarNavFooter>
    </SidebarNavRoot>
  );
}
