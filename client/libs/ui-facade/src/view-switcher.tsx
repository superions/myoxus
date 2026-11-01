// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Box,
  Group,
  SegmentedControl,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

type ViewSwitcherIconProps = {
  "aria-hidden"?: boolean;
  focusable?: boolean | "false" | "true";
  height?: number | string;
  size?: number | string;
  width?: number | string;
};

export type ViewSwitcherItem<TValue extends string = string> = {
  value: TValue;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  testId?: string;
};

export type ViewSwitcherProps<TValue extends string = string> = {
  items: ReadonlyArray<ViewSwitcherItem<TValue>>;
  value?: TValue;
  onChange?: (value: TValue) => void;
  layout?: "header" | "sidebar";
  "aria-label"?: string;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
};

function normalizeViewSwitcherIcon(icon: ReactNode): ReactNode {
  if (!isValidElement<ViewSwitcherIconProps>(icon)) return icon;
  if (
    icon.props.size !== undefined ||
    icon.props.width !== undefined ||
    icon.props.height !== undefined
  ) {
    return icon;
  }

  return cloneElement(icon as ReactElement<ViewSwitcherIconProps>, {
    "aria-hidden": icon.props["aria-hidden"] ?? true,
    focusable: icon.props.focusable ?? false,
    size: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
  });
}

/**
 * Native Mantine view selector for Workbench headers and side panels.
 * Product modules provide domain values, labels and icons only; Mantine owns
 * the radio semantics, indicator, spacing, density and interaction states.
 */
export function ViewSwitcher<TValue extends string = string>({
  items,
  value,
  onChange,
  layout = "header",
  "aria-label": ariaLabel,
  "data-testid": testId,
  "data-myoxus-ui-role": uiRole = "view-switcher",
}: ViewSwitcherProps<TValue>) {
  return (
    <SegmentedControl<TValue>
      aria-label={ariaLabel}
      data={items.map(
        ({ disabled, icon, label, testId: itemTestId, value }) => ({
          disabled,
          value,
          label:
            layout === "header" && icon ? (
              <Tooltip label={label} position="bottom">
                <Group
                  component="span"
                  data-myoxus-ui-role="view-switcher-label"
                  data-testid={itemTestId}
                  justify="center"
                  wrap="nowrap"
                >
                  <Box
                    component="span"
                    data-myoxus-ui-role="view-switcher-icon"
                  >
                    {normalizeViewSwitcherIcon(icon)}
                  </Box>
                  <VisuallyHidden>{label}</VisuallyHidden>
                </Group>
              </Tooltip>
            ) : (
              <Group
                component="span"
                data-myoxus-ui-role="view-switcher-label"
                gap="xs"
                justify="center"
                wrap="nowrap"
                data-testid={itemTestId}
              >
                {icon ? (
                  <Box
                    component="span"
                    data-myoxus-ui-role="view-switcher-icon"
                  >
                    {normalizeViewSwitcherIcon(icon)}
                  </Box>
                ) : null}
                <span>{label}</span>
              </Group>
            ),
        }),
      )}
      data-myoxus-ui-role={uiRole}
      data-testid={testId}
      fullWidth={layout === "sidebar"}
      value={value}
      withItemsBorders={false}
      onChange={(next) => onChange?.(next)}
    />
  );
}
