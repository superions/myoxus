// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  DialogFooterActions,
  MyoxusText,
  MyoxusTitle,
  SettingsNotice,
} from "@myoxus/ui-facade";

import { ImportProgressStatus } from "./upload-step";

export function QueryErrorStep({
  errorText,
  onRetry,
  onStartOver,
}: {
  errorText: string;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const t = useI18n();
  return (
    <>
      <SettingsNotice tone="error">{errorText}</SettingsNotice>
      <DialogFooterActions>
        <Button variant="secondary" onClick={onRetry}>
          {t["Retry"]()}
        </Button>
        <Button variant="primary" onClick={onStartOver}>
          {t["com.myoxus.workspace-import.start-over"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}

export function PollingStep({
  isApplying,
  progress,
  cancelDisabled,
  onCancel,
}: {
  isApplying: boolean;
  progress: number;
  cancelDisabled: boolean;
  onCancel: () => void;
}) {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={3} typographySlot="section-title">
        {isApplying
          ? t["com.myoxus.workspace-import.applying"]()
          : t["com.myoxus.workspace-import.previewing"]()}
      </MyoxusTitle>
      <ImportProgressStatus
        ariaLabel={t["com.myoxus.workspace-import.progress"]()}
        label={`${progress}%`}
        value={progress}
      />
      <DialogFooterActions>
        <Button
          data-testid="workspace-import-cancel"
          disabled={cancelDisabled}
          variant="secondary"
          onClick={onCancel}
        >
          {t["Cancel"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}

export function TerminalStatusStep({
  status,
  errorText,
  onOpenWorkspace,
  onClose,
  onStartOver,
}: {
  status: "succeeded" | "cleanup_required" | "failed" | "cancelled" | "expired";
  errorText: string;
  onOpenWorkspace: () => void;
  onClose: () => void;
  onStartOver: () => void;
}) {
  const t = useI18n();

  if (status === "succeeded") {
    return (
      <>
        <SettingsNotice
          title={t["com.myoxus.workspace-import.success-title"]()}
          tone="success"
        >
          {t["com.myoxus.workspace-import.success-description"]()}
        </SettingsNotice>
        <DialogFooterActions>
          <Button
            data-testid="workspace-import-open"
            variant="primary"
            onClick={onOpenWorkspace}
          >
            {t["com.myoxus.workspace-import.open"]()}
          </Button>
        </DialogFooterActions>
      </>
    );
  }

  if (status === "cleanup_required") {
    return (
      <>
        <SettingsNotice
          title={t["com.myoxus.workspace-import.cleanup-title"]()}
          tone="error"
        >
          {t["com.myoxus.workspace-import.cleanup-description"]()}
        </SettingsNotice>
        <DialogFooterActions>
          <Button variant="secondary" onClick={onClose}>
            {t["com.myoxus.workspace-import.close"]()}
          </Button>
        </DialogFooterActions>
      </>
    );
  }

  return (
    <>
      {status === "cancelled" ? (
        <MyoxusText component="p" tone="secondary">
          {t["com.myoxus.workspace-import.cancelled"]()}
        </MyoxusText>
      ) : (
        <SettingsNotice tone="error">{errorText}</SettingsNotice>
      )}
      <DialogFooterActions>
        <Button variant="primary" onClick={onStartOver}>
          {t["com.myoxus.workspace-import.start-over"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}
