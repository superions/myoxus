import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { IntegrationService } from "@myoxus/core/modules/integration";
import { Trans, useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  Button,
  type ButtonProps,
  DialogFooterActions,
  InlineLink,
  Input,
  Modal,
  notify,
  SettingsStatusText,
  Stack,
} from "../../../primitives";
import { readwiseTrack } from "./track";

const ConnectDialog = ({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (token: string) => void;
}) => {
  const t = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "verifying" | "error">("idle");
  const [token, setToken] = useState("");
  const readwise = useService(IntegrationService).readwise;

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) handleCancel();
    },
    [handleCancel],
  );

  const handleInput = useCallback((e: FormEvent<HTMLInputElement>) => {
    setToken(e.currentTarget.value);
    setStatus("idle");
  }, []);

  const handleResult = useCallback(
    (success: boolean, token: string) => {
      readwiseTrack.connectIntegration({
        result: success ? "success" : "failed",
      });
      if (success) {
        onSuccess(token);
      } else {
        setStatus("error");
        notify.error({
          title:
            t["com.myoxus.integration.readwise.connect.error-notify-title"](),
          message:
            t["com.myoxus.integration.readwise.connect.error-notify-desc"](),
        });
      }
    },
    [onSuccess, t],
  );

  const handleConnect = useAsyncCallback(
    async (token: string) => {
      setStatus("verifying");
      try {
        const success = await readwise.crawler.verifyToken(token);
        if (!success) return handleResult(false, token);
      } catch (err) {
        console.error(err);
        return handleResult(false, token);
      }
      handleResult(true, token);
    },
    [handleResult, readwise],
  );

  useEffect(() => {
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <Modal
      open={true}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.integration.readwise.connect.title"]()}
      description={
        <Trans
          i18nKey={"com.myoxus.integration.readwise.connect.desc"}
          components={{
            a: (
              <InlineLink
                href="https://readwise.io/access_token"
                target="_blank"
                rel="noreferrer"
              />
            ),
            br: <br />,
          }}
        />
      }
      contentOptions={{ "data-testid": "readwise-connect-dialog" }}
    >
      <Stack>
        <Input
          ref={inputRef}
          value={token}
          onInput={handleInput}
          placeholder={t[
            "com.myoxus.integration.readwise.connect.placeholder"
          ]()}
          type="password"
          status={status === "error" ? "error" : "default"}
          disabled={status === "verifying"}
          autoFocus
        />
        {status === "error" ? (
          <SettingsStatusText tone="error">
            {t["com.myoxus.integration.readwise.connect.input-error"]()}
          </SettingsStatusText>
        ) : null}
        <DialogFooterActions>
          <Button disabled={status === "verifying"} onClick={handleCancel}>
            {t["Cancel"]()}
          </Button>
          <Button
            variant="primary"
            disabled={status === "verifying" || !token || status === "error"}
            loading={status === "verifying"}
            onClick={() => handleConnect(token)}
          >
            {t["com.myoxus.integration.readwise.connect"]()}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
};

export const ReadwiseConnectButton = ({
  onSuccess,
  onClick,
  ...buttonProps
}: {
  onSuccess: (token: string) => void;
} & ButtonProps) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleOpen = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      setOpen(true);
    },
    [onClick],
  );

  return (
    <>
      {open && <ConnectDialog onClose={handleClose} onSuccess={onSuccess} />}
      <Button onClick={handleOpen} {...buttonProps}>
        {t["com.myoxus.integration.readwise.connect"]()}
      </Button>
    </>
  );
};
