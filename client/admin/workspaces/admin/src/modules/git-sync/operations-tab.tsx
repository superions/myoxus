/**
 * Git Sync — Operations tab.
 *
 * Tune timeouts, retry behaviour, and conversion thresholds for the Git Sync engine.
 */
import { useI18n } from "@myoxus/i18n";
import {
  notify,
  SimpleGrid,
  Stack,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
} from "@myoxus/ui-facade";

import {
  ConfigNumberField,
  ConfigTextField,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import type { GitSyncTabProps } from "./index";

// ---------------------------------------------------------------------------
// Field Definitions
// ---------------------------------------------------------------------------

interface OperationField {
  key: string;
  type: "Number" | "String";
  descKey: string;
  suffix?: string;
}

interface OperationGroup {
  key: string;
  titleKey: string;
  descriptionKey: string;
  fields: OperationField[];
}

const OPERATION_GROUPS: OperationGroup[] = [
  {
    key: "runtime",
    titleKey: "admin.git-sync.operations.title",
    descriptionKey: "admin.git-sync.operations.description",
    fields: [
      {
        key: "network_timeout_secs",
        type: "Number",
        descKey: "admin.git-sync.operations.field.network-timeout.desc",
        suffix: "s",
      },
      {
        key: "local_timeout_secs",
        type: "Number",
        descKey: "admin.git-sync.operations.field.local-timeout.desc",
        suffix: "s",
      },
      {
        key: "lock_ttl_seconds",
        type: "Number",
        descKey: "admin.git-sync.operations.field.lock-ttl.desc",
        suffix: "s",
      },
    ],
  },
  {
    key: "repository",
    titleKey: "admin.git-sync.operations.repository.title",
    descriptionKey: "admin.git-sync.operations.repository.description",
    fields: [
      {
        key: "clone_depth",
        type: "Number",
        descKey: "admin.git-sync.operations.field.clone-depth.desc",
      },
      {
        key: "push_max_retries",
        type: "Number",
        descKey: "admin.git-sync.operations.field.push-max-retries.desc",
      },
      {
        key: "commit_author_name",
        type: "String",
        descKey: "admin.git-sync.operations.field.commit-author-name.desc",
      },
      {
        key: "commit_author_email",
        type: "String",
        descKey: "admin.git-sync.operations.field.commit-author-email.desc",
      },
    ],
  },
  {
    key: "conversion",
    titleKey: "admin.git-sync.operations.conversion.title",
    descriptionKey: "admin.git-sync.operations.conversion.description",
    fields: [
      {
        key: "parallel_conversion_threshold",
        type: "Number",
        descKey:
          "admin.git-sync.operations.field.parallel-conversion-threshold.desc",
      },
      {
        key: "max_docs_per_sync",
        type: "Number",
        descKey: "admin.git-sync.operations.field.max-docs-per-sync.desc",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OperationsTab({
  appConfig,
  patchedAppConfig,
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

  return (
    <>
      {OPERATION_GROUPS.map((group) => (
        <Stack key={group.key} component="section">
          <SettingsHeadingGroup>
            <SettingsSectionHeading level={3}>
              {i18n.t(group.titleKey)}
            </SettingsSectionHeading>
            <SettingsSectionDescription>
              {i18n.t(group.descriptionKey)}
            </SettingsSectionDescription>
          </SettingsHeadingGroup>
          <SimpleGrid cols={2} key={`${module}-${group.key}-${version}`}>
            {group.fields.map((field) => {
              const fieldPath = `${module}/${field.key}`;
              const fieldState = configFieldStates[`${module}.${field.key}`];
              const commonProps = {
                field: fieldPath,
                desc: i18n.t(field.descKey),
                defaultValue: sourceConfig?.[field.key],
                onChange: onUpdate,
                suffix: field.suffix,
                error: fieldErrorsByPath[fieldPath]?.message,
                disabled: !fieldState?.editable,
                databaseWritable: fieldState?.databaseWritable,
                provenance: fieldState?.winningSource,
                restartRequired: fieldState?.requiresRestart,
              };
              if (field.type === "Number") {
                return <ConfigNumberField key={fieldPath} {...commonProps} />;
              }
              return <ConfigTextField key={fieldPath} {...commonProps} />;
            })}
          </SimpleGrid>
        </Stack>
      ))}
      <ConfigPageSaveButtons
        dirty={dirty}
        hasFieldError={false}
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
