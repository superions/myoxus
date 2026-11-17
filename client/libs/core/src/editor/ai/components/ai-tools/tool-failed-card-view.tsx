// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  InsideModalContext,
  MyoxusText,
  ReferenceCard,
} from "@myoxus/ui-facade";
import { useContext, type ReactNode } from "react";

export function ToolFailedCardView({
  name,
  icon,
  contained = true,
}: {
  name: string;
  icon: ReactNode;
  contained?: boolean;
}) {
  const inModal = useContext(InsideModalContext);
  return (
    <ReferenceCard
      size="small"
      contained={contained && !inModal}
      title={name}
      icon={
        <MyoxusText component="span" tone="danger">
          {icon}
        </MyoxusText>
      }
      role="alert"
      data-testid="chat-tool-failed"
    />
  );
}
