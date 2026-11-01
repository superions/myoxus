/**
 * Git Sync — Storage tab.
 *
 * Configure storage limits for git mirror repositories and monitor current usage.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  ErrorMessage,
  Group,
  notify,
  SimpleGrid,
  SettingsField,
  SettingsListItemMeta,
  SettingsProgress,
  Stack,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsStatusText,
  SettingsToolbar,
} from "@myoxus/ui-facade";

import { SizeUnitInput } from "../../components/shared/size-unit-input";
import { ConfigTextField } from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import type { GitSyncTabProps } from "./index";

// ---------------------------------------------------------------------------
// Field Definitions
// ---------------------------------------------------------------------------

interface StorageField {
  key: string;
  type: "Number" | "String";
  descKey: string;
  suffix?: string;
  /** When true, render a SizeUnitInput with MB/GB toggle instead of plain config form field */
  useSizeUnit?: boolean;
  allowGb?: boolean;
}

const STORAGE_FIELDS: StorageField[] = [
  {
    key: "repo_base_dir",
    type: "String",
    descKey: "admin.git-sync.storage.field.repo-base-dir.desc",
  },
  {
    key: "max_mirror_storage_mb",
    type: "Number",
    descKey: "admin.git-sync.storage.field.max-mirror-storage.desc",
    useSizeUnit: true,
    allowGb: true,
  },
  {
    key: "min_free_disk_mb",
    type: "Number",
    descKey: "admin.git-sync.storage.field.min-free-disk.desc",
    useSizeUnit: true,
    allowGb: false,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StorageTab({
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

  // Derive storage usage from the server-owned structured config snapshot.
  const maxStorageMb = (sourceConfig?.max_mirror_storage_mb as number) ?? 0;

  // Storage usage uses the canonical typed config module.
  const gitSyncConfig = patchedAppConfig.git_sync ?? appConfig.git_sync;
  const storageUsage = gitSyncConfig?.storageUsage as
    | {
        usedMb?: number;
        freeDiskMb?: number;
        repoCount?: number;
      }
    | undefined;

  const usedMb = storageUsage?.usedMb ?? 0;
  const freeDiskMb = storageUsage?.freeDiskMb ?? 0;
  const repoCount = storageUsage?.repoCount ?? 0;
  const usagePercent =
    maxStorageMb > 0 ? Math.round((usedMb / maxStorageMb) * 100) : 0;
  const isWarning = usagePercent > 80;

  return (
    <>
      <Stack component="section">
        <Group justify="space-between" align="flex-start">
          <SettingsHeadingGroup>
            <SettingsSectionHeading level={3}>
              {i18n.t("admin.git-sync.storage.usage.title")}
            </SettingsSectionHeading>
          </SettingsHeadingGroup>
          {isWarning ? (
            <Badge tone="error">
              {i18n.t("admin.git-sync.storage.usage.high")}
            </Badge>
          ) : undefined}
        </Group>
        <SettingsProgress value={usagePercent} />
        <SettingsToolbar justify="space-between">
          <SettingsListItemMeta>
            {i18n.t("admin.git-sync.storage.usage.used", {
              usedMb,
              maxStorageMb,
              usagePercent,
            })}
          </SettingsListItemMeta>
          <SettingsListItemMeta>
            {i18n.t("admin.git-sync.storage.usage.free", { freeDiskMb })}
          </SettingsListItemMeta>
        </SettingsToolbar>
        <SettingsListItemMeta>
          {i18n.t("admin.git-sync.storage.usage.repo-count", {
            repoCount,
          })}
        </SettingsListItemMeta>
      </Stack>

      <Stack component="section">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.git-sync.storage.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.git-sync.storage.description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <SimpleGrid cols={2} key={`${module}-storage-${version}`}>
          {STORAGE_FIELDS.map((field) => {
            const currentValue = sourceConfig?.[field.key];
            const fieldPath = `${module}/${field.key}`;
            const fieldState = configFieldStates[`${module}.${field.key}`];
            const fieldError = fieldErrorsByPath[fieldPath]?.message;
            if (field.useSizeUnit) {
              const mbValue =
                currentValue !== undefined && currentValue !== null
                  ? Number(currentValue)
                  : null;
              const desc = i18n.t(field.descKey);
              return (
                <SettingsField
                  key={fieldPath}
                  label={desc}
                  disabled={!fieldState?.editable}
                  data-testid={`field-${fieldPath}`}
                >
                  <SizeUnitInput
                    ariaLabel={desc}
                    unitAriaLabel={i18n.t("admin.config.input.size-unit")}
                    value={mbValue}
                    onChange={(mb) => onUpdate(`${module}/${field.key}`, mb)}
                    allowGb={field.allowGb}
                    disabled={!fieldState?.editable}
                  />
                  {fieldState?.winningSource &&
                  !fieldState.editable &&
                  fieldState.databaseWritable ? (
                    <SettingsStatusText>
                      {i18n.t("admin.config.provenance.read-only", {
                        source: fieldState.winningSource,
                      })}
                    </SettingsStatusText>
                  ) : null}
                  {fieldError ? (
                    <ErrorMessage>{fieldError}</ErrorMessage>
                  ) : null}
                </SettingsField>
              );
            }
            return (
              <ConfigTextField
                key={`${module}/${field.key}`}
                field={`${module}/${field.key}`}
                desc={i18n.t(field.descKey)}
                defaultValue={currentValue}
                onChange={onUpdate}
                error={fieldError}
                disabled={!fieldState?.editable}
                databaseWritable={fieldState?.databaseWritable}
                provenance={fieldState?.winningSource}
                restartRequired={fieldState?.requiresRestart}
              />
            );
          })}
        </SimpleGrid>
      </Stack>
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
