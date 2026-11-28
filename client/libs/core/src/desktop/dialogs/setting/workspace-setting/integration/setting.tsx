// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
}) => (
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
}: IntegrationSettingItemProps) => (
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
}: IntegrationSettingToggleProps) => (
  <SettingsSwitchRow
    label={name}
    description={desc}
    checked={checked}
    onChange={onChange}
  />
);

export interface IntegrationSettingTextRadioGroupItem<T = string> {
  name: string;
  desc?: string;
  value: T;
}

export interface IntegrationSettingTextRadioGroupProps<T = string> {
  items: IntegrationSettingTextRadioGroupItem<T>[];
  checked: T;
  onChange: (value: T) => void;
}

export function IntegrationSettingTextRadioGroup<T = string>({
  items,
  checked,
  onChange,
}: IntegrationSettingTextRadioGroupProps<T>) {
  return (
    <SettingsControlList role="list" data-myoxus-ui-role="settings-radio-group">
      {items.map((item) => {
        const isSelected = checked === item.value;
        return (
          <SelectableCardRow
            key={String(item.value)}
            type="button"
            onClick={() => onChange(item.value)}
            selected={isSelected}
            data-myoxus-ui-role="settings-radio-row"
          >
            <Group justify="space-between" wrap="nowrap">
              <Stack>
                <SettingsListItemTitle data-myoxus-ui-role="settings-row-label">
                  {item.name}
                </SettingsListItemTitle>
                {item.desc ? (
                  <SettingsListItemMeta data-myoxus-ui-role="settings-row-description">
                    {item.desc}
                  </SettingsListItemMeta>
                ) : null}
              </Stack>
              <SelectionIndicator
                selected={isSelected}
                data-myoxus-ui-role="settings-row-control"
              />
            </Group>
          </SelectableCardRow>
        );
      })}
    </SettingsControlList>
  );
}
