// SPDX-License-Identifier: AGPL-3.0-or-later
import { Alert } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function ToolFailedCardView({
  name,
  icon,
}: {
  name: string;
  icon: ReactNode;
}) {
  return (
    <Alert
      data-testid="chat-tool-failed"
      color="myoxusError"
      role="alert"
      icon={icon}
      title={name}
    />
  );
}
