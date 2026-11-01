import { MenuItem as SidebarMenuItem } from "@myoxus/core/modules/app-sidebar/views";
import type { TemplateCategoryFilter } from "@myoxus/core/modules/template-doc";
import {
  TemplateListMenuAdd,
  TemplateListMenuContentScrollable,
} from "@myoxus/core/modules/template-doc/view/template-list-menu";
import { useI18n } from "@myoxus/i18n";
import { TemplateIcon } from "@myoxus/icons/react";
import track from "@myoxus/track";
import { Menu, MenuSeparator } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

const genericPickerFilter: TemplateCategoryFilter = { exclude: ["onboarding"] };

export const TemplateDocEntrance = () => {
  const t = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  const onMenuOpenChange = useCallback((open: boolean) => {
    if (open) track.$.sidebar.template.openTemplateListMenu();
    setMenuOpen(open);
  }, []);

  return (
    <Menu
      rootOptions={{ open: menuOpen, onOpenChange: onMenuOpenChange }}
      contentOptions={{
        side: "right",
        align: "end",
        panelWidth: "display",
      }}
      items={
        <TemplateListMenuContentScrollable
          asLink
          categoryFilter={genericPickerFilter}
          suffixItems={
            <>
              <MenuSeparator />
              <TemplateListMenuAdd />
            </>
          }
        />
      }
    >
      <SidebarMenuItem
        active={menuOpen}
        data-testid="sidebar-template-doc-entrance"
        data-myoxus-ui-role="sidebar-row"
        icon={<TemplateIcon />}
      >
        <span>{t["Template"]()}</span>
      </SidebarMenuItem>
    </Menu>
  );
};
