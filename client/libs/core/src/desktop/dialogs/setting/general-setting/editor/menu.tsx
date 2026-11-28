// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ComponentProps, ReactNode } from "react";

import {
  Menu,
  MenuTrigger,
  RadioGroup,
  SettingsControlGroup,
  Slider,
} from "../../primitives";

export function DropdownMenu({
  items,
  trigger,
}: {
  items: ReactNode;
  trigger: ReactNode;
}) {
  return (
    <SettingsControlGroup>
      <Menu
        items={items}
        contentOptions={{
          align: "end",
          panelWidth: "display",
        }}
      >
        {trigger}
      </Menu>
    </SettingsControlGroup>
  );
}

export function DropdownTrigger(props: ComponentProps<typeof MenuTrigger>) {
  return <MenuTrigger {...props} block />;
}

export function EditorRadioGroup(props: ComponentProps<typeof RadioGroup>) {
  return (
    <SettingsControlGroup>
      <RadioGroup {...props} block />
    </SettingsControlGroup>
  );
}

export function EditorSlider(props: ComponentProps<typeof Slider>) {
  return (
    <SettingsControlGroup stretch>
      <Slider {...props} block />
    </SettingsControlGroup>
  );
}
