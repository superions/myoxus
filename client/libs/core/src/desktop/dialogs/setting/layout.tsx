import { type HtmlHTMLAttributes, type ReactNode } from "react";

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  SettingsHeadingGroup,
  SettingsPanelDescription,
  SettingsPanelTitle,
} from "./primitives";

interface CollapsibleWrapperProps extends Omit<
  HtmlHTMLAttributes<HTMLDivElement>,
  "title"
> {
  title?: ReactNode;
  caption?: ReactNode;
}

export const CollapsibleWrapper = (props: CollapsibleWrapperProps) => {
  const { title, caption, children, ...itemProps } = props;
  return (
    <Accordion
      defaultValue="settings-collapsible"
      variant="separated"
      data-myoxus-ui-role="settings-collapsible"
    >
      <AccordionItem
        {...itemProps}
        value="settings-collapsible"
        data-myoxus-ui-role="settings-collapsible-item"
      >
        <AccordionControl data-myoxus-ui-role="settings-collapsible-control">
          <SettingsHeadingGroup>
            <SettingsPanelTitle>{title}</SettingsPanelTitle>
            {caption ? (
              <SettingsPanelDescription>{caption}</SettingsPanelDescription>
            ) : null}
          </SettingsHeadingGroup>
        </AccordionControl>
        <AccordionPanel data-myoxus-ui-role="settings-collapsible-panel">
          {children}
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};
