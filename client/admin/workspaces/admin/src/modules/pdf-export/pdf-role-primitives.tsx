// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PDF Export helpers.
 *
 * PDF export combines operator configuration, asset uploads and diagnostics.
 * These helpers keep the module on the shared Facade/Mantine shell without
 * moving business logic out of the existing tab components and GraphQL hooks.
 */
import {
  EmptyState,
  FieldLabel,
  SettingsHeadingGroup,
  SettingsPanelDescription,
  SettingsSectionHeading,
  Stack,
  SettingsToolbar,
  StatusDot,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function PdfTabFrame({
  title,
  description,
  shoulder,
  children,
}: {
  title: string;
  description?: string;
  shoulder?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack component="section" data-myoxus-ui-role="pdf-tab-frame">
      <PdfPanelHeader
        title={title}
        description={description}
        action={shoulder}
      />
      {children}
    </Stack>
  );
}

export function PdfPanelHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <SettingsToolbar layout="split" align="flex-start">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={2}>{title}</SettingsSectionHeading>
        {description ? (
          <SettingsPanelDescription>{description}</SettingsPanelDescription>
        ) : null}
      </SettingsHeadingGroup>
      {action}
    </SettingsToolbar>
  );
}

export { EmptyState, FieldLabel, StatusDot };
