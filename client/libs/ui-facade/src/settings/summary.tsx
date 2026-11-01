// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Compact settings summaries and semantic fact displays.
 */
import {
  Box,
  Card as MantineCard,
  Group,
  Stack,
  Table as MantineTable,
  Text,
} from "@mantine/core";
import { cssTypographyVar, cssVar } from "@myoxus/theme";
import { type PropsWithChildren, type ReactNode } from "react";

export function SettingsSummaryCard({
  label,
  children,
  "data-testid": dataTestId,
}: PropsWithChildren<{ label: ReactNode; "data-testid"?: string }>) {
  return (
    <MantineCard
      withBorder
      p="sm"
      data-testid={dataTestId}
      data-myoxus-ui-role="settings-summary-card"
    >
      <Stack gap="xs">
        <Text
          c="myoxus-text-secondary"
          data-myoxus-ui-role="settings-summary-label"
        >
          {label}
        </Text>
        <Group
          gap="xs"
          wrap="nowrap"
          data-myoxus-ui-role="settings-summary-value"
        >
          {children}
        </Group>
      </Stack>
    </MantineCard>
  );
}

export function SettingsDefinitionList({
  children,
  "data-testid": dataTestId,
}: PropsWithChildren<{ "data-testid"?: string }>) {
  return (
    <Box
      component="dl"
      data-testid={dataTestId}
      style={{
        display: "grid",
        gridTemplateColumns: "max-content minmax(0, 1fr)",
        columnGap:
          "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        rowGap: "var(--mantine-spacing-xs)",
        margin: 0,
      }}
      data-myoxus-ui-role="settings-definition-list"
    >
      {children}
    </Box>
  );
}

/**
 * Definition-list row for metadata/facts. The optional monospace mode is a
 * technical-readability exception for IDs/paths, not a new text style for
 * product copy.
 */
export function SettingsDefinitionItem({
  label,
  children,
  mono = false,
  "data-myoxus-ui-role": uiRole,
}: PropsWithChildren<{
  label: ReactNode;
  mono?: boolean;
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <>
      <Text
        component="dt"
        c="myoxus-text-secondary"
        data-myoxus-ui-role="settings-definition-label"
      >
        {label}
      </Text>
      <Group
        component="dd"
        gap="xs"
        m={0}
        miw={0}
        wrap="wrap"
        style={
          mono
            ? {
                overflowWrap: "anywhere",
                fontFamily: cssTypographyVar(
                  "monospace",
                  "family",
                  cssTypographyVar(
                    "body-small",
                    "family",
                    cssVar("fontFamily"),
                  ),
                ),
              }
            : { overflowWrap: "anywhere" }
        }
        data-myoxus-ui-role={
          uiRole ??
          (mono
            ? "settings-definition-value:mono"
            : "settings-definition-value")
        }
      >
        {children}
      </Group>
    </>
  );
}

export function SettingsDataTable({
  children,
  "aria-label": ariaLabel,
}: PropsWithChildren<{ "aria-label"?: string }>) {
  // Legacy settings surfaces still need semantic table markup, but table chrome
  // must not come from Admin-global `admin-ui-table-*` classes.
  return (
    <MantineTable
      aria-label={ariaLabel}
      data-myoxus-ui-role="settings-data-table"
    >
      {children}
    </MantineTable>
  );
}
