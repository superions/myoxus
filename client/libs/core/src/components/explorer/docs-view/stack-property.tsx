// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Badge, BadgeList, BadgeListItem } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export const StackProperty = ({
  icon,
  children,
}: {
  icon: ReactNode | null;
  children: ReactNode;
}) => (
  <BadgeList>
    <BadgeListItem>
      <Badge prefix={icon ?? undefined}>{children}</Badge>
    </BadgeListItem>
  </BadgeList>
);
