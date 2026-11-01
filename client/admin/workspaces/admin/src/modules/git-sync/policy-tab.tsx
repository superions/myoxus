/**
 * Git Sync — Policy tab.
 *
 * Manages two groups of admin-configurable settings for the Git Sync feature:
 *
 * 1. **Sync Policy**: enabled flag, allowed directions (bidirectional, export-only,
 *    import-only), allowed auth methods, host restrictions, default branch, and
 *    auto-sync/webhook toggles.
 *
 * 2. **MIME Policy**: allowlist/blocklist for file types synced through the file
 *    pipeline, plus the validation mode (strict = reject, warn = allow with log).
 *
 * Both groups share the same save/reset/dirty-tracking mechanism provided by
 * the parent `GitSyncTabProps` interface (backed by `useAppConfig`). Changes
 * are saved as a single `gitSync` module group via `onSaveGroup('gitSync')`.
 *
 * Field definitions are either looked up from `ALL_CONFIG_DESCRIPTORS` (for
 * simple string/boolean fields) or overridden inline (for CheckboxGroup/Enum
 * fields that need custom options and labels).
 */
import {
  deleteGitSyncSshHostKeyMutation,
  disableGitSyncSshHostKeyMutation,
  getGitSyncSshHostKeysQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ROUTES } from "@myoxus/routes";
import {
  Badge,
  Button,
  InlineLink,
  notify,
  SimpleGrid,
  SettingsNotice,
  TagsInput,
  Stack,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsStatusText,
  SettingsToolbar,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { formatAdminDateTime } from "../../utils/locale-format";
import { ALL_CONFIG_DESCRIPTORS } from "../settings/config";
import {
  ConfigBooleanField,
  ConfigCheckboxGroupField,
  ConfigSelectField,
  ConfigTextField,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import { buildSchemaFieldMap } from "../settings/schema-utils";
import type { GitSyncTabProps } from "./index";

// ---------------------------------------------------------------------------
// Common MIME type suggestions
// ---------------------------------------------------------------------------

const MIME_ALLOWLIST_SUGGESTIONS = [
  "image/png",
  "image/svg+xml",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/html",
  "text/css",
  "application/javascript",
  "application/typescript",
];

const MIME_BLOCKLIST_SUGGESTIONS = [
  "application/x-executable",
  "application/x-msdownload",
  "application/x-shellscript",
  "application/octet-stream",
  "application/x-sh",
  "application/x-bat",
  "application/x-msdos-program",
];

// Loose MIME-type pattern: type/subtype, subtype may include + and -
const MIME_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-+.^_]*$/;

// ---------------------------------------------------------------------------
// StringArrayField
// ---------------------------------------------------------------------------

interface StringArrayFieldProps {
  /** Full dotted field path for onChange, e.g. "gitSync/allowed_hosts" */
  fieldPath: string;
  label: string;
  desc: string;
  value: string[];
  onChange: (path: string, newValue: string[]) => void;
  placeholder?: string;
  removeLabel: (item: string) => string;
  disabled?: boolean;
  provenance?: string;
}

function StringArrayField({
  fieldPath,
  label,
  desc,
  value,
  onChange,
  placeholder = "",
  removeLabel,
  disabled = false,
  provenance,
}: StringArrayFieldProps) {
  const i18n = useI18n();
  const chips = useMemo(() => (Array.isArray(value) ? value : []), [value]);
  return (
    <Stack data-testid={"string-chip-input-" + fieldPath}>
      <TagsInput
        label={label}
        description={desc}
        value={chips}
        data-testid={"input-" + fieldPath}
        placeholder={placeholder}
        disabled={disabled}
        removeLabel={removeLabel}
        acceptValueOnBlur={false}
        isDuplicate={(candidate, values) => values.includes(candidate)}
        onChange={(values) => onChange(fieldPath, values)}
      />
      {disabled && provenance ? (
        <SettingsStatusText>
          {i18n.t("admin.config.provenance.read-only", { source: provenance })}
        </SettingsStatusText>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// MimePolicyField
// ---------------------------------------------------------------------------

interface MimePolicyFieldProps {
  /** Full dotted field path for onChange, e.g. "gitSync/mime_allowlist_admin" */
  fieldPath: string;
  label: string;
  desc: string;
  value: string[];
  onChange: (path: string, newValue: string[]) => void;
  suggestions: string[];
  /** Items from the other list that conflict with this one */
  conflictItems?: string[];
  placeholder: string;
  invalidMessage: string;
  conflictMessage: string;
  removeLabel: (item: string) => string;
  disabled?: boolean;
  provenance?: string;
}

function MimePolicyField({
  fieldPath,
  label,
  desc,
  value,
  onChange,
  suggestions,
  conflictItems = [],
  placeholder,
  invalidMessage,
  conflictMessage,
  removeLabel,
  disabled = false,
  provenance,
}: MimePolicyFieldProps) {
  const i18n = useI18n();
  const chips = useMemo(() => (Array.isArray(value) ? value : []), [value]);
  const [inputValue, setInputValue] = useState("");
  const invalid =
    inputValue.trim() !== "" && !MIME_PATTERN.test(inputValue.trim());
  return (
    <Stack data-testid={"mime-chip-input-" + fieldPath}>
      <TagsInput
        label={label}
        description={desc}
        value={chips}
        data-testid={"input-" + fieldPath}
        placeholder={placeholder}
        disabled={disabled}
        removeLabel={removeLabel}
        acceptValueOnBlur={false}
        data={suggestions}
        searchValue={inputValue}
        onSearchChange={setInputValue}
        error={invalid ? invalidMessage : undefined}
        isDuplicate={(candidate, values) =>
          values.includes(candidate.trim().toLowerCase())
        }
        onChange={(values) =>
          onChange(
            fieldPath,
            Array.from(
              new Set(values.map((value) => value.trim().toLowerCase())),
            ),
          )
        }
      />
      {conflictItems.length > 0 ? (
        <SettingsNotice
          tone="error"
          data-testid={"conflict-warning-" + fieldPath}
        >
          {conflictMessage}
        </SettingsNotice>
      ) : null}
      {disabled && provenance ? (
        <SettingsStatusText>
          {i18n.t("admin.config.provenance.read-only", { source: provenance })}
        </SettingsStatusText>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Field Definitions
// ---------------------------------------------------------------------------

type PolicyField =
  | string
  | {
      key: string;
      type?: string;
      options?: string[];
      labelGroup?: "direction" | "auth" | "ssh" | "https";
      sub?: string;
    };

const POLICY_CAPABILITY_FIELDS: PolicyField[] = [
  "enabled",
  {
    key: "allowed_directions",
    type: "CheckboxGroup",
    options: ["bidirectional", "myoxus_to_git", "git_to_myoxus"],
    labelGroup: "direction",
  },
  {
    key: "allowed_auth_methods",
    type: "CheckboxGroup",
    options: ["https_token", "https_password", "ssh_key"],
    labelGroup: "auth",
  },
  "auto_sync_allowed",
  "webhook_allowed",
];

const POLICY_REMOTE_FIELDS: PolicyField[] = [
  {
    key: "allowed_hosts",
    type: "ChipInput",
  },
  "default_branch",
  {
    key: "ssh_host_key_policy",
    type: "Enum",
    options: ["accept_new", "strict", "insecure_no_verify"],
    labelGroup: "ssh",
  },
  {
    key: "https_certificate_policy",
    type: "Enum",
    options: ["strict", "insecure_no_verify"],
    labelGroup: "https",
  },
];

// mime_allowlist_admin and mime_blocklist_admin are rendered via MimePolicyField, not config form field.
// Only mime_validation_mode goes through the generic config form field path.
const MIME_VALIDATION_FIELD = {
  key: "mime_validation_mode",
  type: "Enum",
  options: ["strict", "warn"] as string[],
};

function SshHostKeysSection() {
  const i18n = useI18n();
  const revalidate = useMutateQueryResource();
  const { data, isLoading, error } = useQuery({
    query: getGitSyncSshHostKeysQuery,
  });
  const { trigger: disableHostKey, isMutating: disabling } = useMutation({
    mutation: disableGitSyncSshHostKeyMutation,
  });
  const { trigger: deleteHostKey, isMutating: deleting } = useMutation({
    mutation: deleteGitSyncSshHostKeyMutation,
  });
  const keys = data?.gitSyncSshHostKeys ?? [];

  async function mutateHostKey(
    action: "disable" | "delete",
    key: { host: string; port: number; keyType: string },
  ) {
    try {
      const variables = {
        host: key.host,
        port: key.port,
        keyType: key.keyType,
      };
      if (action === "disable") {
        await disableHostKey(variables);
      } else {
        await deleteHostKey(variables);
      }
      await revalidate(getGitSyncSshHostKeysQuery);
      notify.success({
        title:
          action === "disable"
            ? i18n.t("admin.git-sync.ssh-host-keys.disable-success")
            : i18n.t("admin.git-sync.ssh-host-keys.delete-success"),
      });
    } catch (err) {
      notify.error({
        title: i18n.t("admin.git-sync.ssh-host-keys.action-failed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.git-sync.ssh-host-keys.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.git-sync.ssh-host-keys.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {isLoading ? (
        <SettingsNotice tone="info">
          {i18n.t("admin.common.loading")}
        </SettingsNotice>
      ) : error ? (
        <SettingsNotice tone="error">
          {i18n.t("admin.git-sync.ssh-host-keys.load-failed")}
        </SettingsNotice>
      ) : keys.length === 0 ? (
        <SettingsNotice tone="info">
          {i18n.t("admin.git-sync.ssh-host-keys.empty")}
        </SettingsNotice>
      ) : (
        <Table aria-label={i18n.t("admin.git-sync.ssh-host-keys.table-aria")}>
          <TableHeader>
            <TableRow>
              <TableHead>
                {i18n.t("admin.git-sync.ssh-host-keys.host")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.git-sync.ssh-host-keys.fingerprint")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.git-sync.ssh-host-keys.last-seen")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.git-sync.ssh-host-keys.source")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.git-sync.ssh-host-keys.status")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.git-sync.ssh-host-keys.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={`${key.host}:${key.port}:${key.keyType}`}>
                <TableCell mono>{`${key.host}:${key.port}`}</TableCell>
                <TableCell mono truncate>
                  {key.fingerprintSha256}
                </TableCell>
                <TableCell>
                  {formatAdminDateTime(i18n.language, key.lastSeenAt)}
                </TableCell>
                <TableCell>{key.source}</TableCell>
                <TableCell>
                  <Badge tone={key.enabled ? "success" : "neutral"}>
                    {key.enabled
                      ? i18n.t("admin.git-sync.ssh-host-keys.enabled")
                      : i18n.t("admin.git-sync.ssh-host-keys.disabled")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <SettingsToolbar justify="flex-start">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!key.enabled || disabling || deleting}
                      onClick={() => mutateHostKey("disable", key)}
                    >
                      {i18n.t("admin.git-sync.ssh-host-keys.disable")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={disabling || deleting}
                      onClick={() => mutateHostKey("delete", key)}
                    >
                      {i18n.t("admin.git-sync.ssh-host-keys.delete")}
                    </Button>
                  </SettingsToolbar>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the policy settings card for Git Sync.
 *
 * Consumes `GitSyncTabProps` from the parent tab container to integrate with
 * the shared dirty-tracking and save infrastructure. Field-level validation
 * errors (e.g. invalid JSON in allowed_hosts) are tracked locally and block
 * the Save button when present.
 */
export function PolicyTab({
  appConfig,
  patchedAppConfig,
  schema,
  onUpdate,
  onSaveGroup,
  onResetGroup,
  isGroupDirty,
  isGroupSaving,
  getGroupVersion,
  fieldErrorsByPath,
  configFieldStates = {},
}: GitSyncTabProps) {
  const i18n = useI18n();
  const module = "git_sync";
  const dirty = isGroupDirty(module);
  const saving = isGroupSaving(module);
  const sourceConfig = patchedAppConfig[module] ?? appConfig[module];
  const version = getGroupVersion(module);
  const schemaFieldMap = useMemo(
    () => buildSchemaFieldMap(schema, module),
    [schema],
  );

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const allowed_hosts = Array.isArray(sourceConfig?.allowed_hosts)
    ? sourceConfig.allowed_hosts.filter(
        (host: unknown): host is string =>
          typeof host === "string" && host.trim().length > 0,
      )
    : [];
  const httpsVerificationDisabled =
    sourceConfig?.https_certificate_policy === "insecure_no_verify";
  const httpsAllowedHostsMissing =
    httpsVerificationDisabled && allowed_hosts.length === 0;
  const hasErrors =
    Object.keys(fieldErrors).length > 0 || httpsAllowedHostsMissing;
  const removeLabel = useCallback(
    (item: string) =>
      i18n.t("admin.git-sync.chip.remove", {
        item,
      }),
    [i18n],
  );
  const optionLabels = useMemo(
    () => ({
      direction: {
        bidirectional: i18n.t("admin.git-sync.policy.direction.bidirectional"),
        myoxus_to_git: i18n.t("admin.git-sync.policy.direction.myoxus_to_git"),
        git_to_myoxus: i18n.t("admin.git-sync.policy.direction.git_to_myoxus"),
      },
      auth: {
        https_token: i18n.t("admin.git-sync.policy.auth.https_token"),
        https_password: i18n.t("admin.git-sync.policy.auth.https_password"),
        ssh_key: i18n.t("admin.git-sync.policy.auth.ssh_key"),
      },
      ssh: {
        accept_new: i18n.t(
          "admin.git-sync.policy.ssh-host-key-policy.accept_new",
        ),
        strict: i18n.t("admin.git-sync.policy.ssh-host-key-policy.strict"),
        insecure_no_verify: i18n.t(
          "admin.git-sync.policy.ssh-host-key-policy.insecure_no_verify",
        ),
      },
      https: {
        strict: i18n.t("admin.git-sync.policy.https-certificate-policy.strict"),
        insecure_no_verify: i18n.t(
          "admin.git-sync.policy.https-certificate-policy.insecure_no_verify",
        ),
      },
      mimeValidation: {
        strict: i18n.t("admin.git-sync.mime-validation-mode.strict"),
        warn: i18n.t("admin.git-sync.mime-validation-mode.warn"),
      },
    }),
    [i18n],
  );
  const policyDescriptions = useMemo(
    () => ({
      enabled: i18n.t("admin.git-sync.policy.enabled.desc"),
      allowed_directions: i18n.t(
        "admin.git-sync.policy.allowed-directions.desc",
      ),
      allowed_auth_methods: i18n.t(
        "admin.git-sync.policy.allowed-auth-methods.desc",
      ),
      default_branch: i18n.t("admin.git-sync.policy.default-branch.desc"),
      auto_sync_allowed: i18n.t("admin.git-sync.policy.auto-sync-allowed.desc"),
      webhook_allowed: i18n.t("admin.git-sync.policy.webhook-allowed.desc"),
      ssh_host_key_policy: i18n.t(
        "admin.git-sync.policy.ssh-host-key-policy.desc",
      ),
      https_certificate_policy: i18n.t(
        "admin.git-sync.policy.https-certificate-policy.desc",
      ),
    }),
    [i18n],
  );

  const onFieldErrorChange = useCallback((field: string, error?: string) => {
    setFieldErrors((prev) => {
      if (error) {
        if (prev[field] === error) return prev;
        return { ...prev, [field]: error };
      }
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const renderPolicyField = (field: PolicyField) => {
    if (typeof field !== "string" && field.type === "ChipInput") {
      const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.key];
      if (!descriptor) return null;
      const fieldPath = `${module}/${field.key}`;
      const fieldState = configFieldStates[`${module}.${field.key}`];
      const rawValue = sourceConfig?.[field.key];
      const chipValue: string[] = Array.isArray(rawValue)
        ? (rawValue as string[])
        : [];
      return (
        <StringArrayField
          key={fieldPath}
          fieldPath={fieldPath}
          label={i18n.t("admin.git-sync.policy.allowed-hosts.label")}
          desc={i18n.t("admin.git-sync.policy.allowed-hosts.desc")}
          value={chipValue}
          onChange={onUpdate}
          placeholder={i18n.t(
            "admin.git-sync.policy.allowed-hosts.placeholder",
          )}
          removeLabel={removeLabel}
          disabled={!fieldState?.editable}
          provenance={fieldState?.winningSource}
        />
      );
    }

    const key = typeof field === "string" ? field : field.key;
    const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[key];
    if (!descriptor) return null;
    const schemaField = schemaFieldMap[key];
    const fieldState = configFieldStates[`${module}.${key}`];
    const fieldPath = `${module}/${key}${
      typeof field !== "string" && field.sub ? `/${field.sub}` : ""
    }`;
    const desc =
      policyDescriptions[key as keyof typeof policyDescriptions] ??
      descriptor.desc;
    const commonProps = {
      field: fieldPath,
      desc,
      defaultValue: sourceConfig?.[key],
      onChange: onUpdate,
      error: fieldErrorsByPath[fieldPath]?.message,
      onErrorChange: onFieldErrorChange,
      disabled: !fieldState?.editable,
      databaseWritable:
        fieldState?.databaseWritable ?? schemaField?.databaseWritable,
      provenance: fieldState?.winningSource,
      restartRequired: Boolean(
        fieldState?.requiresRestart || schemaField?.restart_required,
      ),
    };
    if (typeof field === "string") {
      if (schemaField?.valueType === "Boolean") {
        return <ConfigBooleanField key={fieldPath} {...commonProps} />;
      }
      return (
        <ConfigTextField
          key={fieldPath}
          {...commonProps}
          sensitive={Boolean(schemaField?.sensitive)}
        />
      );
    }
    if (field.type === "CheckboxGroup") {
      return (
        <ConfigCheckboxGroupField
          key={fieldPath}
          {...commonProps}
          options={field.options ?? []}
          labels={field.labelGroup ? optionLabels[field.labelGroup] : undefined}
        />
      );
    }
    if (field.type === "Enum") {
      return (
        <ConfigSelectField
          key={fieldPath}
          {...commonProps}
          options={field.options ?? []}
          labels={field.labelGroup ? optionLabels[field.labelGroup] : undefined}
        />
      );
    }
    return null;
  };

  return (
    <>
      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.git-sync.policy.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.git-sync.policy.description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <SimpleGrid cols={2} key={`${module}-capabilities-${version}`}>
          {POLICY_CAPABILITY_FIELDS.map(renderPolicyField)}
        </SimpleGrid>
      </Stack>

      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.git-sync.policy.remote.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.git-sync.policy.remote.description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <SimpleGrid cols={2} key={`${module}-remote-${version}`}>
          {POLICY_REMOTE_FIELDS.map(renderPolicyField)}
        </SimpleGrid>
        <InlineLink
          href={`${globalThis.environment?.subPath?.replace(/\/+$/, "") ?? ""}${ROUTES.admin.security}?tab=auth#global-tls`}
        >
          {i18n.t("admin.security.tls.title")}
        </InlineLink>
        {sourceConfig?.ssh_host_key_policy === "insecure_no_verify" ? (
          <SettingsNotice tone="warning">
            {i18n.t(
              "admin.git-sync.policy.ssh-host-key-policy.insecure-warning",
            )}
          </SettingsNotice>
        ) : (
          <SettingsNotice tone="info">
            {i18n.t(
              "admin.git-sync.policy.ssh-host-key-policy.accept-new-note",
            )}
          </SettingsNotice>
        )}

        {httpsVerificationDisabled ? (
          <SettingsNotice tone="warning">
            {httpsAllowedHostsMissing
              ? i18n.t(
                  "admin.git-sync.policy.https-certificate-policy.hosts-required",
                )
              : i18n.t(
                  "admin.git-sync.policy.https-certificate-policy.insecure-warning",
                )}
          </SettingsNotice>
        ) : (
          <SettingsNotice tone="info">
            {i18n.t(
              "admin.git-sync.policy.https-certificate-policy.strict-note",
            )}
          </SettingsNotice>
        )}
      </Stack>

      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.git-sync.mime-policy")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.git-sync.mime-policy.desc")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <SimpleGrid cols={2}>
          {/* P80-FE-01: Allowlist chip input */}
          {(() => {
            const allowlist: string[] = Array.isArray(
              sourceConfig?.mime_allowlist_admin,
            )
              ? (sourceConfig.mime_allowlist_admin as string[])
              : [];
            const blocklist: string[] = Array.isArray(
              sourceConfig?.mime_blocklist_admin,
            )
              ? (sourceConfig.mime_blocklist_admin as string[])
              : [];
            const allowBlockConflict = allowlist.filter((m) =>
              blocklist.includes(m),
            );
            const blockAllowConflict = blocklist.filter((m) =>
              allowlist.includes(m),
            );
            const allowState =
              configFieldStates[`${module}.mime_allowlist_admin`];
            const blockState =
              configFieldStates[`${module}.mime_blocklist_admin`];
            return (
              <>
                <MimePolicyField
                  fieldPath={`${module}/mime_allowlist_admin`}
                  label={i18n.t("admin.git-sync.mime-allowlist")}
                  desc={i18n.t("admin.git-sync.mime-allowlist.desc")}
                  value={allowlist}
                  onChange={onUpdate}
                  suggestions={MIME_ALLOWLIST_SUGGESTIONS}
                  conflictItems={allowBlockConflict}
                  placeholder={i18n.t("admin.git-sync.mime-input.placeholder")}
                  invalidMessage={i18n.t("admin.git-sync.mime-input.invalid")}
                  conflictMessage={i18n.t(
                    "admin.git-sync.mime-input.conflict",
                    {
                      items: allowBlockConflict.join(", "),
                    },
                  )}
                  removeLabel={removeLabel}
                  disabled={!allowState?.editable}
                  provenance={allowState?.winningSource}
                />
                {/* P80-FE-02: Blocklist chip input */}
                <MimePolicyField
                  fieldPath={`${module}/mime_blocklist_admin`}
                  label={i18n.t("admin.git-sync.mime-blocklist")}
                  desc={i18n.t("admin.git-sync.mime-blocklist.desc")}
                  value={blocklist}
                  onChange={onUpdate}
                  suggestions={MIME_BLOCKLIST_SUGGESTIONS}
                  conflictItems={blockAllowConflict}
                  placeholder={i18n.t("admin.git-sync.mime-input.placeholder")}
                  invalidMessage={i18n.t("admin.git-sync.mime-input.invalid")}
                  conflictMessage={i18n.t(
                    "admin.git-sync.mime-input.conflict",
                    {
                      items: blockAllowConflict.join(", "),
                    },
                  )}
                  removeLabel={removeLabel}
                  disabled={!blockState?.editable}
                  provenance={blockState?.winningSource}
                />
                {/* Validation mode: explicit enum selector. */}
                {(() => {
                  const descriptor =
                    ALL_CONFIG_DESCRIPTORS[module]?.["mime_validation_mode"];
                  if (!descriptor) return null;
                  const fieldState =
                    configFieldStates[`${module}.mime_validation_mode`];
                  return (
                    <ConfigSelectField
                      key={`${module}/mime_validation_mode`}
                      field={`${module}/mime_validation_mode`}
                      desc={i18n.t("admin.git-sync.mime-validation-mode.desc")}
                      options={MIME_VALIDATION_FIELD.options}
                      labels={optionLabels.mimeValidation}
                      defaultValue={sourceConfig?.["mime_validation_mode"]}
                      onChange={onUpdate}
                      error={
                        fieldErrorsByPath[`${module}/mime_validation_mode`]
                          ?.message
                      }
                      onErrorChange={onFieldErrorChange}
                      disabled={!fieldState?.editable}
                      databaseWritable={fieldState?.databaseWritable}
                      provenance={fieldState?.winningSource}
                      restartRequired={fieldState?.requiresRestart}
                    />
                  );
                })()}
              </>
            );
          })()}
        </SimpleGrid>
      </Stack>

      <SshHostKeysSection />

      <ConfigPageSaveButtons
        dirty={dirty}
        hasFieldError={hasErrors}
        saving={saving}
        onReset={() => onResetGroup(module)}
        onSave={() => {
          onSaveGroup(module).catch((err) => {
            console.error(err);
            notify.error({
              title:
                i18n.t("admin.common.save-failed") +
                ": " +
                (err instanceof Error ? err.message : String(err)),
            });
          });
        }}
      />
    </>
  );
}
