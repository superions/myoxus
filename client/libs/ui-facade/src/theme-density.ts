// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MantineThemeOverride, rem } from "@mantine/core";

/** Shared density for the Facade provider and isolated Lit consumers.
 * Keep this data-only: consuming spacing must not require mounting a React shell.
 * Colors and typography remain owned by the server theme projection. */
export const myoxusMantineDensity = {
  spacing: {
    "2xs": rem(2),
    xs: rem(4),
    sm: rem(8),
    md: rem(12),
    lg: rem(16),
    xl: rem(24),
    "2xl": rem(32),
  },
  radius: {
    xs: rem(2),
    sm: rem(4),
    md: rem(6),
    lg: rem(8),
    xl: rem(12),
  },
} satisfies Pick<MantineThemeOverride, "spacing" | "radius">;
