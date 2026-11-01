// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Radio as MantineRadio,
  SimpleGrid as MantineSimpleGrid,
  Skeleton as MantineSkeleton,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { Children, type ComponentProps, type PropsWithChildren } from "react";

export const RadioCardGroup = MantineRadio.Group;
export const RadioCardIndicator = MantineRadio.Indicator;

type UiRoleProps = { "data-myoxus-ui-role"?: string };

/**
 * Responsive selection-card layout owned by Mantine at the Facade boundary.
 * Product code supplies choices, not viewport rules or grid CSS.
 */
export function SelectionCardGrid({
  children,
  columns = 2,
  "data-myoxus-ui-role": uiRole = "radio-selection-card-grid",
  ...props
}: PropsWithChildren<
  Omit<ComponentProps<typeof MantineSimpleGrid>, "cols"> & UiRoleProps
> & {
  columns?: 2 | 3;
}) {
  return (
    <MantineSimpleGrid
      {...props}
      cols={{ base: 1, sm: columns }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </MantineSimpleGrid>
  );
}

/**
 * Native Mantine radio card with the shared form density applied at the Facade
 * boundary. Product code supplies content and selection state, never card CSS.
 */
export function RadioCard({
  density = "default",
  selected = false,
  square = false,
  style,
  "data-myoxus-ui-role": uiRole = "radio-selection-card",
  ...props
}: ComponentProps<typeof MantineRadio.Card> &
  UiRoleProps & {
    density?: "compact" | "default";
    selected?: boolean;
    square?: boolean;
  }) {
  return (
    <MantineRadio.Card
      p={density === "compact" ? "sm" : "md"}
      {...props}
      data-selected={selected ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        aspectRatio: square ? "1" : undefined,
        background: selected
          ? `color-mix(in srgb, ${cssVar(
              "backgroundPrimaryColor",
            )} 94%, ${cssVar("primaryColor")} 6%)`
          : undefined,
        borderColor: selected ? cssVar("primaryColor") : undefined,
        display: square ? "grid" : undefined,
        gridTemplateRows: square ? "minmax(0, 1fr)" : undefined,
        ...style,
      }}
    />
  );
}

/** Stable loading geometry for selectable card grids without route sizing. */
export function SelectionCardSkeleton() {
  return (
    <MantineSkeleton
      h="calc(var(--mantine-spacing-xl) * 4)"
      radius="md"
      data-myoxus-ui-role="radio-selection-card-skeleton"
    />
  );
}

/** Stable responsive loading surface matching {@link SelectionCardGrid}. */
export function SelectionCardSkeletonGrid({
  count = 4,
  "data-myoxus-ui-role": uiRole = "radio-selection-card-skeleton-grid",
  ...props
}: Omit<ComponentProps<typeof SelectionCardGrid>, "children"> & {
  count?: number;
}) {
  return (
    <SelectionCardGrid {...props} data-myoxus-ui-role={uiRole}>
      {Children.toArray(
        Array.from({ length: count }, (_, index) => (
          <SelectionCardSkeleton key={index} />
        )),
      )}
    </SelectionCardGrid>
  );
}
