import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  Modal,
  MyoxusText,
  SettingsNotice,
  Stack,
} from "@myoxus/ui-facade";
import type { EdgelessSnapshotPreflightResult } from "@virgultum/editor/blocks/surface";

function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

export function EdgelessPreflightDialog({
  result,
  close,
}: DialogComponentProps<
  WORKSPACE_DIALOG_SCHEMA["pdf-export-edgeless-preflight"]
>) {
  const t = useI18n();
  const title =
    result.severity === "severe"
      ? t.t("com.myoxus.pdf-export.edgeless-preflight.title.severe")
      : t.t("com.myoxus.pdf-export.edgeless-preflight.title.downscaled");
  return (
    <Modal
      open
      onOpenChange={(open) => !open && close(false)}
      title={title}
      width="md"
      scrollable
    >
      <Stack gap="lg">
        <MyoxusText component="p" tone="secondary">
          {t.t("com.myoxus.pdf-export.edgeless-preflight.description", {
            width: String(result.width),
            height: String(result.height),
            scaledWidth: String(result.scaledWidth),
            scaledHeight: String(result.scaledHeight),
            percent: percent(result.scale),
          })}
        </MyoxusText>
        {result.severity === "severe" ? (
          <SettingsNotice tone="error" role="alert">
            {t.t("com.myoxus.pdf-export.edgeless-preflight.warning.severe")}
          </SettingsNotice>
        ) : null}
        <Group justify="flex-end">
          <Button variant="secondary" onClick={() => close(false)}>
            {t.t("com.myoxus.pdf-export.dialog.button.cancel")}
          </Button>
          <Button variant="primary" onClick={() => close(true)}>
            {t.t("com.myoxus.pdf-export.edgeless-preflight.button.continue")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function openEdgelessPreflightDialog(
  dialogService: WorkspaceDialogService,
  result: EdgelessSnapshotPreflightResult,
): Promise<boolean> {
  return new Promise((resolve) => {
    dialogService.open(
      "pdf-export-edgeless-preflight",
      { result },
      (accepted) => resolve(accepted ?? false),
    );
  });
}
