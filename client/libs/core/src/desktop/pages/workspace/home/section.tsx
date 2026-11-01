// SPDX-License-Identifier: AGPL-3.0-or-later

import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Group,
  Stack,
} from "@myoxus/ui-facade";
import type { ReactNode, Ref } from "react";

import { useDashboardEditChrome } from "./dashboard-edit-context";

export function DashboardSection({
  action,
  children,
  icon,
  scope,
  title,
  uiRole,
}: {
  action?: { label: string; onClick: () => void; ref?: Ref<HTMLButtonElement> };
  children: ReactNode;
  icon?: ReactNode;
  scope?: ReactNode;
  title: ReactNode;
  uiRole: string;
}) {
  const editChrome = useDashboardEditChrome();
  return (
    <Card
      component="section"
      fullHeight
      padding="none"
      withBorder
      data-myoxus-ui-role={uiRole}
    >
      <CardHeader>
        <Group align="flex-start" justify="space-between" wrap="nowrap">
          <Stack gap={0}>
            <CardTitle icon={icon}>{title}</CardTitle>
            {scope ? <CardDescription>{scope}</CardDescription> : null}
          </Stack>
          {editChrome ??
            (action ? (
              <Button
                ref={action.ref}
                suffix={<ArrowRightSmallIcon aria-hidden />}
                variant="plain"
                onClick={action.onClick}
              >
                {action.label}
              </Button>
            ) : null)}
        </Group>
      </CardHeader>
      <CardContent padding="sm">{children}</CardContent>
    </Card>
  );
}
