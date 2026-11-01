/**
 * Reusable page header components for the admin frontend.
 *
 * `RightPanelHeader` is the header bar inside right-side detail panels, with a
 * close action and an optional confirm (save) action. Main page chrome is owned
 * by `AdminPageFrame`/`AdminSubnav`; this module intentionally does not keep a
 * second top-level page header path.
 */
import { useI18n } from "@myoxus/i18n";
import { CheckIcon, XIcon } from "@myoxus/icons/react";
import { Button, SettingsDetailHeader } from "@myoxus/ui-facade";

/**
 * Header bar for the right detail panel.
 *
 * Displays the detail title and grouped secondary/primary actions. Read-only
 * panels omit `handleConfirm`; editable panels disable the save button when
 * `canSave` is `false` (no unsaved changes, or in flight).
 */
export const RightPanelHeader = ({
  title,
  handleClose,
  handleConfirm,
  canSave = false,
}: {
  title: string;
  handleClose: () => void;
  handleConfirm?: () => void;
  canSave?: boolean;
}) => {
  const i18n = useI18n();
  return (
    <SettingsDetailHeader
      title={title}
      data-testid="admin-detail-panel-header"
      actions={
        <>
          <Button
            type="button"
            aria-label={i18n.t("admin.common.close")}
            variant="secondary"
            onClick={handleClose}
            prefix={<XIcon size="var(--mantine-spacing-lg)" aria-hidden />}
          >
            {i18n.t("admin.common.close")}
          </Button>
          {handleConfirm ? (
            <Button
              type="submit"
              aria-label={i18n.t("admin.common.save")}
              variant="primary"
              onClick={handleConfirm}
              disabled={!canSave}
              prefix={
                <CheckIcon size="var(--mantine-spacing-lg)" aria-hidden />
              }
            >
              {i18n.t("admin.common.save")}
            </Button>
          ) : null}
        </>
      }
    />
  );
};
