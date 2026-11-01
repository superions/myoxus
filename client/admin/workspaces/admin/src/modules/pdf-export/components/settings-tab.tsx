/**
 * @file PDF export module — settings tab.
 *
 * Workspace defaults and global PDF export limits stay inside the PDF export
 * module. Font-family choices intentionally do not live here: PDF rendering
 * consumes the effective workspace/global theme typography contract.
 */
import { adminWorkspacesQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  DialogFooterActions,
  ErrorMessage,
  Input,
  NumberInput,
  notify,
  ResponsiveGrid,
  FormSelect,
  SettingsField,
  SettingsNotice,
  SettingsToolbar,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useMemo, useState } from "react";

import { useQuery } from "../../../use-query";
import { useAppConfig } from "../../settings/use-app-config";
import {
  type DocumentVersioningWorkspaceSettings,
  useDocumentVersioningAdminSettingsQuery,
  usePdfExportSettingsQuery,
  usePdfIccProfilesQuery,
  usePdfTemplatesQuery,
  usePdfWorkspaceAssignmentsQuery,
  useSetWorkspaceDefaultPdfTemplateMutation,
  useUpdateDocumentVersioningWorkspaceSettingsMutation,
  useUpdatePdfExportSettingsMutation,
} from "../api";
import { buildColorProfileOptions } from "../color-profile-options";
import { adaptPdfTemplate, type PdfTemplateRaw } from "../format-adapters";
import { logPdfExportUiEvent } from "../logging";
import {
  EmptyState as RoleEmptyState,
  FieldLabel,
  PdfPanelHeader,
} from "../pdf-role-primitives";
import { pdfTemplateDisplayName } from "../template-localization";

// ---------------------------------------------------------------------------
// Options + helpers
// ---------------------------------------------------------------------------

const PAPER_SIZES = ["A4", "Letter", "A3", "A5"] as const;
const IMAGE_QUALITY = ["low", "med", "high", "lossless"] as const;
const DOCUMENT_VERSIONING_MODULE = "document_versioning";

const GLOBAL_NUMBER_FIELDS = [
  {
    path: "limits.max_concurrent_per_workspace",
    key: "max-concurrent-per-workspace",
    min: 1,
    max: 100,
  },
  { path: "limits.max_input_blocks", key: "max-input-blocks", min: 1 },
  { path: "limits.max_pages", key: "max-pages", min: 1 },
  {
    path: "limits.render_timeout_seconds",
    key: "render-timeout-seconds",
    min: 1,
  },
  { path: "limits.max_memory_mb", key: "max-memory-mb", min: 64 },
  { path: "sync_threshold_blocks", key: "sync-threshold-blocks", min: 0 },
  { path: "max_template_size_mb", key: "max-template-size-mb", min: 1 },
  { path: "max_brand_asset_size_mb", key: "max-brand-asset-size-mb", min: 1 },
  { path: "max_font_size_mb", key: "max-font-size-mb", min: 1 },
  { path: "max_dpi", key: "max-dpi", min: 72, max: 2400 },
  {
    path: "heading_font_scale",
    key: "heading-font-scale",
    min: 0.5,
    max: 1.5,
    fallback: 0.95,
    step: 0.05,
  },
  {
    path: "body_font_scale",
    key: "body-font-scale",
    min: 0.5,
    max: 1.5,
    fallback: 1.05,
    step: 0.05,
  },
  {
    path: "verapdf_timeout_seconds",
    key: "verapdf-timeout-seconds",
    min: 1,
    max: 300,
  },
  {
    path: "edgeless_snapshot.max_dim_px",
    key: "edgeless-snapshot-max-dim-px",
    min: 512,
  },
  {
    path: "edgeless_snapshot.max_total_px",
    key: "edgeless-snapshot-max-total-px",
    min: 262144,
  },
  {
    path: "edgeless_snapshot.max_size_mb",
    key: "edgeless-snapshot-max-size-mb",
    min: 1,
  },
] as const;

const GLOBAL_TEXT_FIELDS = [
  {
    path: "verapdf_validator_url",
    key: "verapdf-validator-url",
    placeholder: "http://verapdf:8080",
    maxLength: 2048,
    optional: true,
  },
] as const;

const GLOBAL_ENUM_FIELDS = [
  {
    path: "default_paper_size",
    key: "default-paper-size",
    fallback: "A4",
    values: PAPER_SIZES,
  },
  {
    path: "default_color_profile",
    key: "default-color-profile",
    fallback: "sRGB",
    values: ["sRGB", "CMYK_FOGRA39", "CMYK_SWOP"] as const,
  },
  {
    path: "default_image_quality",
    key: "default-image-quality",
    fallback: "high",
    values: IMAGE_QUALITY,
  },
] as const;

interface WorkspaceOption {
  id: string;
  name: string;
}

function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[part];
  }, source);
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionValue(
  value: string | null | undefined,
  fallback: string,
): string {
  return value && value.trim() ? value : fallback;
}

type TriState = "inherit" | "on" | "off";

function triStateFromNullable(value: boolean | null | undefined): TriState {
  if (value === true) return "on";
  if (value === false) return "off";
  return "inherit";
}

function nullableFromTriState(value: TriState): boolean | null {
  if (value === "on") return true;
  if (value === "off") return false;
  return null;
}

function triStateOptions(i18n: ReturnType<typeof useI18n>) {
  return [
    {
      value: "inherit",
      label: i18n.t("admin.pdf-settings.doc-versioning.inherit"),
    },
    { value: "on", label: i18n.t("admin.pdf-settings.doc-versioning.on") },
    { value: "off", label: i18n.t("admin.pdf-settings.doc-versioning.off") },
  ];
}

function useWorkspaceOptions(): WorkspaceOption[] {
  const { data } = useQuery({
    query: adminWorkspacesQuery,
    variables: { filter: { first: 100, skip: 0 } },
  });
  const list =
    (data?.admin?.adminWorkspaces as
      Array<{ id: string; name: string | null }> | undefined) ?? [];
  return list.map((w) => ({ id: w.id, name: w.name ?? w.id }));
}

// ---------------------------------------------------------------------------
// Workspace defaults
// ---------------------------------------------------------------------------

function WorkspaceDefaultsForm({ workspaceId }: { workspaceId: string }) {
  const query = usePdfExportSettingsQuery(workspaceId);
  const assignmentsQuery = usePdfWorkspaceAssignmentsQuery(workspaceId);
  const error = query.error ?? assignmentsQuery.error;
  // Mount the draft only after its persisted defaults arrive. Revalidation must
  // not replace edits the operator has already made in the mounted form.
  if (!query.settings || assignmentsQuery.isLoading) {
    return error ? (
      <ErrorMessage>{error.message}</ErrorMessage>
    ) : (
      <Skeleton h={256} />
    );
  }
  return (
    <>
      {error ? <ErrorMessage>{error.message}</ErrorMessage> : null}
      <WorkspaceDefaultsEditor
        workspaceId={workspaceId}
        query={query}
        assignmentsQuery={assignmentsQuery}
      />
    </>
  );
}

function WorkspaceDefaultsEditor({
  workspaceId,
  query,
  assignmentsQuery,
}: {
  workspaceId: string;
  query: ReturnType<typeof usePdfExportSettingsQuery>;
  assignmentsQuery: ReturnType<typeof usePdfWorkspaceAssignmentsQuery>;
}) {
  const i18n = useI18n();
  const templatesQuery = usePdfTemplatesQuery(false);
  const iccProfilesQuery = usePdfIccProfilesQuery();
  const updateSettings = useUpdatePdfExportSettingsMutation();
  const setDefaultTemplate = useSetWorkspaceDefaultPdfTemplateMutation();
  const settings = query.settings;
  const [paperSize, setPaperSize] = useState(() =>
    optionValue(settings?.defaultPaperSize, "A4"),
  );
  const [locale, setLocale] = useState(() => settings?.defaultLocale ?? "en");
  const [colorProfile, setColorProfile] = useState(() =>
    optionValue(settings?.defaultColorProfile, "sRGB"),
  );
  const [imageQuality, setImageQuality] = useState(() =>
    optionValue(settings?.defaultImageQuality, "high"),
  );
  const assignedTemplates = assignmentsQuery.assignments ?? [];
  const templateNameById = useMemo(() => {
    return new Map(
      ((templatesQuery.templates ?? []) as PdfTemplateRaw[]).map((template) => {
        const viewModel = adaptPdfTemplate(template);
        return [
          viewModel.id,
          `${pdfTemplateDisplayName(viewModel, i18n.t)} (${viewModel.version})`,
        ];
      }),
    );
  }, [i18n.t, templatesQuery.templates]);
  const currentDefaultTemplateId =
    assignedTemplates.find((assignment) => assignment.isDefault)?.templateId ??
    settings?.defaultTemplateId ??
    "";
  const [defaultTemplateId, setDefaultTemplateId] = useState(
    () => currentDefaultTemplateId,
  );
  const [ligaturesEnabled, setLigaturesEnabled] = useState(
    () => settings?.ligaturesEnabled ?? true,
  );
  const [saving, setSaving] = useState(false);
  const colorProfileOptions = useMemo(
    () =>
      buildColorProfileOptions(
        iccProfilesQuery.profiles ?? [],
        settings?.defaultColorProfile ?? "sRGB",
      ),
    [settings?.defaultColorProfile, iccProfilesQuery.profiles],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateSettings.updatePdfExportSettings({
        workspaceId,
        paperSize,
        locale: locale.trim() || "en",
        colorProfile,
        imageQuality,
        ligaturesEnabled,
      });
      if (defaultTemplateId && defaultTemplateId !== currentDefaultTemplateId) {
        await setDefaultTemplate.setWorkspaceDefaultPdfTemplate({
          workspaceId,
          templateId: defaultTemplateId,
        });
      }
      logPdfExportUiEvent("settings.workspace-defaults.saved", {
        workspaceId,
        paperSize,
        locale,
        colorProfile,
        imageQuality,
        ligaturesEnabled,
        defaultTemplateId: defaultTemplateId || null,
      });
      notify.success({
        title: i18n.t("admin.pdf-settings.workspace.save-success"),
      });
      void query.mutate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPdfExportUiEvent(
        "settings.workspace-defaults.failed",
        { workspaceId, message: msg },
        "error",
      );
      notify.error({
        title: `${i18n.t("admin.pdf-settings.workspace.save-failed")}: ${msg}`,
      });
    } finally {
      setSaving(false);
    }
  }, [
    colorProfile,
    currentDefaultTemplateId,
    defaultTemplateId,
    imageQuality,
    i18n,
    ligaturesEnabled,
    locale,
    paperSize,
    query,
    setDefaultTemplate,
    updateSettings,
    workspaceId,
  ]);

  return (
    <Stack>
      <PdfPanelHeader
        title={i18n.t("admin.pdf-settings.workspace.title")}
        description={i18n.t("admin.pdf-settings.workspace.description")}
      />
      <Stack>
        <ResponsiveGrid cols={{ base: 1, md: 2 }}>
          <Stack>
            <FieldLabel htmlFor="pdf-settings-paper-size">
              {i18n.t("admin.pdf-settings.workspace.paper-size")}
            </FieldLabel>
            <FormSelect
              id="pdf-settings-paper-size"
              value={paperSize}
              onChange={setPaperSize}
              data={PAPER_SIZES.map((value) => ({ value, label: value }))}
            />
          </Stack>
          <Stack>
            <FieldLabel htmlFor="pdf-settings-locale">
              {i18n.t("admin.pdf-settings.workspace.locale")}
            </FieldLabel>
            <Input
              id="pdf-settings-locale"
              value={locale}
              maxLength={16}
              placeholder="en"
              onChange={setLocale}
            />
          </Stack>
          <Stack>
            <FieldLabel htmlFor="pdf-settings-color-profile">
              {i18n.t("admin.pdf-settings.workspace.color-profile")}
            </FieldLabel>
            <FormSelect
              id="pdf-settings-color-profile"
              value={colorProfile}
              onChange={setColorProfile}
              data={colorProfileOptions}
            />
          </Stack>
          <Stack>
            <FieldLabel htmlFor="pdf-settings-image-quality">
              {i18n.t("admin.pdf-settings.workspace.image-quality")}
            </FieldLabel>
            <FormSelect
              id="pdf-settings-image-quality"
              value={imageQuality}
              onChange={setImageQuality}
              data={IMAGE_QUALITY.map((value) => ({
                value,
                label: i18n.t(
                  `admin.pdf-settings.workspace.image-quality.${value}`,
                ),
              }))}
            />
          </Stack>
          <Stack>
            <FieldLabel htmlFor="pdf-settings-default-template">
              {i18n.t("admin.pdf-settings.workspace.default-template")}
            </FieldLabel>
            <FormSelect
              id="pdf-settings-default-template"
              value={defaultTemplateId}
              onChange={setDefaultTemplateId}
              placeholder={i18n.t(
                "admin.pdf-settings.workspace.default-template-placeholder",
              )}
              data={
                assignedTemplates.length === 0
                  ? [
                      {
                        value: "__no_assigned_templates__",
                        label: i18n.t(
                          "admin.pdf-settings.workspace.no-assigned-templates",
                        ),
                      },
                    ]
                  : assignedTemplates.map((assignment) => ({
                      value: assignment.templateId,
                      label:
                        templateNameById.get(assignment.templateId) ??
                        assignment.templateId,
                    }))
              }
              disabled={assignedTemplates.length === 0}
            />
          </Stack>
        </ResponsiveGrid>

        <SettingsField
          label={i18n.t("admin.pdf-settings.workspace.ligatures")}
          description={i18n.t(
            "admin.pdf-settings.workspace.ligatures-description",
          )}
          inline
        >
          <Switch
            id="pdf-settings-ligatures"
            aria-label={i18n.t("admin.pdf-settings.workspace.ligatures")}
            checked={ligaturesEnabled}
            onCheckedChange={setLigaturesEnabled}
          />
        </SettingsField>

        <DialogFooterActions>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? i18n.t("admin.pdf-settings.workspace.saving")
              : i18n.t("admin.pdf-settings.workspace.save")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Global limits
// ---------------------------------------------------------------------------

function GlobalLimitsForm() {
  const i18n = useI18n();
  const {
    appConfig,
    patchedAppConfig,
    update,
    saveGroup,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
  } = useAppConfig();
  const module = "pdf_export";
  const source = useMemo(
    () =>
      (patchedAppConfig[module] ?? appConfig[module] ?? {}) as Record<
        string,
        unknown
      >,
    [appConfig, patchedAppConfig],
  );
  const dirty = isGroupDirty(module);
  const saving = isGroupSaving(module);

  const values = useMemo(
    () =>
      Object.fromEntries(
        GLOBAL_NUMBER_FIELDS.map((field) => [
          field.path,
          numberValue(
            getByPath(source, field.path),
            "fallback" in field ? field.fallback : field.min,
          ),
        ]),
      ) as Record<string, number>,
    [source],
  );

  const textValues = useMemo(
    () =>
      Object.fromEntries(
        GLOBAL_TEXT_FIELDS.map((field) => [
          field.path,
          field.optional
            ? ((getByPath(source, field.path) as string | null | undefined) ??
              "")
            : optionValue(
                getByPath(source, field.path) as string | null,
                field.placeholder,
              ),
        ]),
      ) as Record<string, string>,
    [source],
  );
  const enumValues = useMemo(
    () =>
      Object.fromEntries(
        GLOBAL_ENUM_FIELDS.map((field) => [
          field.path,
          optionValue(
            getByPath(source, field.path) as string | null,
            field.fallback,
          ),
        ]),
      ) as Record<string, string>,
    [source],
  );
  const i18nSource = (patchedAppConfig.i18n ?? appConfig.i18n ?? {}) as Record<
    string,
    unknown
  >;
  const mainWebLocale = optionValue(
    (i18nSource.defaultLocale ?? i18nSource.default_locale) as string | null,
    "en",
  );
  const handleSave = useCallback(async () => {
    try {
      await saveGroup(module);
      logPdfExportUiEvent("settings.global-limits.saved", {
        fieldCount:
          GLOBAL_NUMBER_FIELDS.length +
          GLOBAL_TEXT_FIELDS.length +
          GLOBAL_ENUM_FIELDS.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPdfExportUiEvent(
        "settings.global-limits.failed",
        { message: msg },
        "error",
      );
      throw err;
    }
  }, [saveGroup]);

  return (
    <Stack>
      <PdfPanelHeader
        title={i18n.t("admin.pdf-settings.global.title")}
        description={i18n.t("admin.pdf-settings.global.description")}
      />
      <Stack>
        <ResponsiveGrid cols={{ base: 1, md: 2 }}>
          {GLOBAL_NUMBER_FIELDS.map((field) => (
            <Stack key={field.path}>
              <FieldLabel htmlFor={`pdf-global-${field.key}`}>
                {i18n.t(`admin.pdf-settings.global.${field.key}`)}
              </FieldLabel>
              <NumberInput
                id={`pdf-global-${field.key}`}
                clampBehavior="none"
                min={field.min}
                max={"max" in field ? field.max : undefined}
                step={"step" in field ? field.step : undefined}
                value={values[field.path]}
                onChange={(raw) => {
                  const value = Number(raw);
                  update(`${module}/${field.path.replace(/\./g, "/")}`, value);
                }}
              />
            </Stack>
          ))}
          <Stack>
            <FieldLabel htmlFor="pdf-global-main-web-locale">
              {i18n.t("admin.pdf-settings.global.default-locale")}
            </FieldLabel>
            <Input
              id="pdf-global-main-web-locale"
              value={mainWebLocale}
              disabled
            />
          </Stack>
          {GLOBAL_ENUM_FIELDS.map((field) => (
            <Stack key={field.path}>
              <FieldLabel htmlFor={`pdf-global-${field.key}`}>
                {i18n.t(`admin.pdf-settings.global.${field.key}`)}
              </FieldLabel>
              <FormSelect
                id={`pdf-global-${field.key}`}
                value={enumValues[field.path]}
                onChange={(value) =>
                  update(`${module}/${field.path.replace(/\./g, "/")}`, value)
                }
                data={field.values.map((value) => ({
                  value,
                  label:
                    field.path === "default_image_quality"
                      ? i18n.t(
                          `admin.pdf-settings.workspace.image-quality.${value}`,
                        )
                      : value,
                }))}
              />
            </Stack>
          ))}
          {GLOBAL_TEXT_FIELDS.map((field) => (
            <Stack key={field.path}>
              <FieldLabel htmlFor={`pdf-global-${field.key}`}>
                {i18n.t(`admin.pdf-settings.global.${field.key}`)}
              </FieldLabel>
              <Input
                id={`pdf-global-${field.key}`}
                value={textValues[field.path]}
                maxLength={field.maxLength}
                placeholder={field.placeholder}
                onChange={(value) => {
                  const next =
                    field.optional && value.trim() === "" ? null : value;
                  update(`${module}/${field.path.replace(/\./g, "/")}`, next);
                }}
              />
            </Stack>
          ))}
        </ResponsiveGrid>
        <DialogFooterActions>
          <Button onClick={handleSave} disabled={!dirty || saving}>
            {saving
              ? i18n.t("admin.pdf-settings.global.saving")
              : i18n.t("admin.pdf-settings.global.save")}
          </Button>
          <Button
            variant="outline"
            onClick={() => resetGroup(module)}
            disabled={!dirty || saving}
          >
            {i18n.t("admin.pdf-settings.global.reset")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Stack>
  );
}

function DocumentVersioningDefaultsForm() {
  const i18n = useI18n();
  const {
    appConfig,
    patchedAppConfig,
    update,
    saveGroup,
    resetGroup,
    isGroupDirty,
    isGroupSaving,
  } = useAppConfig();
  const source = (patchedAppConfig[DOCUMENT_VERSIONING_MODULE] ??
    appConfig[DOCUMENT_VERSIONING_MODULE] ??
    {}) as Record<string, unknown>;
  const enabled = booleanValue(source.default_enabled, false);
  const autoPdf = booleanValue(
    source.default_auto_version_on_pdf_export,
    false,
  );
  const retention = numberValue(source.default_retention_count, 10);
  const dirty = isGroupDirty(DOCUMENT_VERSIONING_MODULE);
  const saving = isGroupSaving(DOCUMENT_VERSIONING_MODULE);

  const handleSave = useCallback(async () => {
    try {
      await saveGroup(DOCUMENT_VERSIONING_MODULE);
      logPdfExportUiEvent("settings.document-versioning-defaults.saved", {
        enabled,
        autoPdf,
        retention,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPdfExportUiEvent(
        "settings.document-versioning-defaults.failed",
        { message: msg },
        "error",
      );
      throw err;
    }
  }, [autoPdf, enabled, retention, saveGroup]);

  return (
    <Stack>
      <PdfPanelHeader
        title={i18n.t("admin.pdf-settings.doc-versioning.defaults.title")}
        description={i18n.t(
          "admin.pdf-settings.doc-versioning.defaults.description",
        )}
      />
      <Stack>
        <Stack>
          <SettingsField
            label={i18n.t("admin.pdf-settings.doc-versioning.default-enabled")}
            description={i18n.t(
              "admin.pdf-settings.doc-versioning.default-enabled-help",
            )}
            inline
          >
            <Switch
              id="doc-versioning-default-enabled"
              aria-label={i18n.t(
                "admin.pdf-settings.doc-versioning.default-enabled",
              )}
              checked={enabled}
              onCheckedChange={(value) =>
                update(`${DOCUMENT_VERSIONING_MODULE}/default_enabled`, value)
              }
            />
          </SettingsField>
          <SettingsField
            label={i18n.t("admin.pdf-settings.doc-versioning.default-pdf")}
            description={i18n.t(
              "admin.pdf-settings.doc-versioning.default-pdf-help",
            )}
            inline
          >
            <Switch
              id="doc-versioning-default-pdf"
              aria-label={i18n.t(
                "admin.pdf-settings.doc-versioning.default-pdf",
              )}
              checked={autoPdf}
              onCheckedChange={(value) =>
                update(
                  `${DOCUMENT_VERSIONING_MODULE}/default_auto_version_on_pdf_export`,
                  value,
                )
              }
            />
          </SettingsField>
          <SettingsField
            label={i18n.t(
              "admin.pdf-settings.doc-versioning.default-retention",
            )}
          >
            <NumberInput
              id="doc-versioning-default-retention"
              aria-label={i18n.t(
                "admin.pdf-settings.doc-versioning.default-retention",
              )}
              clampBehavior="none"
              min={1}
              max={50}
              value={retention}
              onChange={(value) =>
                update(
                  `${DOCUMENT_VERSIONING_MODULE}/default_retention_count`,
                  Number(value),
                )
              }
            />
          </SettingsField>
        </Stack>
        <DialogFooterActions>
          <Button onClick={handleSave} disabled={!dirty || saving}>
            {saving
              ? i18n.t("admin.pdf-settings.doc-versioning.saving")
              : i18n.t("admin.pdf-settings.doc-versioning.save")}
          </Button>
          <Button
            variant="outline"
            onClick={() => resetGroup(DOCUMENT_VERSIONING_MODULE)}
            disabled={!dirty || saving}
          >
            {i18n.t("admin.pdf-settings.global.reset")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Stack>
  );
}

function DocumentVersioningWorkspaceOverrides() {
  const i18n = useI18n();
  const query = useDocumentVersioningAdminSettingsQuery();
  const mutation = useUpdateDocumentVersioningWorkspaceSettingsMutation();
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        enabled: TriState;
        autoPdf: TriState;
        retention: string;
      }
    >
  >({});

  const draftFor = useCallback(
    (row: DocumentVersioningWorkspaceSettings) =>
      drafts[row.workspaceId] ?? {
        enabled: triStateFromNullable(row.enabled),
        autoPdf: triStateFromNullable(row.autoVersionOnPdfExport),
        retention:
          row.retentionCount === null ? "" : String(row.retentionCount),
      },
    [drafts],
  );

  const updateDraft = useCallback(
    (
      workspaceId: string,
      patch: Partial<ReturnType<typeof draftFor>>,
      row: DocumentVersioningWorkspaceSettings,
    ) => {
      setDrafts((current) => ({
        ...current,
        [workspaceId]: {
          ...draftFor(row),
          ...patch,
        },
      }));
    },
    [draftFor],
  );

  const saveRow = useCallback(
    async (row: DocumentVersioningWorkspaceSettings) => {
      const draft = draftFor(row);
      const retention =
        draft.retention.trim() === "" ? null : Number(draft.retention);
      try {
        await mutation.trigger({
          input: {
            workspaceId: row.workspaceId,
            enabled: nullableFromTriState(draft.enabled),
            autoVersionOnPdfExport: nullableFromTriState(draft.autoPdf),
            retentionCount: retention,
          },
        });
        setDrafts((current) => {
          const next = { ...current };
          delete next[row.workspaceId];
          return next;
        });
        void query.mutate();
        notify.success({
          title: i18n.t(
            "admin.pdf-settings.doc-versioning.workspace.save-success",
          ),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify.error({
          title: `${i18n.t("admin.pdf-settings.doc-versioning.workspace.save-failed")}: ${msg}`,
        });
      }
    },
    [draftFor, i18n, mutation, query],
  );

  const clearRow = useCallback(
    async (row: DocumentVersioningWorkspaceSettings) => {
      try {
        await mutation.trigger({
          input: {
            workspaceId: row.workspaceId,
            enabled: null,
            autoVersionOnPdfExport: null,
            retentionCount: null,
          },
        });
        setDrafts((current) => {
          const next = { ...current };
          delete next[row.workspaceId];
          return next;
        });
        void query.mutate();
        notify.success({
          title: i18n.t(
            "admin.pdf-settings.doc-versioning.workspace.clear-success",
          ),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify.error({
          title: `${i18n.t("admin.pdf-settings.doc-versioning.workspace.save-failed")}: ${msg}`,
        });
      }
    },
    [i18n, mutation, query],
  );

  return (
    <Stack>
      <PdfPanelHeader
        title={i18n.t("admin.pdf-settings.doc-versioning.workspace.title")}
        description={i18n.t(
          "admin.pdf-settings.doc-versioning.workspace.description",
        )}
      />
      <div>
        <TableScrollContainer>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {i18n.t("admin.pdf-settings.doc-versioning.workspace.name")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-settings.doc-versioning.default-enabled")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-settings.doc-versioning.default-pdf")}
                </TableHead>
                <TableHead>
                  {i18n.t(
                    "admin.pdf-settings.doc-versioning.default-retention",
                  )}
                </TableHead>
                <TableHead>
                  {i18n.t(
                    "admin.pdf-settings.doc-versioning.workspace.effective",
                  )}
                </TableHead>
                <TableHead>
                  {i18n.t(
                    "admin.pdf-settings.doc-versioning.workspace.actions",
                  )}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.workspaceSettings.map((row) => {
                const draft = draftFor(row);
                return (
                  <TableRow key={row.workspaceId}>
                    <TableCell>
                      {row.workspaceName ?? row.workspaceId}
                    </TableCell>
                    <TableCell>
                      <FormSelect
                        value={draft.enabled}
                        onChange={(value) =>
                          updateDraft(
                            row.workspaceId,
                            { enabled: value as TriState },
                            row,
                          )
                        }
                        data={triStateOptions(i18n)}
                      />
                    </TableCell>
                    <TableCell>
                      <FormSelect
                        value={draft.autoPdf}
                        onChange={(value) =>
                          updateDraft(
                            row.workspaceId,
                            { autoPdf: value as TriState },
                            row,
                          )
                        }
                        data={triStateOptions(i18n)}
                      />
                    </TableCell>
                    <TableCell>
                      <NumberInput
                        clampBehavior="none"
                        min={1}
                        max={50}
                        placeholder={i18n.t(
                          "admin.pdf-settings.doc-versioning.inherit",
                        )}
                        value={draft.retention}
                        onChange={(value) =>
                          updateDraft(
                            row.workspaceId,
                            { retention: String(value) },
                            row,
                          )
                        }
                      />
                    </TableCell>
                    <TableCell muted>
                      {i18n.t(
                        row.effectiveEnabled
                          ? "admin.pdf-settings.doc-versioning.on"
                          : "admin.pdf-settings.doc-versioning.off",
                      )}
                      {" / "}
                      {i18n.t(
                        row.effectiveAutoVersionOnPdfExport
                          ? "admin.pdf-settings.doc-versioning.pdf-on"
                          : "admin.pdf-settings.doc-versioning.pdf-off",
                      )}
                      {" / "}
                      {row.effectiveRetentionCount}
                    </TableCell>
                    <TableCell>
                      <SettingsToolbar justify="flex-start">
                        <Button
                          size="sm"
                          onClick={() => void saveRow(row)}
                          disabled={mutation.isMutating}
                        >
                          {i18n.t(
                            "admin.pdf-settings.doc-versioning.workspace.save",
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void clearRow(row)}
                          disabled={mutation.isMutating}
                        >
                          {i18n.t(
                            "admin.pdf-settings.doc-versioning.workspace.clear",
                          )}
                        </Button>
                      </SettingsToolbar>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableScrollContainer>
      </div>
    </Stack>
  );
}

function SettingsTabContent() {
  const i18n = useI18n();
  const workspaces = useWorkspaceOptions();
  const [workspaceId, setWorkspaceId] = useState("");

  return (
    <Stack>
      <Stack>
        <Stack>
          <SettingsNotice
            tone="success"
            title={i18n.t("admin.pdf-settings.audit-banner")}
          />
          <Stack>
            <FormSelect
              id="pdf-settings-workspace"
              label={i18n.t("admin.pdf-settings.workspace.select")}
              searchable
              value={workspaceId}
              onChange={setWorkspaceId}
              placeholder={i18n.t("admin.pdf-settings.workspace.placeholder")}
              data={workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
            />
          </Stack>
        </Stack>
      </Stack>

      {workspaceId ? (
        <Suspense fallback={<Skeleton h={256} />}>
          <WorkspaceDefaultsForm key={workspaceId} workspaceId={workspaceId} />
        </Suspense>
      ) : (
        <Stack>
          <RoleEmptyState
            title={i18n.t("admin.pdf-settings.workspace.select-prompt")}
          />
        </Stack>
      )}

      <DocumentVersioningDefaultsForm />
      <DocumentVersioningWorkspaceOverrides />
      <GlobalLimitsForm />
    </Stack>
  );
}

/** Render workspace defaults and global limits for PDF export. */
export function SettingsTab() {
  return (
    <Suspense fallback={<Skeleton h={256} />}>
      <SettingsTabContent />
    </Suspense>
  );
}
