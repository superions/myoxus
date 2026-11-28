// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  DialogFooterActions,
  Group,
  MyoxusText,
  MyoxusTitle,
  Progress,
  RadioGroup,
  SettingsNotice,
  UploadTarget,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export type WorkspaceImportSource = "workspace-backup" | "obsidian-vault";
export type LocalUploadPhase = "idle" | "preparing" | "uploading";

export function ImportProgressStatus({
  ariaLabel,
  label,
  value,
}: {
  ariaLabel: string;
  label: ReactNode;
  value: number;
}) {
  return (
    <Group
      align="center"
      miw={0}
      wrap="nowrap"
      data-myoxus-ui-role="workspace-import-progress-status"
    >
      <Progress
        ariaLabel={ariaLabel}
        showValueLabel={false}
        style={{ flex: "1 1 auto" }}
        value={value}
      />
      <MyoxusText
        component="span"
        tone="secondary"
        truncate
        typographySlot="body-small"
      >
        {label}
      </MyoxusText>
    </Group>
  );
}

export function LocalUploadProgressStep({
  phase,
  progress,
  onCancel,
}: {
  phase: Exclude<LocalUploadPhase, "idle">;
  progress: number;
  onCancel: () => void;
}) {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={3} typographySlot="section-title">
        {phase === "preparing"
          ? t["com.myoxus.workspace-import.preparing"]()
          : t["com.myoxus.workspace-import.uploading"]()}
      </MyoxusTitle>
      <ImportProgressStatus
        ariaLabel={t["com.myoxus.workspace-import.progress"]()}
        label={`${progress}%`}
        value={progress}
      />
      <DialogFooterActions>
        <Button variant="secondary" onClick={onCancel}>
          {t["Cancel"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}

export function UploadStep({
  accept,
  source,
  hasError,
  onSourceChange,
  onSelectFile,
}: {
  accept: string;
  source: WorkspaceImportSource;
  hasError: boolean;
  onSourceChange: (next: WorkspaceImportSource) => void;
  onSelectFile: (file: File) => void;
}) {
  const t = useI18n();
  const isVault = source === "obsidian-vault";

  return (
    <>
      <MyoxusText component="p" tone="secondary">
        {t["com.myoxus.workspace-import.description"]()}
      </MyoxusText>
      <RadioGroup
        block
        value={source}
        data-myoxus-ui-role="workspace-import-source-selector"
        items={[
          {
            value: "workspace-backup",
            label: t["com.myoxus.workspace-import.source.workspace-backup"](),
            testId: "workspace-import-source-workspace-backup",
          },
          {
            value: "obsidian-vault",
            label: t["com.myoxus.workspace-import.source.obsidian-vault"](),
            testId: "workspace-import-source-obsidian-vault",
          },
        ]}
        onChange={onSourceChange}
      />
      {hasError ? (
        <SettingsNotice tone="error">
          {t["com.myoxus.workspace-import.error.generic"]()}
        </SettingsNotice>
      ) : null}
      <UploadTarget
        accept={accept}
        data-testid="workspace-import-upload"
        title={
          isVault
            ? t["com.myoxus.workspace-import.upload-vault-title"]()
            : t["com.myoxus.workspace-import.upload-title"]()
        }
        description={
          isVault
            ? t["com.myoxus.workspace-import.upload-vault-description"]()
            : t["com.myoxus.workspace-import.upload-description"]()
        }
        pickLabel={t["com.myoxus.workspace-import.choose-file"]()}
        onFile={onSelectFile}
      />
    </>
  );
}

export function StagedRecoveryStep({
  canResumeUpload,
  previewBusy,
  onStartOver,
  onResumeUpload,
  onRetryPreview,
}: {
  canResumeUpload: boolean;
  previewBusy: boolean;
  onStartOver: () => void;
  onResumeUpload: () => void;
  onRetryPreview: () => void;
}) {
  const t = useI18n();
  if (canResumeUpload) {
    return (
      <>
        <SettingsNotice title={t["com.myoxus.workspace-import.resume-title"]()}>
          {t["com.myoxus.workspace-import.resume-description"]()}
        </SettingsNotice>
        <DialogFooterActions>
          <Button variant="secondary" onClick={onStartOver}>
            {t["com.myoxus.workspace-import.start-over"]()}
          </Button>
          <Button variant="primary" onClick={onResumeUpload}>
            {t["com.myoxus.workspace-import.resume"]()}
          </Button>
        </DialogFooterActions>
      </>
    );
  }

  return (
    <>
      <SettingsNotice
        title={t["com.myoxus.workspace-import.preview-retry-title"]()}
      >
        {t["com.myoxus.workspace-import.preview-retry-description"]()}
      </SettingsNotice>
      <DialogFooterActions>
        <Button variant="secondary" onClick={onStartOver}>
          {t["com.myoxus.workspace-import.start-over"]()}
        </Button>
        <Button
          disabled={previewBusy}
          variant="primary"
          onClick={onRetryPreview}
        >
          {t["Retry"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
}
