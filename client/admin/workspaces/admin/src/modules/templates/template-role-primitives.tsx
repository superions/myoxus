// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Template Registry helpers.
 *
 * These components keep P-AR-4-03 conversions visually consistent without
 * hiding business behaviour inside presentation code. They intentionally stay
 * small: tabs still own their mutations and data shaping, while this file owns
 * domain headings and metadata, composed from existing shared Settings roles.
 */
import {
  MetricStack,
  MonoText,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsDetailHeader,
  SettingsStatusText,
  SurfaceList as FacadeSurfaceList,
  SurfaceListItem as FacadeSurfaceListItem,
  SurfaceListItemMain,
  Stack,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "error" | "info";

export function TemplateTabFrame({
  title,
  description,
  shoulder,
  children,
}: {
  title: string;
  description?: string;
  shoulder?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Stack component="section" data-myoxus-ui-role="template-tab-frame">
      <SettingsDetailHeader
        title={title}
        description={description}
        actions={shoulder}
        headingLevel={2}
      />
      {children ?? null}
    </Stack>
  );
}

export function TemplateShoulder({
  rows,
}: {
  rows: { label: string; value: ReactNode; tone?: Tone }[];
}) {
  return (
    <MetricStack
      rows={rows.map((row) => ({
        label: row.label,
        value: row.value,
      }))}
    />
  );
}

export function SoftList({
  children,
  "data-testid": dataTestId,
}: {
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <FacadeSurfaceList data-testid={dataTestId}>{children}</FacadeSurfaceList>
  );
}

export function SoftListItem({
  children,
  density = "default",
}: {
  children: ReactNode;
  density?: "default" | "compact";
}) {
  return (
    <FacadeSurfaceListItem
      density={density}
      data-myoxus-ui-role="template-soft-list-item"
    >
      {children}
    </FacadeSurfaceListItem>
  );
}

export function MetaGrid({ children }: { children: ReactNode }) {
  return <SettingsDefinitionList>{children}</SettingsDefinitionList>;
}

export function MetaField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <SettingsDefinitionItem label={label} mono={mono}>
      {value}
    </SettingsDefinitionItem>
  );
}

export function TemplateCardTitle({
  title,
  subtitle,
  mono,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  mono?: ReactNode;
}) {
  return (
    <SurfaceListItemMain grow>
      <SettingsListItemTitle truncate>{title}</SettingsListItemTitle>
      {subtitle ? (
        <SettingsListItemMeta lineClamp={2}>{subtitle}</SettingsListItemMeta>
      ) : null}
      {mono ? (
        <SettingsStatusText mono truncate>
          <MonoText>{mono}</MonoText>
        </SettingsStatusText>
      ) : null}
    </SurfaceListItemMain>
  );
}
