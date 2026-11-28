// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

function ConnectDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (token: string) => void;
}) {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "verifying" | "error">("idle");
  const [token, setToken] = useState("");

  useEffect(() => {
    const refocus = () => inputRef.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, []);

  const reportOutcome = useCallback(
    (success: boolean, candidate: string) => {
      readwiseTrack.connectIntegration({
        result: success ? "success" : "failed",
      });
      if (success) {
        onSuccess(candidate);
        return;
      }
      setStatus("error");
      notify.error({
        title:
          t["com.myoxus.integration.readwise.connect.error-notify-title"](),
        message:
          t["com.myoxus.integration.readwise.connect.error-notify-desc"](),
      });
    },
    [onSuccess, t],
  );

  const handleConnect = useAsyncCallback(
    async (candidate: string) => {
      setStatus("verifying");
      try {
        const valid = await readwise.crawler.verifyToken(candidate);
        reportOutcome(Boolean(valid), candidate);
      } catch (error) {
        console.error(error);
        reportOutcome(false, candidate);
      }
    },
    [readwise, reportOutcome],
  );

  const handleInput = useCallback((event: FormEvent<HTMLInputElement>) => {
    setToken(event.currentTarget.value);
    setStatus("idle");
  }, []);

  const verifying = status === "verifying";

  return (
    <Modal
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={t["com.myoxus.integration.readwise.connect.title"]()}
      description={
        <Trans
          i18nKey="com.myoxus.integration.readwise.connect.desc"
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
          disabled={verifying}
          autoFocus
        />
        {status === "error" ? (
          <SettingsStatusText tone="error">
            {t["com.myoxus.integration.readwise.connect.input-error"]()}
          </SettingsStatusText>
        ) : null}
        <DialogFooterActions>
          <Button disabled={verifying} onClick={onClose}>
            {t["Cancel"]()}
          </Button>
          <Button
            variant="primary"
            disabled={verifying || !token || status === "error"}
            loading={verifying}
            onClick={() => handleConnect(token)}
          >
            {t["com.myoxus.integration.readwise.connect"]()}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}

export const ReadwiseConnectButton = ({
  onSuccess,
  onClick,
  ...buttonProps
}: {
  onSuccess: (token: string) => void;
} & ButtonProps) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      setOpen(true);
    },
    [onClick],
  );

  return (
    <>
      {open ? (
        <ConnectDialog onClose={() => setOpen(false)} onSuccess={onSuccess} />
      ) : null}
      <Button onClick={handleOpen} {...buttonProps}>
        {t["com.myoxus.integration.readwise.connect"]()}
      </Button>
    </>
  );
};
