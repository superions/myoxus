// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  adminCaBundleStatusQuery,
  adminApplyCaBundleMutation,
  adminRestoreCaBundleMutation,
  adminRemoveCaBundleMutation,
} from "@myoxus/graphql";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsNotice,
  Stack,
  UploadTarget,
} from "@myoxus/ui-facade";
import { useRef, useState } from "react";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";

type Action = "apply" | "restore" | "remove";

/** Current files are inspected independently of /ready's immutable startup snapshot. */
export function CaBundleManagement() {
  const i18n = useI18n();
  const query = useQuery({ query: adminCaBundleStatusQuery });
  const apply = useMutation({ mutation: adminApplyCaBundleMutation });
  const restore = useMutation({ mutation: adminRestoreCaBundleMutation });
  const remove = useMutation({ mutation: adminRemoveCaBundleMutation });
  const rootRef = useRef<HTMLDivElement>(null);
  const returnAfterSuccess = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const busy = apply.isMutating || restore.isMutating || remove.isMutating;
  const status = query.data?.admin.adminCaBundleStatus;
  const restricted = !status || !!status.restriction || !!query.error;
  const failureCode = (failure: unknown) => {
    const parsed = UserFriendlyError.fromAny(failure);
    return parsed.name === "ACTION_FORBIDDEN" ? parsed.name : parsed.code;
  };
  const errorMessage = (code: string) => {
    switch (code) {
      case "ACTION_FORBIDDEN":
      case "FORBIDDEN":
      case "UNAUTHORIZED":
        return i18n.t("admin.auth.no-admin-title");
      case "CA_INVALID_BUNDLE":
        return i18n.t("admin.security.tls.invalid-bundle");
      case "CA_TOO_LARGE":
        return i18n.t("admin.security.tls.too-large");
      case "CA_ENV_OVERRIDE":
        return i18n.t("admin.security.tls.env-override");
      case "CA_CONFIG_READ_ONLY":
        return i18n.t("admin.security.tls.read-only");
      case "CA_BACKUP_UNAVAILABLE":
        return i18n.t("admin.security.tls.no-backup");
      case "CA_PUBLICATION_UNCERTAIN":
        return i18n.t("admin.security.tls.uncertain");
      case "CA_CLEANUP_FAILED":
        return i18n.t("admin.security.tls.cleanup-failed");
      case "CA_CONFIG_CONFLICT":
        return i18n.t("admin.security.tls.config-conflict");
      case "CA_FILE_EXISTS":
        return i18n.t("admin.security.tls.file-exists");
      default:
        return i18n.t("admin.security.tls.write-failed");
    }
  };
  const execute = async () => {
    setError(null);
    setSucceeded(false);
    try {
      if (action === "apply" && file) await apply.trigger({ file });
      else if (action === "restore") await restore.trigger();
      else if (action === "remove") await remove.trigger();
      else return;
      setFile(null);
      setSucceeded(true);
      returnAfterSuccess.current = true;
      setAction(null);
    } catch (failure) {
      // Refresh even on failure: rename may have succeeded before directory fsync failed.
      setError(failureCode(failure));
    } finally {
      try {
        await query.mutate();
      } catch {
        // SWR retains the readback error; never present a failed refresh as success.
        setSucceeded(false);
      }
    }
  };
  const labels = {
    apply: i18n.t("admin.security.tls.apply"),
    restore: i18n.t("admin.security.tls.restore"),
    remove: i18n.t("admin.security.tls.remove"),
  };
  const confirmations = {
    apply: i18n.t("admin.security.tls.apply-confirm"),
    restore: i18n.t("admin.security.tls.restore-confirm"),
    remove: i18n.t("admin.security.tls.remove-confirm"),
  };
  return (
    <Stack
      ref={rootRef}
      tabIndex={-1}
      role="region"
      aria-label={i18n.t("admin.security.tls.title")}
      data-testid="ca-bundle-management"
    >
      {query.error ? (
        <SettingsNotice tone="error" role="alert">
          {["ACTION_FORBIDDEN", "FORBIDDEN", "UNAUTHORIZED"].includes(
            failureCode(query.error),
          )
            ? errorMessage(failureCode(query.error))
            : i18n.t("admin.security.tls.unavailable")}
        </SettingsNotice>
      ) : null}
      {query.isLoading ? (
        <SettingsNotice>{i18n.t("admin.common.loading")}</SettingsNotice>
      ) : null}
      {status ? (
        <>
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={i18n.t("admin.security.tls.configured-path")}
              mono
            >
              {status.path || i18n.t("admin.common.none")}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.security.tls.file-count")}
            >
              {status.certificateCount == null
                ? i18n.t("admin.common.none")
                : new Intl.NumberFormat(i18n.language).format(
                    status.certificateCount,
                  )}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem label={i18n.t("admin.security.tls.expiry")}>
              {status.expiresAt
                ? new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(status.expiresAt))
                : i18n.t("admin.common.none")}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.security.tls.fingerprint")}
              mono
            >
              {status.fingerprint || i18n.t("admin.common.none")}
            </SettingsDefinitionItem>
          </SettingsDefinitionList>
          {status.fileError ? (
            <SettingsNotice tone="error" role="alert">
              {errorMessage(status.fileError)}
            </SettingsNotice>
          ) : null}
          {status.restriction ? (
            <SettingsNotice tone="warning">
              {errorMessage(status.restriction)}
            </SettingsNotice>
          ) : null}
          <SettingsNotice
            tone={status.restartRequired ? "warning" : "info"}
            data-testid="ca-restart-status"
          >
            {i18n.t(
              status.restartRequired
                ? "admin.security.tls.restart-required"
                : "admin.security.tls.loaded",
            )}
          </SettingsNotice>
        </>
      ) : null}
      <UploadTarget
        title={file?.name ?? i18n.t("admin.security.tls.choose-file")}
        description={i18n.t("admin.security.tls.file-hint", {
          limit: new Intl.NumberFormat(i18n.language).format(
            (status?.maxUploadBytes ?? 0) / (1024 * 1024),
          ),
        })}
        pickLabel={i18n.t("admin.security.tls.choose-file")}
        accept=".pem,.crt,.cer"
        disabled={restricted || busy}
        onFiles={(files) => {
          setFile(files[0] ?? null);
          setError(null);
          setSucceeded(false);
        }}
      />
      {error ? (
        <SettingsNotice tone="error" role="alert">
          {errorMessage(error)}
        </SettingsNotice>
      ) : null}
      {succeeded ? (
        <SettingsNotice tone="success" role="status">
          {i18n.t("admin.security.tls.saved")}
        </SettingsNotice>
      ) : null}
      <Group>
        <Button
          disabled={restricted || busy || !file}
          onClick={() => setAction("apply")}
        >
          {labels.apply}
        </Button>
        <Button
          variant="secondary"
          disabled={restricted || busy || !status?.rollbackAvailable}
          onClick={() => setAction("restore")}
        >
          {labels.restore}
        </Button>
        <Button
          variant="error"
          disabled={restricted || busy || !status?.path}
          onClick={() => setAction("remove")}
        >
          {labels.remove}
        </Button>
      </Group>
      <AdminConfirmModal
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
        title={action ? labels[action] : ""}
        description={action ? confirmations[action] : ""}
        confirmText={action ? labels[action] : ""}
        danger={action === "remove"}
        confirmButtonOptions={{ disabled: busy }}
        cancelButtonOptions={{ disabled: busy }}
        onConfirm={execute}
        onExitTransitionEnd={() => {
          // Successful actions can disable their trigger. Return to the next upload control instead.
          if (returnAfterSuccess.current) {
            (
              rootRef.current?.querySelector<HTMLButtonElement>(
                "button:not([disabled])",
              ) ?? rootRef.current
            )?.focus();
            returnAfterSuccess.current = false;
          }
        }}
      >
        {error ? (
          <SettingsNotice tone="error" role="alert">
            {errorMessage(error)}
          </SettingsNotice>
        ) : null}
      </AdminConfirmModal>
    </Stack>
  );
}
