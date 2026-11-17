// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { CloseIcon, DoneIcon, PenIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { Box, Button, Group, ReferenceCard } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

/** The historical reader owns commands and state; this view owns only its chrome. */
export function DocEditResultView({
  docId,
  operation,
  collapsed,
  applying,
  accepting,
  actions,
  apply,
  reject,
  accept,
  children,
}: {
  docId: string;
  operation: string;
  collapsed: boolean;
  applying: boolean;
  accepting: boolean;
  actions: ReactNode;
  apply: () => void;
  reject: () => void;
  accept: () => void;
  children?: ReactNode;
}) {
  const t = useI18n();
  const busy = applying || accepting;
  return (
    <ReferenceCard
      size="preview"
      contained
      fullWidth
      title={docId}
      metadata={operation}
      icon={<PenIcon />}
      actions={
        <>
          {actions}
          <Button disabled={busy} loading={applying} onClick={apply}>
            {applying
              ? t["com.myoxus.ai.chat-panel.doc-edit.applying"]()
              : t.Apply()}
          </Button>
        </>
      }
      data-testid="chat-doc-edit-result"
    >
      {/* Collapse hides rather than disposes the retained rich-text/diff renderer. */}
      <Box hidden={collapsed}>
        {children}
        <Group>
          <Button prefix={<CloseIcon />} onClick={reject}>
            {t["com.myoxus.ai.chat-panel.doc-edit.reject"]()}
          </Button>
          <Button
            prefix={<DoneIcon />}
            disabled={busy}
            loading={accepting}
            onClick={accept}
          >
            {accepting
              ? t["com.myoxus.ai.chat-panel.doc-edit.accepting"]()
              : t["com.myoxus.ai.chat-panel.doc-edit.accept"]()}
          </Button>
        </Group>
      </Box>
    </ReferenceCard>
  );
}
