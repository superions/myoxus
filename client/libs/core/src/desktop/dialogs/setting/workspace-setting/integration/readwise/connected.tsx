import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { IntegrationService } from "@myoxus/core/modules/integration";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useCallback, useState } from "react";

import { Button, DialogFooterActions, Modal } from "../../../primitives";
import { readwiseTrack } from "./track";

export const ReadwiseDisconnectDialog = ({
  onClose,
}: {
  onClose: () => void;
}) => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const handleCancel = useCallback(() => onClose(), [onClose]);
  const handleKeep = useCallback(() => {
    readwise.disconnect();
    readwiseTrack.disconnectIntegration({ method: "keep" });
    onClose();
  }, [onClose, readwise]);
  const handleDelete = useAsyncCallback(async () => {
    await readwise.deleteAll();
    readwise.disconnect();
    readwiseTrack.disconnectIntegration({ method: "delete" });
    onClose();
  }, [onClose, readwise]);

  return (
    <Modal
      open={true}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.integration.readwise.disconnect.title"]()}
      description={t["com.myoxus.integration.readwise.disconnect.desc"]()}
      contentOptions={{ "data-testid": "readwise-disconnect-dialog" }}
    >
      <DialogFooterActions>
        <Button onClick={handleCancel}>{t["Cancel"]()}</Button>
        <Button variant="error" onClick={handleDelete}>
          {t["com.myoxus.integration.readwise.disconnect.delete"]()}
        </Button>
        <Button variant="primary" onClick={handleKeep}>
          {t["com.myoxus.integration.readwise.disconnect.keep"]()}
        </Button>
      </DialogFooterActions>
    </Modal>
  );
};

export const ReadwiseDisconnectButton = () => {
  const t = useI18n();
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  return (
    <>
      {showDisconnectDialog && (
        <ReadwiseDisconnectDialog
          onClose={() => setShowDisconnectDialog(false)}
        />
      )}
      <Button variant="error" onClick={() => setShowDisconnectDialog(true)}>
        {t["com.myoxus.integration.readwise.disconnect"]()}
      </Button>
    </>
  );
};
