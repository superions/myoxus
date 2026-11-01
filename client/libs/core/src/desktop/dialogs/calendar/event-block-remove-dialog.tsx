// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { NativeEventScope } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Button,
  DialogFooterActions,
  Modal,
  SettingsNotice,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { IntegrationService } from "../../../modules/integration";

export const EventBlockRemoveDialog = ({
  close,
  eventId,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["event-block-remove"]>) => {
  const t = useI18n();
  const integrationService = useService(IntegrationService);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteEvent = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      await integrationService.calendar.deleteEvent(
        eventId,
        NativeEventScope.All,
      );
      close(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t["com.myoxus.integration.calendar.event-delete-error"](),
      );
    } finally {
      setDeleting(false);
    }
  }, [close, eventId, integrationService, t]);

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !deleting) close(false);
      }}
      title={t["com.myoxus.editor.event-remove.title"]()}
      description={t["com.myoxus.editor.event-remove.description"]()}
    >
      <Stack data-myoxus-ui-role="event-block-remove-dialog">
        {error ? (
          <SettingsNotice role="alert" tone="error">
            {error}
          </SettingsNotice>
        ) : null}
        <DialogFooterActions>
          <Button
            variant="plain"
            disabled={deleting}
            onClick={() => close(false)}
          >
            {t["com.myoxus.confirmModal.button.cancel"]()}
          </Button>
          <Button
            variant="secondary"
            disabled={deleting}
            onClick={() => close(true)}
          >
            {t["com.myoxus.editor.event-remove.reference"]()}
          </Button>
          <Button
            variant="destructive"
            loading={deleting}
            disabled={deleting}
            onClick={() => void deleteEvent()}
          >
            {t["com.myoxus.integration.calendar.event-delete"]()}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
};
