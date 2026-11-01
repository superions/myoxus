// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import { ScrollArea, Group, Box } from "@mantine/core";

// Shared Mobile document rails keep horizontal scrolling and responsive card
// sizing inside the Mantine-backed facade instead of product class bridges.
const mobileDocStripItemWidth = {
  base: `calc(calc(var(--mantine-spacing-2xl) * 2) * 2 + var(--mantine-spacing-2xl))`,
  xs: `calc(calc(var(--mantine-spacing-2xl) * 2) * 3)`,
};

export function MobileDocScroller({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-doc-scroller",
  ...props
}: RoleBoxProps) {
  return (
    <ScrollArea
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      offsetScrollbars={false}
      scrollbars="x"
      type="auto"
      style={{
        width: "100%",
        ...style,
      }}
      styles={{
        viewport: {
          paddingBlock: `var(--mantine-spacing-md) var(--mantine-spacing-2xl)`,
        },
      }}
    >
      {children}
    </ScrollArea>
  );
}

export function MobileDocStrip({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-doc-strip",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      component="ul"
      role={props.role ?? "list"}
      className={className}
      data-myoxus-ui-role={uiRole}
      gap={"var(--mantine-spacing-md)"}
      wrap="nowrap"
      style={{
        listStyle: "none",
        margin: 0,
        paddingInline: "var(--mantine-spacing-lg)",
        width: "max-content",
        ...style,
      }}
    >
      {children}
    </Group>
  );
}

export function MobileDocStripItem({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-doc-strip-item",
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      component="li"
      className={className}
      data-myoxus-ui-role={uiRole}
      w={mobileDocStripItemWidth}
      style={{
        aspectRatio: "17 / 21",
        flex: "0 0 auto",
        listStyle: "none",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}
