import type { DocCustomPropertyInfo } from "@myoxus/core/modules/db";
import { useI18n } from "@myoxus/i18n";
import {
  IconButton,
  Menu,
  MenuOptionButton,
  MenuOptionGroup,
  MenuScrollableSection,
  MenuSectionLabel,
  SurfaceListItemIcon,
} from "@myoxus/ui-facade";

import {
  type WorkspacePropertyIconName,
  WorkspacePropertyIconNames,
} from "./constant";
import {
  iconNameToComponent,
  WorkspacePropertyIcon,
} from "./workspace-property-icon";

const IconsSelectorPanel = ({
  selectedIcon,
  onSelectedChange,
}: {
  selectedIcon?: string | null;
  onSelectedChange: (icon: WorkspacePropertyIconName) => void;
}) => {
  const t = useI18n();
  return (
    <>
      <MenuSectionLabel>
        {t["com.myoxus.page-properties.icons"]()}
      </MenuSectionLabel>
      <MenuScrollableSection maxHeight="default">
        <MenuOptionGroup>
          {WorkspacePropertyIconNames.map((iconName) => {
            const Icon = iconNameToComponent(iconName);
            return (
              <MenuOptionButton
                key={iconName}
                aria-label={iconName}
                active={iconName === selectedIcon}
                data-name={iconName}
                onClick={() => onSelectedChange(iconName)}
              >
                <SurfaceListItemIcon size="sm" tone="secondary">
                  <Icon />
                </SurfaceListItemIcon>
              </MenuOptionButton>
            );
          })}
        </MenuOptionGroup>
      </MenuScrollableSection>
    </>
  );
};

export const WorkspacePropertyIconSelector = ({
  propertyInfo,
  readonly,
  onSelectedChange,
}: {
  propertyInfo: DocCustomPropertyInfo;
  readonly?: boolean;
  onSelectedChange: (icon: WorkspacePropertyIconName) => void;
}) => {
  const trigger = (
    <IconButton
      aria-label={propertyInfo.name || propertyInfo.type}
      data-myoxus-ui-role="button:icon-only:property-icon-selector"
      disabled={readonly}
      icon={<WorkspacePropertyIcon propertyInfo={propertyInfo} />}
    />
  );

  if (readonly) {
    return trigger;
  }

  return (
    <Menu
      contentOptions={{ panelWidth: "display" }}
      items={
        <IconsSelectorPanel
          selectedIcon={propertyInfo.icon}
          onSelectedChange={onSelectedChange}
        />
      }
    >
      {trigger}
    </Menu>
  );
};
