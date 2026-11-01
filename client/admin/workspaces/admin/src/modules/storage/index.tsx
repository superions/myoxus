// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Storage page — tabbed layout for the canonical backend, limits, and directories.
 *
 * Tab: Workspace Storage — local paths, quotas, upload limits, and live server directories.
 * Tab: Blob Storage — the server-owned storage backend used for all binary data.
 * Tab: Orphaned Workspaces — ownerless workspace recovery and deletion.
 *
 * P-AR-3-05 collapses the historical "Orphaned Workspaces" top-level route
 * into Storage because orphan handling is an operational storage cleanup flow,
 * not a separate product domain.
 */
import { serverDirectoriesQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Button,
  Group,
  SettingsEmptyState,
  SettingsNotice,
  SettingsSkeleton,
  SettingsField,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SimpleGrid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { SizeUnitInput } from "../../components/shared/size-unit-input";
import { useQuery } from "../../use-query";
import { AdminPageFrame, AdminPageScroll, AdminSubnav } from "../admin-shell";
import { useUrlSyncedAdminTab } from "../admin-tabs";
import { useRevalidateServerConfig } from "../common";
import { ALL_CONFIG_DESCRIPTORS, type AppConfig } from "../settings/config";
import {
  ConfigNumberField,
  ConfigSelectField,
  ConfigTextField,
} from "../settings/config-form-fields";
import { ConfigPageSaveButtons } from "../settings/config-page-save-buttons";
import { buildSchemaFieldMap } from "../settings/schema-utils";
import { type AdminConfigSchemaSnapshot } from "../settings/use-admin-config-contract";
import { useAppConfig } from "../settings/use-app-config";
import { OrphanedWorkspacesContent } from "./orphaned-workspaces";

// ---------------------------------------------------------------------------
// Shared props type for config tab components
// ---------------------------------------------------------------------------

type ConfigTabProps = {
  schema: AdminConfigSchemaSnapshot | null | undefined;
  appConfig: AppConfig;
  patchedAppConfig: AppConfig;
  onUpdate: (path: string, value: any) => void;
  onSaveGroup: (module: string) => Promise<void>;
  onResetGroup: (module: string) => void;
  isGroupDirty: (module: string) => boolean;
  isGroupSaving: (module: string) => boolean;
  getGroupVersion: (module: string) => number;
  fieldErrorsByPath: Record<string, { message: string }>;
};

// ---------------------------------------------------------------------------
// Provider Tab — the server's canonical storage backend
// ---------------------------------------------------------------------------

type ProviderFieldDef = {
  key: string;
  type?: "String" | "Number" | "Enum";
  desc?: string;
  options?: string[];
  placeholder?: string;
  /** Field only applies to S3-compatible providers. */
  s3Only?: boolean;
};

const PROVIDER_FIELDS: ProviderFieldDef[] = [
  {
    key: "backend",
    desc: "admin.storage.field.blob-provider.desc",
    type: "Enum",
    options: ["local", "s3", "r2"],
  },
  {
    key: "endpoint",
    type: "String",
    desc: "admin.storage.field.blob-endpoint.desc",
    placeholder: "https://s3.amazonaws.com",
    s3Only: true,
  },
  {
    key: "region",
    type: "String",
    desc: "admin.storage.field.blob-region.desc",
    placeholder: "us-east-1",
    s3Only: true,
  },
  {
    key: "access_key",
    type: "String",
    desc: "admin.storage.field.blob-access-key-id.desc",
    s3Only: true,
  },
  {
    key: "secret_key",
    type: "String",
    desc: "admin.storage.field.blob-secret-key.desc",
    s3Only: true,
  },
  {
    key: "bucket",
    type: "String",
    desc: "admin.storage.field.blob-bucket.desc",
    s3Only: true,
  },
  {
    key: "prefix",
    type: "String",
    desc: "admin.storage.section.providers-description",
  },
];

function ProvidersTab(props: ConfigTabProps) {
  const i18n = useI18n();
  const module = "storage";
  const fieldErrorsByPath = props.fieldErrorsByPath ?? {};
  const dirty = props.isGroupDirty(module);
  const saving = props.isGroupSaving(module);
  const sourceConfig =
    props.patchedAppConfig[module] ?? props.appConfig[module];
  const schemaFieldMap = buildSchemaFieldMap(props.schema, module);
  const version = props.getGroupVersion(module);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const hasErrors = Object.keys(fieldErrors).length > 0;

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
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.storage.section.providers")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.storage.section.providers-description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Stack key={`${module}-${version}`}>
        <SimpleGrid cols={2}>
          {PROVIDER_FIELDS.filter(
            (field) => sourceConfig?.backend !== "local" || !field.s3Only,
          ).map((field) => {
            const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.key];
            if (!descriptor) return null;
            const schemaField = schemaFieldMap[field.key];
            const defaultValue =
              sourceConfig?.[field.key] ??
              (field.type === "Enum" ? field.options?.[0] : undefined);
            const fieldPath = `${module}/${field.key}`;
            if (field.type === "Enum") {
              return (
                <ConfigSelectField
                  key={fieldPath}
                  field={fieldPath}
                  desc={field.desc ?? descriptor.desc}
                  defaultValue={defaultValue}
                  onChange={props.onUpdate}
                  options={field.options ?? []}
                  databaseWritable={schemaField?.databaseWritable}
                  restartRequired={Boolean(schemaField?.restart_required)}
                  error={fieldErrorsByPath[fieldPath]?.message}
                  onErrorChange={onFieldErrorChange}
                />
              );
            }
            return (
              <ConfigTextField
                key={fieldPath}
                field={fieldPath}
                desc={field.desc ?? descriptor.desc}
                defaultValue={defaultValue}
                onChange={props.onUpdate}
                sensitive={Boolean(schemaField?.sensitive)}
                databaseWritable={schemaField?.databaseWritable}
                restartRequired={Boolean(schemaField?.restart_required)}
                placeholder={field.placeholder}
                error={fieldErrorsByPath[fieldPath]?.message}
                onErrorChange={onFieldErrorChange}
              />
            );
          })}
        </SimpleGrid>
        <ConfigPageSaveButtons
          dirty={dirty}
          hasFieldError={hasErrors}
          saving={saving}
          onReset={() => props.onResetGroup(module)}
          onSave={() => props.onSaveGroup(module)}
        />
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Limits & Quotas Tab (module: storage)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Paths & Locations Tab (module: storage)
// ---------------------------------------------------------------------------

const PATHS_FIELDS: Array<{
  key: string;
  desc: string;
}> = [
  {
    key: "root",
    desc: "admin.storage.field.storage-root.desc",
  },
];

function PathsTab(props: ConfigTabProps) {
  const i18n = useI18n();
  const module = "storage";
  const fieldErrorsByPath = props.fieldErrorsByPath ?? {};
  const dirty = props.isGroupDirty(module);
  const saving = props.isGroupSaving(module);
  const sourceConfig =
    props.patchedAppConfig[module] ?? props.appConfig[module];
  const schemaFieldMap = buildSchemaFieldMap(props.schema, module);
  const version = props.getGroupVersion(module);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const hasErrors = Object.keys(fieldErrors).length > 0;

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
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.storage.tab.paths")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.storage.section.paths-description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Stack key={`${module}-paths-${version}`}>
        <SimpleGrid cols={2}>
          {PATHS_FIELDS.map((field) => {
            const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field.key];
            if (!descriptor) return null;
            const schemaField = schemaFieldMap[field.key];
            const fieldPath = `${module}/${field.key}`;
            return (
              <ConfigTextField
                key={fieldPath}
                field={fieldPath}
                desc={field.desc}
                defaultValue={sourceConfig?.[field.key]}
                onChange={props.onUpdate}
                sensitive={Boolean(schemaField?.sensitive)}
                databaseWritable={schemaField?.databaseWritable}
                restartRequired={Boolean(schemaField?.restart_required)}
                error={fieldErrorsByPath[fieldPath]?.message}
                onErrorChange={onFieldErrorChange}
              />
            );
          })}
        </SimpleGrid>

        <ConfigPageSaveButtons
          dirty={dirty}
          hasFieldError={hasErrors}
          saving={saving}
          onReset={() => props.onResetGroup(module)}
          onSave={() => props.onSaveGroup(module)}
        />
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Limits & Quotas Tab (module: storage)
// ---------------------------------------------------------------------------

const LIMITS_FIELDS: string[] = [
  "default_workspace_quota_mb",
  "max_upload_mb",
  "signed_url_ttl_seconds",
  "min_free_space_mb",
  "multipart_threshold_mb",
];

function LimitsTab(props: ConfigTabProps) {
  const i18n = useI18n();
  const module = "storage";
  const dirty = props.isGroupDirty(module);
  const saving = props.isGroupSaving(module);
  const sourceConfig =
    props.patchedAppConfig[module] ?? props.appConfig[module];
  const schemaFieldMap = buildSchemaFieldMap(props.schema, module);
  const version = props.getGroupVersion(module);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const hasErrors = Object.keys(fieldErrors).length > 0;

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
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.storage.tab.limits")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.storage.section.limits-description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Stack key={`${module}-${version}`}>
        <SimpleGrid cols={2}>
          {LIMITS_FIELDS.map((field) => {
            const descriptor = ALL_CONFIG_DESCRIPTORS[module]?.[field];
            if (!descriptor) return null;
            const schemaField = schemaFieldMap[field];

            if (field === "default_workspace_quota_mb") {
              const mbValue =
                sourceConfig?.[field] != null
                  ? Number(sourceConfig[field])
                  : null;
              const desc = i18n.t(descriptor.desc);
              return (
                <SettingsField key={`${module}/${field}`} label={desc}>
                  <SizeUnitInput
                    ariaLabel={desc}
                    unitAriaLabel={i18n.t("admin.config.input.size-unit")}
                    value={mbValue}
                    onChange={(mb) => props.onUpdate(`${module}/${field}`, mb)}
                    allowGb={true}
                    disabled={schemaField?.databaseWritable === false}
                  />
                </SettingsField>
              );
            }

            return (
              <ConfigNumberField
                key={`${module}/${field}`}
                field={`${module}/${field}`}
                desc={descriptor.desc}
                defaultValue={sourceConfig?.[field]}
                onChange={props.onUpdate}
                suffix={descriptor.suffix}
                min={schemaField?.min ?? undefined}
                max={schemaField?.max ?? undefined}
                databaseWritable={schemaField?.databaseWritable}
                restartRequired={Boolean(schemaField?.restart_required)}
                onErrorChange={onFieldErrorChange}
              />
            );
          })}
        </SimpleGrid>

        <ConfigPageSaveButtons
          dirty={dirty}
          hasFieldError={hasErrors}
          saving={saving}
          onReset={() => props.onResetGroup(module)}
          onSave={() => props.onSaveGroup(module)}
        />
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Directories Tab — live disk usage for server-managed directories
// ---------------------------------------------------------------------------

/**
 * Format a byte count as a human-readable string with 2 decimal places.
 * Examples: 1073741824 → "1.00 GB", 1048576 → "1.00 MB", 1024 → "1.00 KB", 512 → "512 B"
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

export function DirectoriesTab() {
  const i18n = useI18n();
  const { data, error, isLoading, isValidating, mutate } = useQuery(
    { query: serverDirectoriesQuery },
    { revalidateOnFocus: false },
  );

  const directories = data?.admin?.serverDirectories ?? [];

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.storage.section.directories")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.storage.section.directories-description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {error ? (
        <SettingsNotice
          tone="error"
          title={i18n.t("com.myoxus.settings.common.load-error")}
        >
          {error.message}
          <Group>
            <Button
              disabled={isValidating}
              onClick={() => void mutate(undefined, { throwOnError: false })}
            >
              {i18n.t("admin.error.retry")}
            </Button>
          </Group>
        </SettingsNotice>
      ) : isLoading ? (
        <SettingsSkeleton />
      ) : directories.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.storage.section.directories-empty")}
        />
      ) : (
        <TableScrollContainer>
          <Table data-testid="directories-table">
            <TableHeader>
              <TableRow>
                <TableHead>{i18n.t("admin.storage.dir.name")}</TableHead>
                <TableHead>{i18n.t("admin.storage.dir.path")}</TableHead>
                <TableHead>{i18n.t("admin.storage.dir.status")}</TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.storage.dir.size")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.storage.dir.free-space")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.storage.dir.capacity")}
                </TableHead>
                <TableHead ta="right">
                  {i18n.t("admin.storage.dir.entries")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {directories.map((dir) => (
                <TableRow key={dir.name} data-testid={`dir-row-${dir.name}`}>
                  <TableCell>{dir.name}</TableCell>
                  <TableCell mono muted truncate>
                    {dir.path}
                  </TableCell>
                  <TableCell>
                    {dir.exists ? (
                      <Badge tone="success">
                        {i18n.t("admin.storage.dir.status-exists")}
                      </Badge>
                    ) : (
                      <Badge tone="error">
                        {i18n.t("admin.storage.dir.status-missing")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell tabular ta="right">
                    {formatBytes(dir.totalBytes)}
                  </TableCell>
                  <TableCell tabular ta="right">
                    {formatBytes(dir.freeBytes)}
                  </TableCell>
                  <TableCell tabular ta="right">
                    {formatBytes(dir.capacityBytes)}
                  </TableCell>
                  <TableCell tabular ta="right">
                    {dir.entryCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScrollContainer>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const TAB_IDS = ["workspace-storage", "blob-storage", "orphaned"] as const;

export function StoragePage() {
  const i18n = useI18n();
  const [activeTab, setActiveTab] = useUrlSyncedAdminTab(
    TAB_IDS,
    "workspace-storage",
  );
  const {
    schema,
    appConfig,
    update,
    saveGroup,
    resetGroup,
    patchedAppConfig,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath = {},
  } = useAppConfig();
  const revalidateServerConfig = useRevalidateServerConfig();

  const handleSaveGroup = useCallback(
    async (module: string) => {
      await saveGroup(module);
      await revalidateServerConfig();
    },
    [saveGroup, revalidateServerConfig],
  );

  const configProps: ConfigTabProps = {
    schema,
    appConfig,
    patchedAppConfig,
    onUpdate: update,
    onSaveGroup: handleSaveGroup,
    onResetGroup: resetGroup,
    isGroupDirty,
    isGroupSaving,
    getGroupVersion,
    fieldErrorsByPath,
  };

  return (
    <AdminPageFrame
      title={i18n.t("admin.storage.title")}
      routeAnchor="admin-route-storage"
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        layout="page"
        variant="default"
      >
        <AdminSubnav
          items={[
            {
              value: "workspace-storage",
              label: i18n.t("admin.storage.tab.workspace-storage"),
              testId: "storage-tab-workspace-storage",
            },
            {
              value: "blob-storage",
              label: i18n.t("admin.storage.tab.blob-storage"),
              testId: "storage-tab-blob-storage",
            },
            {
              value: "orphaned",
              label: i18n.t("admin.storage.tab.orphaned-workspaces"),
              testId: "storage-tab-orphaned",
            },
          ]}
        />
        <AdminPageScroll>
          <Stack>
            <TabsContent value="workspace-storage" layout="stack" forceMount>
              <PathsTab {...configProps} />
              <LimitsTab {...configProps} />
              <DirectoriesTab />
            </TabsContent>

            <TabsContent value="blob-storage" layout="stack" forceMount>
              <ProvidersTab {...configProps} />
            </TabsContent>

            <TabsContent value="orphaned" layout="stack" forceMount>
              <OrphanedWorkspacesContent />
            </TabsContent>
          </Stack>
        </AdminPageScroll>
      </Tabs>
    </AdminPageFrame>
  );
}
export { StoragePage as Component };
