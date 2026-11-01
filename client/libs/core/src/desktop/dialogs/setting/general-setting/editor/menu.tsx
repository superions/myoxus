import { type ComponentProps, type ReactNode } from "react";

import {
  Menu,
  MenuTrigger,
  RadioGroup,
  SettingsControlGroup,
  Slider,
} from "../../primitives";

export const DropdownMenu = ({
  items,
  trigger,
}: {
  items: ReactNode;
  trigger: ReactNode;
}) => {
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
};

export const DropdownTrigger = (props: ComponentProps<typeof MenuTrigger>) => {
  return <MenuTrigger {...props} block />;
};

export const EditorRadioGroup = (props: ComponentProps<typeof RadioGroup>) => {
  return (
    <SettingsControlGroup>
      <RadioGroup {...props} block />
    </SettingsControlGroup>
  );
};

export const EditorSlider = (props: ComponentProps<typeof Slider>) => {
  return (
    <SettingsControlGroup>
      <Slider {...props} block />
    </SettingsControlGroup>
  );
};
