// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { CopyIcon, DoneIcon } from "@myoxus/icons/react";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Group,
  IconButton,
  Loading,
  MyoxusText,
} from "@myoxus/ui-facade";
import type { EditorCodePreviewStatus } from "@virgultum/editor/shared/services";
import { decorateEditorEmbeddedUI } from "../editor-view/embedded-ui-root";

export function CodePreviewStatus({
  status: s,
}: {
  status: EditorCodePreviewStatus;
}) {
  const t = useI18n();
  const message =
    s.state === "loading"
      ? t["com.myoxus.editor.code-preview.loading"]({ language: s.language })
      : s.state === "empty"
        ? t["com.myoxus.editor.code-preview.empty"]({ language: s.language })
        : s.fontError
          ? t["com.myoxus.editor.code-preview.fonts-failed"]()
          : t["com.myoxus.editor.code-preview.failed"]({
              language: s.language,
            });
  if (s.state !== "error")
    return (
      <Group
        role="status"
        data-testid="code-preview-status"
        data-range-sync-exclude="true"
      >
        {s.state === "loading" ? <Loading /> : null}
        <MyoxusText tone="secondary">{message}</MyoxusText>
      </Group>
    );
  // Technical details own their native selection and clipboard, not the document range.
  return (
    <Alert
      data-range-sync-exclude="true"
      tabIndex={s.detail ? 0 : undefined}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      color="myoxusError"
      title={message}
      data-testid="code-preview-status"
    >
      {s.detail ? (
        s.copy ? (
          <Accordion>
            <AccordionItem value="details">
              <AccordionControl>
                {t["com.myoxus.editor.code-preview.details"]()}
              </AccordionControl>
              <AccordionPanel>
                <MyoxusText
                  component="div"
                  typographySlot="code-block"
                  preserveWhitespace
                >
                  {s.detail}
                </MyoxusText>
                <IconButton
                  icon={s.copyState === "copied" ? <DoneIcon /> : <CopyIcon />}
                  tooltip={
                    s.copyState === "copied"
                      ? t["Copied to clipboard"]()
                      : s.copyState === "failed"
                        ? t["com.myoxus.editor.clipboard.copy-failed"]()
                        : t.Copy()
                  }
                  onClick={s.copy}
                />
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        ) : (
          <MyoxusText preserveWhitespace>{s.detail}</MyoxusText>
        )
      ) : null}
    </Alert>
  );
}

/** Mount through the owning editor/AI React tree; never create a second React root. */
export function renderCodePreviewStatus(
  reactToLit: ReactToLit,
  status: EditorCodePreviewStatus,
) {
  return reactToLit(
    <CodePreviewStatus status={status} />,
    true,
    decorateEditorEmbeddedUI,
  );
}
