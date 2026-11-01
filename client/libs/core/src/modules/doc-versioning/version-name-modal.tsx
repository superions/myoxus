// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  Input,
  Modal,
  type ModalProps,
  MyoxusText,
  SettingsNotice,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

/** Shared form for naming a new or already captured document state. */
export function DocumentVersionNameModal({
  title,
  open = true,
  initialLabel,
  initialDescription,
  busy,
  error,
  testId,
  stackId,
  onClose,
  onSubmit,
  allowUnnamed = false,
  returnFocusRef,
}: {
  title: string;
  open?: boolean;
  initialLabel?: string;
  initialDescription?: string | null;
  busy: boolean;
  error: string | null;
  testId: string;
  stackId?: string;
  onClose: () => void;
  onSubmit: (label: string, description: string | null) => void;
  allowUnnamed?: boolean;
  returnFocusRef?: ModalProps["returnFocusRef"];
}) {
  const t = useI18n();
  const [label, setLabel] = useState(initialLabel ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");

  useEffect(() => {
    if (!open) return;
    setLabel(initialLabel ?? "");
    setDescription(initialDescription ?? "");
  }, [initialDescription, initialLabel, open]);

  return (
    <Modal
      returnFocusRef={returnFocusRef}
      stackId={stackId}
      open={open}
      onOpenChange={(open: boolean) => !open && onClose()}
      title={title}
    >
      <Stack
        aria-label={title}
        component="section"
        data-myoxus-ui-role="dialog-panel"
        data-testid={testId}
      >
        <MyoxusText
          component="p"
          fallbackSlot="caption"
          m={0}
          tone="tertiary"
          tt="uppercase"
          typographySlot="caption"
          data-myoxus-ui-role="panel-eyebrow"
        >
          {allowUnnamed
            ? t["com.myoxus.sidebar.document-versions.modal.save-eyebrow"]()
            : t["com.myoxus.sidebar.document-versions.modal.eyebrow"]()}
        </MyoxusText>
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
        <Input
          autoFocus
          data-testid={`${testId}-label`}
          label={
            allowUnnamed
              ? t["com.myoxus.sidebar.document-versions.modal.name"]()
              : t["com.myoxus.sidebar.document-versions.modal.label"]()
          }
          maxLength={96}
          onChange={setLabel}
          value={label}
        />
        {allowUnnamed && !label.trim() ? (
          <SettingsNotice>
            {t["com.myoxus.sidebar.document-versions.modal.unnamed-help"]()}
          </SettingsNotice>
        ) : (
          <Textarea
            autosize
            data-testid={`${testId}-description`}
            label={t[
              "com.myoxus.sidebar.document-versions.modal.description"
            ]()}
            minRows={4}
            onChange={setDescription}
            value={description}
          />
        )}
        <Group data-myoxus-ui-role="action-row">
          <Button disabled={busy} onClick={onClose} variant="secondary">
            {t["Cancel"]()}
          </Button>
          <Button
            data-testid={`${testId}-save`}
            disabled={busy || (!allowUnnamed && label.trim().length === 0)}
            onClick={() =>
              onSubmit(label, description.trim() ? description : null)
            }
            variant="primary"
          >
            {busy
              ? t["com.myoxus.sidebar.action.saving"]()
              : allowUnnamed
                ? t["com.myoxus.sidebar.document-versions.action.save"]()
                : t["Save"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
