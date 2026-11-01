/**
 * Template Registry — Settings tab.
 *
 * Controls the shared template root and template registry: enable/disable, import limits,
 * reconciliation mode, and drift scanning.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  SettingsFieldGroup,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatusDot,
} from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { ALL_CONFIG_DESCRIPTORS } from "../settings/config";
import {
  ConfigBooleanField,
  ConfigNumberField,
  ConfigSelectField,
  ConfigTextField,
} from "../settings/config-form-fields";
import { buildSchemaFieldMap } from "../settings/schema-utils";
import type { TemplateSettingsTabProps } from "./index";
import { TemplateShoulder, TemplateTabFrame } from "./template-role-primitives";

// ---------------------------------------------------------------------------
// Field Definitions
// ---------------------------------------------------------------------------

const RECONCILE_MODE_OPTIONS = [
  "seed_once",
  "managed_until_local_edit",
  "manual_update",
];

const SETTINGS_FIELDS: Array<
  | string
  | {
      key: string;
      type?: string;
      options?: string[];
      desc?: string;
      suffix?: string;
    }
> = [
  "enabled",
  {
    key: "import_max_bundle_size_mb",
    suffix: "MB",
  },
  {
    key: "reconcile_default_mode",
    type: "Enum",
    options: RECONCILE_MODE_OPTIONS,
  },
  "drift_scan_enabled",
  {
    key: "drift_scan_interval_seconds",
    suffix: "s",
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsTab({
  schema,
  appConfig,
  patchedAppConfig,
  onUpdate,
  onSaveGroup,
  onResetGroup,
  isGroupDirty,
  isGroupSaving,
  getGroupVersion,
  fieldErrorsByPath,
}: TemplateSettingsTabProps) {
  const i18n = useI18n();
  const module = "template_registry";
  const dirty = isGroupDirty(module);
  const saving = isGroupSaving(module);
  const sourceConfig = patchedAppConfig[module] ?? appConfig[module];
  const version = getGroupVersion(module);
  const schemaFieldMap = buildSchemaFieldMap(schema, module);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const hasErrors = Object.keys(fieldErrors).some((field) =>
    field.startsWith(`${module}/`),
  );
  const rootModule = "templates";
  const rootField = "templates/root_dir";
  const rootSchema = buildSchemaFieldMap(schema, rootModule).root_dir;
  const rootConfig = patchedAppConfig[rootModule] ?? appConfig[rootModule];
  const rootDirty = isGroupDirty(rootModule);
  const rootSaving = isGroupSaving(rootModule);
  const rootHasErrors = Boolean(fieldErrors[rootField]);

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

  return (
    <TemplateTabFrame
      title={i18n.t("admin.templates.settings.title")}
      description={i18n.t("admin.templates.settings.description")}
      shoulder={
        <TemplateShoulder
          rows={[
            {
              label: i18n.t("admin.templates.settings.metric.fields"),
              value: SETTINGS_FIELDS.length + 1,
              tone: "info",
            },
            {
              label: i18n.t("admin.templates.settings.metric.state"),
              value:
                dirty || rootDirty
                  ? i18n.t("admin.state.unsaved-changes")
                  : i18n.t("admin.state.saved"),
              tone: dirty || rootDirty ? "warning" : "success",
            },
          ]}
        />
      }
    >
      <Stack key={`${rootModule}-${getGroupVersion(rootModule)}`}>
        <SettingsFieldGroup>
          <ConfigTextField
            field={rootField}
            desc={ALL_CONFIG_DESCRIPTORS.templates.root_dir.desc}
            defaultValue={rootConfig?.root_dir}
            onChange={onUpdate}
            error={fieldErrorsByPath[rootField]?.message}
            onErrorChange={onFieldErrorChange}
            sensitive={Boolean(rootSchema?.sensitive)}
            databaseWritable={rootSchema?.databaseWritable}
            restartRequired={Boolean(rootSchema?.restart_required)}
          />
        </SettingsFieldGroup>
        <SettingsToolbar justify="space-between">
          <SettingsStatusText tone={rootHasErrors ? "error" : "muted"}>
            <StatusDot
              tone={rootHasErrors ? "error" : rootDirty ? "warning" : "success"}
            />
            {rootHasErrors
              ? i18n.t("admin.state.error")
              : rootDirty
                ? i18n.t("admin.state.unsaved-changes")
                : i18n.t("admin.state.saved")}
          </SettingsStatusText>
          <SettingsToolbar>
            {rootDirty ? (
              <Button
                type="button"
                variant="plain"
                onClick={() => onResetGroup(rootModule)}
                disabled={rootSaving}
              >
                {i18n.t("admin.common.cancel")}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => {
                onSaveGroup(rootModule).catch((err) => {
                  console.error(err);
                });
              }}
              disabled={!rootDirty || rootSaving || rootHasErrors}
            >
              {rootSaving
                ? i18n.t("admin.common.saving")
                : i18n.t("admin.common.save")}
            </Button>
          </SettingsToolbar>
        </SettingsToolbar>
      </Stack>
      <Stack key={`${module}-${version}`}>
        <SettingsFieldGroup>
          {SETTINGS_FIELDS.map((field) => {
            const key = typeof field === "string" ? field : field.key;
            const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[key];
            if (!descriptor) return null;
            const schemaField = schemaFieldMap[key];
            const fieldType =
              typeof field === "string"
                ? schemaField?.valueType
                : (field.type ?? schemaField?.valueType);
            const fieldPath = `${module}/${key}`;
            const commonProps = {
              field: fieldPath,
              desc:
                typeof field === "string"
                  ? descriptor.desc
                  : (field.desc ?? descriptor.desc),
              defaultValue: sourceConfig?.[key],
              onChange: onUpdate,
              error: fieldErrorsByPath[fieldPath]?.message,
              onErrorChange: onFieldErrorChange,
              sensitive: Boolean(schemaField?.sensitive),
              databaseWritable: schemaField?.databaseWritable,
              restartRequired: Boolean(schemaField?.restart_required),
            };
            if (fieldType === "Boolean") {
              return <ConfigBooleanField key={fieldPath} {...commonProps} />;
            }
            if (fieldType === "Number") {
              return (
                <ConfigNumberField
                  key={fieldPath}
                  {...commonProps}
                  suffix={typeof field === "string" ? undefined : field.suffix}
                />
              );
            }
            if (typeof field === "string") {
              return null;
            }
            return (
              <ConfigSelectField
                key={fieldPath}
                {...commonProps}
                options={field.options ?? []}
              />
            );
          })}
        </SettingsFieldGroup>

        <SettingsToolbar justify="space-between">
          <SettingsStatusText tone={hasErrors ? "error" : "muted"}>
            <StatusDot
              tone={hasErrors ? "error" : dirty ? "warning" : "success"}
            />
            {hasErrors
              ? i18n.t("admin.state.error")
              : dirty
                ? i18n.t("admin.state.unsaved-changes")
                : i18n.t("admin.state.saved")}
          </SettingsStatusText>
          <SettingsToolbar>
            {dirty ? (
              <Button
                type="button"
                variant="plain"
                onClick={() => onResetGroup(module)}
                disabled={saving}
              >
                {i18n.t("admin.common.cancel")}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => {
                onSaveGroup(module).catch((err) => {
                  console.error(err);
                });
              }}
              disabled={!dirty || saving || hasErrors}
            >
              {saving
                ? i18n.t("admin.common.saving")
                : i18n.t("admin.common.save")}
            </Button>
          </SettingsToolbar>
        </SettingsToolbar>
      </Stack>
    </TemplateTabFrame>
  );
}
