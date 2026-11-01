import type { CSSProperties, ReactNode } from "react";

import {
  Group,
  SelectableCardRow,
  SelectionIndicator,
  SettingsControlList,
  SettingsDetailHeader,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsRow,
  SettingsSwitchRow,
  Stack,
  ThemeIcon,
} from "../../primitives";

export const IntegrationSettingHeader = ({
  icon,
  name,
  desc,
  action,
  divider = true,
}: {
  icon: ReactNode;
  name: string;
  desc: string;
  action?: ReactNode;
  divider?: boolean;
}) => {
  return (
    <SettingsDetailHeader
      title={name}
      description={desc}
      actions={action}
      divider={divider}
      leading={
        <ThemeIcon
          variant="light"
          color="myoxus"
          size="lg"
          data-myoxus-ui-role="settings-header-icon"
        >
          {icon}
        </ThemeIcon>
      }
    />
  );
};

// universal
export interface IntegrationSettingItemProps {
  name?: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}
export const IntegrationSettingItem = ({
  name,
  desc,
  children,
  className,
  style,
  "data-testid": dataTestId,
}: IntegrationSettingItemProps) => {
  return (
    <SettingsRow
      name={name}
      desc={desc}
      className={className}
      style={style}
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-row"
    >
      {children}
    </SettingsRow>
  );
};

// toggle
export interface IntegrationSettingToggleProps {
  name: string;
  desc?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}
export const IntegrationSettingToggle = ({
  name,
  desc,
  checked,
  onChange,
}: IntegrationSettingToggleProps) => {
  return (
    <SettingsSwitchRow
      label={name}
      description={desc}
      checked={checked}
      onChange={onChange}
    />
  );
};

// text-radio-group
export interface IntegrationSettingTextRadioGroupItem {
  name: string;
  desc?: string;
  value: any;
}
export interface IntegrationSettingTextRadioGroupProps {
  items: IntegrationSettingTextRadioGroupItem[];
  checked: any;
  onChange: (value: any) => void;
}
export const IntegrationSettingTextRadioGroup = ({
  items,
  checked,
  onChange,
}: IntegrationSettingTextRadioGroupProps) => {
  return (
    <SettingsControlList role="list" data-myoxus-ui-role="settings-radio-group">
      {items.map((item) => (
        <SelectableCardRow
          type="button"
          onClick={() => onChange(item.value)}
          key={item.value}
          selected={checked === item.value}
          data-myoxus-ui-role="settings-radio-row"
        >
          <Group justify="space-between" wrap="nowrap">
            <Stack>
              <SettingsListItemTitle data-myoxus-ui-role="settings-row-label">
                {item.name}
              </SettingsListItemTitle>
              {item.desc && (
                <SettingsListItemMeta data-myoxus-ui-role="settings-row-description">
                  {item.desc}
                </SettingsListItemMeta>
              )}
            </Stack>
            <SelectionIndicator
              selected={checked === item.value}
              data-myoxus-ui-role="settings-row-control"
            />
          </Group>
        </SelectableCardRow>
      ))}
    </SettingsControlList>
  );
};
