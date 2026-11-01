/**
 * Reusable Save/Cancel button block for config pages.
 *
 * Extracted from the repeated Save/Cancel pattern in system/index.tsx,
 * ai/index.tsx, performance/index.tsx, and queue/index.tsx.
 */
import { useI18n } from "@myoxus/i18n";
import { Button, SettingsToolbar } from "@myoxus/ui-facade";
import type { JSX } from "react";

export type ConfigPageSaveButtonsProps = {
  dirty: boolean;
  hasFieldError: boolean;
  saving: boolean;
  hasSavedOverride?: boolean;
  restoring?: boolean;
  onSave: () => void | Promise<void>;
  onReset: () => void;
  onRestoreBaseline?: () => void | Promise<void>;
};

export function ConfigPageSaveButtons({
  dirty,
  hasFieldError,
  saving,
  hasSavedOverride = false,
  restoring = false,
  onSave,
  onReset,
  onRestoreBaseline,
}: ConfigPageSaveButtonsProps): JSX.Element {
  const i18n = useI18n();

  return (
    <SettingsToolbar fullSpan data-myoxus-ui-role="config-page-save-actions">
      {hasSavedOverride && onRestoreBaseline ? (
        <Button
          type="button"
          variant="secondary"
          onClick={onRestoreBaseline}
          disabled={saving || restoring || dirty}
        >
          {restoring
            ? i18n.t("admin.common.loading")
            : i18n.t("admin.config.restore_baseline")}
        </Button>
      ) : null}
      {dirty ? (
        <Button
          type="button"
          variant="secondary"
          onClick={onReset}
          disabled={saving}
        >
          {i18n.t("admin.common.cancel")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="primary"
        onClick={onSave}
        disabled={!dirty || hasFieldError || saving}
      >
        {saving ? i18n.t("admin.common.loading") : i18n.t("admin.common.save")}
      </Button>
    </SettingsToolbar>
  );
}
