// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { PageIcon } from "@myoxus/icons/react";
import { ReferenceCard } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

/** Commands and the existing rich-text renderer stay with the historical result reader. */
export function SectionEditResultView({
  actions,
  children,
}: {
  actions: ReactNode;
  children?: ReactNode;
}) {
  const t = useI18n();
  return (
    <ReferenceCard
      size="preview"
      contained
      fullWidth
      title={t["com.myoxus.ai.chat-panel.edited-content"]()}
      icon={<PageIcon />}
      actions={actions}
      data-testid="chat-section-edit-result"
    >
      {children}
    </ReferenceCard>
  );
}
