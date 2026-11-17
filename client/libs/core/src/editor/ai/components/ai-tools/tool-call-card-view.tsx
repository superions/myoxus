// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ReferenceCard,
  MyoxusLoader,
  InsideModalContext,
} from "@myoxus/ui-facade";
import { useContext, type ReactNode } from "react";

export function ToolCallCardView({
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
      icon={icon}
      actions={<MyoxusLoader />}
      data-testid="chat-tool-pending"
      aria-busy="true"
    />
  );
}
