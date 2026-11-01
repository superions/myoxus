// SPDX-License-Identifier: AGPL-3.0-or-later
import { Card, Group, MyoxusLoader, MyoxusText } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function ToolCallCardView({
  name,
  icon,
}: {
  name: string;
  icon: ReactNode;
}) {
  return (
    <Card data-testid="chat-tool-pending" aria-busy="true">
      <Group wrap="nowrap">
        <MyoxusLoader />
        {icon}
        <MyoxusText>{name}</MyoxusText>
      </Group>
    </Card>
  );
}
