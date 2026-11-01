// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { UserFriendlyError } from "@myoxus/error";
import {
  adminCheckTranscriptionConnectionMutation,
  adminTranscriptionStatusQuery,
} from "@myoxus/graphql";
import { useMutation } from "@myoxus/admin/use-mutation";
import { gqlFetcher, useQuery } from "@myoxus/admin/use-query";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Checkbox,
  Button,
  FormFieldset,
  SettingsHeadingGroup,
  SettingsNotice,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  Stack,
  notify,
} from "@myoxus/ui-facade";
import { useEffect, useRef, useState } from "react";

import {
  ConfigBooleanField,
  ConfigNumberField,
  ConfigTextField,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import { buildSchemaFieldMap } from "../settings/schema-utils";
import type { useAppConfig } from "../settings/use-app-config";
import { useFieldErrors } from "../settings/use-field-errors";

const LIMIT_FIELDS = [
  {
    key: "request_timeout_ms",
    label: "admin.transcription.request-timeout",
    suffix: "ms",
  },
  {
    key: "max_input_bytes",
    label: "admin.transcription.max-input",
    suffix: "B",
  },
  {
    key: "max_response_bytes",
    label: "admin.transcription.max-response",
    suffix: "B",
  },
  {
    key: "max_duration_seconds",
    label: "admin.transcription.max-duration",
    suffix: "s",
  },
  { key: "max_concurrency", label: "admin.transcription.max-concurrency" },
] as const;

export function TranscriptionTab({
  config,
}: {
  config: ReturnType<typeof useAppConfig>;
}) {
  const i18n = useI18n();
  const { hasFieldError, onFieldErrorChange } = useFieldErrors();
  const secretInput = useRef<HTMLInputElement>(null);
  const [secretChanged, setSecretChanged] = useState(false);
  const [removeSecret, setRemoveSecret] = useState(false);
  const [limitsExpanded, setLimitsExpanded] = useState<
    string | string[] | null
  >(null);
  const fields = buildSchemaFieldMap(config.schema, "transcription");
  const saved = config.appConfig.transcription;
  const values = config.patchedAppConfig.transcription;
  const saving = config.isGroupSaving("transcription");
  const dirty =
    config.isGroupDirty("transcription") || secretChanged || removeSecret;
  const [statusReady, setStatusReady] = useState(false);
  const [statusError, setStatusError] = useState<unknown>();
  const [statusRefresh, setStatusRefresh] = useState(0);
  const statusQuery = useQuery(
    config.isLoading ? undefined : { query: adminTranscriptionStatusQuery },
    {
      revalidateOnMount: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: 0,
    },
  );
  const connectionCheck = useMutation({
    mutation: adminCheckTranscriptionConnectionMutation,
  });
  const mutateStatus = statusQuery.mutate;
  useEffect(() => {
    if (config.isLoading) return;
    const controller = new AbortController();
    setStatusReady(false);
    setStatusError(undefined);
    // An owned signal prevents transport deduplication with a retired mount;
    // SWR mutation timestamps prevent its late response replacing this read.
    // Status reads never probe the provider themselves.
    void mutateStatus(
      gqlFetcher({
        query: adminTranscriptionStatusQuery,
        signal: controller.signal,
      }),
      { revalidate: false },
    ).then(
      () => {
        if (!controller.signal.aborted) setStatusReady(true);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setStatusError(error);
          setStatusReady(true);
        }
      },
    );
    return () => controller.abort();
  }, [config.isLoading, mutateStatus, statusRefresh]);
  const statusLoading = !statusReady || connectionCheck.isMutating;
  const status = statusLoading
    ? undefined
    : statusQuery.data?.admin.transcriptionStatus;
  const outcome = status?.lastConnectionCheck;
  const refreshStatus = () => {
    setStatusReady(false);
    setStatusRefresh((version) => version + 1);
  };
  const checkConnection = async () => {
    try {
      // No draft, endpoint or key is supplied: the server owns the saved input.
      await connectionCheck.trigger();
      refreshStatus();
    } catch (error) {
      const message = UserFriendlyError.fromAny(error).message;
      console.error(message);
      notify.error({
        title: i18n.t("admin.transcription.check-failed"),
        message,
      });
    }
  };
  const limitErrors = LIMIT_FIELDS.some(
    ({ key }) => config.fieldErrorsByPath[`transcription/${key}`],
  );
  useEffect(() => {
    if (limitErrors) setLimitsExpanded("limits");
  }, [limitErrors]);

  const fieldProps = (key: string) => {
    const state = config.configFieldStates?.[`transcription.${key}`];
    return {
      field: `transcription/${key}`,
      defaultValue: values?.[key],
      databaseWritable: fields[key]?.databaseWritable,
      disabled: saving || !fields[key] || state?.editable === false,
      provenance: state?.winningSource,
      restartRequired: Boolean(fields[key]?.restart_required),
      error: config.fieldErrorsByPath[`transcription/${key}`]?.message,
      onErrorChange: onFieldErrorChange,
      onChange: config.update,
    };
  };
  const secretProps = fieldProps("api_key");
  const secretWritable =
    fields.api_key?.databaseWritable !== false && !secretProps.disabled;
  const clearSecretError = () =>
    config.update("transcription/api_key", saved?.api_key);
  const save = () => {
    // The uncontrolled protected input is the only owner of an entered key.
    // Group-version remount clears it only after a successful save or Discard.
    const protectedValues: Record<string, string | null> = removeSecret
      ? { api_key: null }
      : secretChanged
        ? { api_key: secretInput.current?.value ?? "" }
        : {};
    return config.saveGroup("transcription", protectedValues);
  };

  if (config.isLoading) {
    return (
      <SettingsStatusText role="status">
        {i18n.t("admin.common.loading")}
      </SettingsStatusText>
    );
  }
  if (
    config.schemaError ||
    config.valuesError ||
    !values ||
    config.normalizationIssues?.some((issue) =>
      issue.path.startsWith("transcription."),
    ) ||
    [
      "enabled",
      "endpoint",
      "model",
      "api_key",
      "language",
      ...LIMIT_FIELDS.map((field) => field.key),
    ].some((key) => !fields[key])
  ) {
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("admin.config.error.load-failed")}
      >
        <Stack>
          <SettingsStatusText>
            {i18n.t("admin.config.error.load-failed-desc")}
          </SettingsStatusText>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              config.reloadServerState().catch((error) =>
                notify.error({
                  title: i18n.t("admin.config.error.load-failed"),
                  message: UserFriendlyError.fromAny(error).message,
                }),
              );
            }}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Stack>
      </SettingsNotice>
    );
  }

  return (
    <FormFieldset variant="unstyled" disabled={saving}>
      <Stack>
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.transcription.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.transcription.description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <Stack aria-live="polite">
          {statusLoading ? (
            <SettingsStatusText role="status">
              {i18n.t("admin.common.loading")}
            </SettingsStatusText>
          ) : statusError || !status ? (
            <SettingsNotice
              tone="error"
              title={i18n.t("admin.config.error.load-failed")}
            >
              <Button type="button" variant="secondary" onClick={refreshStatus}>
                {i18n.t("admin.error.retry")}
              </Button>
            </SettingsNotice>
          ) : (
            <>
              <SettingsStatusText>
                {i18n.t("admin.transcription.activation")}:{" "}
                {i18n.t(
                  status.capability.enabled
                    ? "admin.ai.global.enabled"
                    : "admin.common.disabled",
                )}
              </SettingsStatusText>
              <SettingsStatusText>
                {i18n.t("admin.transcription.configuration")}:{" "}
                {i18n.t(
                  status.capability.configured
                    ? "admin.ai.provider.configured"
                    : "admin.ai.provider.not-configured",
                )}
              </SettingsStatusText>
              {outcome?.error ? (
                <SettingsNotice
                  tone="error"
                  title={i18n.t("admin.transcription.last-check")}
                >
                  {outcome.error}
                </SettingsNotice>
              ) : (
                <SettingsStatusText>
                  {i18n.t("admin.transcription.last-check")}:{" "}
                  {i18n.t(
                    !outcome
                      ? "admin.transcription.not-checked"
                      : outcome.catalogSupported === false
                        ? "admin.transcription.catalog-unsupported"
                        : outcome.modelListed === true
                          ? "admin.transcription.model-listed"
                          : outcome.modelListed === false
                            ? "admin.transcription.model-not-listed"
                            : "admin.transcription.model-not-verified",
                  )}
                </SettingsStatusText>
              )}
              <SettingsSectionDescription>
                {i18n.t("admin.transcription.recognition-not-verified")}
              </SettingsSectionDescription>
            </>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={
              saving || dirty || statusLoading || !status?.capability.configured
            }
            loading={connectionCheck.isMutating}
            onClick={checkConnection}
          >
            {i18n.t("admin.transcription.check-connection")}
          </Button>
          {dirty ? (
            <SettingsStatusText>
              {i18n.t("admin.transcription.save-before-check")}
            </SettingsStatusText>
          ) : null}
        </Stack>
        <ConfigBooleanField
          {...fieldProps("enabled")}
          label="admin.ai.provider.field.enabled"
        />
        <ConfigTextField
          {...fieldProps("endpoint")}
          label="admin.transcription.endpoint"
          desc="admin.transcription.endpoint-description"
        />
        <ConfigTextField
          {...fieldProps("model")}
          label="admin.transcription.model"
          desc="admin.transcription.model-description"
        />
        <ConfigTextField
          {...secretProps}
          defaultValue={saved?.api_key}
          label="admin.ai.provider.field.apiKey"
          desc="admin.transcription.api-key-description"
          sensitive
          protectedInputRef={secretInput}
          onChange={(_, value) => {
            setSecretChanged(String(value).length > 0);
            setRemoveSecret(false);
            clearSecretError();
          }}
        />
        {saved?.api_key != null ? (
          <Checkbox
            label={i18n.t("admin.transcription.remove-key-override")}
            checked={removeSecret}
            disabled={!secretWritable}
            onChange={(_, checked) => {
              if (secretInput.current) secretInput.current.value = "";
              setSecretChanged(false);
              setRemoveSecret(checked);
              clearSecretError();
            }}
          />
        ) : null}
        <ConfigTextField
          {...fieldProps("language")}
          label="admin.transcription.language"
          desc="admin.transcription.language-description"
          onChange={(field, value) =>
            config.update(field, value === "" ? null : value)
          }
        />
        <Accordion
          value={limitsExpanded}
          onChange={setLimitsExpanded}
          keepMounted
        >
          <AccordionItem value="limits">
            <AccordionControl>
              {i18n.t("admin.transcription.technical-limits")}
            </AccordionControl>
            <AccordionPanel>
              <Stack>
                {LIMIT_FIELDS.map(({ key, label, ...units }) => (
                  <ConfigNumberField
                    key={key}
                    {...fieldProps(key)}
                    label={label}
                    {...units}
                    min={fields[key]?.min ?? undefined}
                    max={fields[key]?.max ?? undefined}
                  />
                ))}
              </Stack>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
        <ConfigPageSaveButtons
          dirty={dirty}
          hasFieldError={hasFieldError(["transcription"])}
          saving={saving}
          onSave={save}
          onReset={() => config.resetGroup("transcription")}
        />
      </Stack>
    </FormFieldset>
  );
}
