// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ComponentProps } from "react";
import { Accordion as MantineAccordion } from "@mantine/core";

type MyoxusAccordionProps = ComponentProps<typeof MantineAccordion> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusAccordionItemProps = ComponentProps<typeof MantineAccordion.Item> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusAccordionControlProps = ComponentProps<
  typeof MantineAccordion.Control
> & {
  "data-myoxus-ui-role"?: string;
};

type MyoxusAccordionPanelProps = Omit<
  ComponentProps<typeof MantineAccordion.Panel>,
  "styles"
> & {
  "data-myoxus-ui-role"?: string;
  flushHorizontal?: boolean;
};

// Accordion/Table exports are intentionally thin Mantine adapters. Their value
// is stable Myoxus role metadata plus shared token-aware cell helpers; product
// routes must not rebuild table chrome with local `admin-ui-table-*` classes.
export const Accordion = ({
  "data-myoxus-ui-role": uiRole = "accordion",
  ...props
}: MyoxusAccordionProps) => (
  <MantineAccordion {...props} data-myoxus-ui-role={uiRole} />
);

export const AccordionItem = ({
  "data-myoxus-ui-role": uiRole = "accordion-item",
  ...props
}: MyoxusAccordionItemProps) => (
  <MantineAccordion.Item {...props} data-myoxus-ui-role={uiRole} />
);

export const AccordionControl = ({
  "data-myoxus-ui-role": uiRole = "accordion-control",
  style,
  ...props
}: MyoxusAccordionControlProps) => (
  <MantineAccordion.Control
    {...props}
    style={style}
    data-myoxus-ui-role={uiRole}
  />
);

export const AccordionPanel = ({
  "data-myoxus-ui-role": uiRole = "accordion-panel",
  flushHorizontal = false,
  style,
  ...props
}: MyoxusAccordionPanelProps) => (
  <MantineAccordion.Panel
    {...props}
    styles={flushHorizontal ? { content: { paddingInline: 0 } } : undefined}
    style={style}
    data-myoxus-ui-role={uiRole}
  />
);
