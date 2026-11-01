// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Native Mantine switch controls and the shared settings switch row.
 */
import {
  Divider as MantineDivider,
  Group,
  Stack,
  Switch as MantineSwitch,
} from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";

import { reactNodeText } from "../helpers/accessibility";
import { MyoxusText } from "../typography";

export type MyoxusSwitchProps = {
  id?: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  variant?: "default" | "pill";
  testId?: string;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

export function MyoxusSwitch({
  id,
  checked,
  onChange,
  onCheckedChange,
  disabled,
  variant = "pill",
  testId,
  "data-testid": dataTestId,
  className,
  style,
  children,
  "data-myoxus-ui-role": uiRole = "settings-switch",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: MyoxusSwitchProps) {
  return (
    <MantineSwitch
      id={id}
      data-testid={testId ?? dataTestId}
      data-myoxus-ui-role={uiRole}
      className={className}
      style={style}
      checked={checked ?? false}
      disabled={disabled}
      aria-label={ariaLabel ?? reactNodeText(children) ?? testId ?? dataTestId}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      label={children}
      radius={variant === "pill" ? "xl" : "sm"}
      onChange={(event) => {
        onChange?.(event.currentTarget.checked);
        onCheckedChange?.(event.currentTarget.checked);
      }}
      size="sm"
      withThumbIndicator={variant !== "pill"}
      attributes={{
        body: {
          "data-myoxus-ui-role": "settings-switch-label",
        },
        label: {
          "data-myoxus-ui-role": "settings-switch-label",
        },
      }}
    />
  );
}

export const Switch = MyoxusSwitch;

export type SettingsSwitchRowProps = {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  testId?: string;
  rowTestId?: string;
  separated?: boolean;
  className?: string;
  "aria-label"?: string;
};

export function SettingsSwitchRow({
  label,
  description,
  checked,
  onChange,
  onCheckedChange,
  disabled,
  testId,
  rowTestId,
  separated = false,
  className,
  "aria-label": ariaLabel,
}: SettingsSwitchRowProps) {
  return (
    <Stack
      className={className}
      data-testid={rowTestId}
      gap={0}
      data-myoxus-ui-role="settings-switch-row"
    >
      <Group
        align={description ? "flex-start" : "center"}
        justify="space-between"
        p="sm"
        wrap="nowrap"
        data-myoxus-ui-role="settings-switch-row-content"
      >
        <Stack flex={1} gap="xs" miw={0}>
          <MyoxusText
            component="span"
            tone={disabled ? "secondary" : "primary"}
            data-myoxus-ui-role="settings-switch-row-label"
          >
            {label}
          </MyoxusText>
          {description ? (
            <MyoxusText
              component="span"
              tone="secondary"
              typographySlot="body-small"
              data-myoxus-ui-role="settings-switch-row-description"
            >
              {description}
            </MyoxusText>
          ) : null}
        </Stack>
        <Switch
          checked={checked}
          disabled={disabled}
          variant="pill"
          testId={testId}
          aria-label={ariaLabel ?? reactNodeText(label)}
          onChange={(nextChecked) => {
            onChange?.(nextChecked);
            onCheckedChange?.(nextChecked);
          }}
        />
      </Group>
      {separated ? (
        <MantineDivider data-myoxus-ui-role="settings-switch-row-divider" />
      ) : null}
    </Stack>
  );
}
