/**
 * @file PDF export module — Brand Assets tab.
 *
 * Per-workspace administration of document-visible branding used by PDF
 * exports of that workspace:
 *  - Logos (large + small) — PNG / SVG, server-side sanitized.
 *  - Brand text (footer text).
 *  - Document color policy (server palettes, plain, or custom hex literals).
 *
 * Font-family selection is intentionally absent from this tab. PDF uses the
 * effective workspace/global theme typography and only maps that contract to
 * bundled Typst-readable font files during render dispatch.
 *
 * Server contract:
 *  - GraphQL query: `documentBrandingProfile(workspaceId)` (admin
 *    projection with audit fields)
 *  - GraphQL query: `documentBrandColorPalettes(workspaceId)` for
 *    server-resolved document-safe colors from the effective theme.
 *  - Mutations: `uploadDocumentBrandLogo`, `deleteDocumentBrandLogo`,
 *    `updateDocumentBrandingText`, `setDocumentBrandingColorPolicy`,
 *    `updateDocumentBrandingColors`,
 *    `resetWorkspaceDocumentBranding`
 *  - Resolver: `crates/api/src/graphql/pdf_workspace.rs` (P-PDF-TPL-09)
 */
import { adminWorkspacesQuery, BrandLogoKind } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ResetIcon, TrashIcon } from "@myoxus/icons/react";
import {
  Button,
  ColorInput,
  ColorSwatch,
  ErrorMessage,
  Group,
  Input,
  notify,
  ResponsiveGrid,
  FormSelect,
  SelectableCardRow,
  SettingsListItemMeta,
  SettingsPanelDescription,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
  SurfaceListItem,
  UploadTarget,
} from "@myoxus/ui-facade";
import {
  Activity,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { useQuery } from "../../../use-query";
import { formatAdminDateTime } from "../../../utils/locale-format";
import { useAppConfig } from "../../settings/use-app-config";
import {
  type DocumentBrandColorPaletteAdmin,
  type DocumentBrandColorPolicy,
  type DocumentBrandingProfileAdmin,
  useDeleteDocumentBrandLogoMutation,
  useDocumentBrandColorPalettesQuery,
  useDocumentBrandingProfileQuery,
  useResetWorkspaceDocumentBrandingMutation,
  useSetDocumentBrandingColorPolicyMutation,
  useUpdateDocumentBrandingColorsMutation,
  useUpdateDocumentBrandingTextMutation,
  useUploadDocumentBrandLogoMutation,
} from "../api";
import { PdfPanelHeader, FieldLabel } from "../pdf-role-primitives";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WorkspaceOption {
  id: string;
  name: string;
}

function useWorkspaceOptions(): WorkspaceOption[] {
  const { data } = useQuery({
    query: adminWorkspacesQuery,
    variables: { filter: { first: 100, skip: 0 } },
  });
  const list =
    (data?.admin?.adminWorkspaces as
      Array<{ id: string; name: string }> | undefined) ?? [];
  return list.map((w) => ({ id: w.id, name: w.name ?? w.id }));
}

// ---------------------------------------------------------------------------
// Logo slot — upload + preview + delete
// ---------------------------------------------------------------------------

function LogoSlot({
  workspaceId,
  kind,
  existingBlob,
  maxSizeMb,
  onChanged,
}: {
  workspaceId: string;
  kind: BrandLogoKind;
  existingBlob: string | null;
  maxSizeMb: number;
  onChanged: () => Promise<unknown>;
}) {
  const i18n = useI18n();
  const upload = useUploadDocumentBrandLogoMutation();
  const remove = useDeleteDocumentBrandLogoMutation();
  const [busy, setBusy] = useState(false);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [deleteRequested, setDeleteRequested] = useState(false);

  useEffect(() => {
    if (!previewFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(previewFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewFile]);

  const handleUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        await upload.uploadDocumentBrandLogo({ workspaceId, kind, file });
        await onChanged();
        notify.success({
          title: i18n.t("admin.pdf-brand.logo.upload-success"),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify.error({
          title: i18n.t("admin.pdf-brand.logo.upload-failed"),
          message: msg,
        });
      } finally {
        setPreviewFile(null);
        setBusy(false);
      }
    },
    [workspaceId, kind, upload, onChanged, i18n],
  );

  const acceptFile = useCallback(
    (file: File) => {
      setPreviewFile(file);
      void handleUpload(file);
    },
    [handleUpload],
  );

  const handleDelete = useCallback(async () => {
    setBusy(true);
    try {
      await remove.deleteDocumentBrandLogo({ workspaceId, kind });
      await onChanged();
      notify.success({
        title: i18n.t("admin.pdf-brand.logo.delete-success"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error({
        title: i18n.t("admin.pdf-brand.logo.delete-failed"),
        message: msg,
      });
    } finally {
      setDeleteRequested(false);
      setBusy(false);
    }
  }, [workspaceId, kind, remove, onChanged, i18n]);

  return (
    <Stack component="section">
      <PdfPanelHeader
        title={
          kind === BrandLogoKind.Large
            ? i18n.t("admin.pdf-brand.logo.large")
            : i18n.t("admin.pdf-brand.logo.small")
        }
        description={
          kind === BrandLogoKind.Large
            ? i18n.t("admin.pdf-brand.logo.large-hint")
            : i18n.t("admin.pdf-brand.logo.small-hint")
        }
      />
      <SettingsPanelDescription>
        {i18n
          .t("admin.pdf-brand.logo.format-hint")
          .replace("{{max}}", String(maxSizeMb))}
      </SettingsPanelDescription>

      {previewUrl || existingBlob ? (
        <SurfaceListItem
          appearance="card"
          density="compact"
          data-myoxus-ui-role="pdf-logo-preview"
        >
          <Group align="center" wrap="wrap">
            {previewUrl ? (
              <img
                alt={i18n.t("admin.pdf-brand.logo.preview-alt")}
                src={previewUrl}
              />
            ) : (
              <SettingsStatusText>
                {i18n.t("admin.pdf-brand.logo.current")}
              </SettingsStatusText>
            )}
            <SettingsStatusText mono>
              {previewUrl
                ? i18n.t("admin.pdf-brand.logo.local-preview")
                : existingBlob}
            </SettingsStatusText>
          </Group>
        </SurfaceListItem>
      ) : (
        <SettingsStatusText>
          {i18n.t("admin.pdf-brand.logo.none")}
        </SettingsStatusText>
      )}

      <ResponsiveGrid cols={{ base: 1, md: 2 }}>
        <UploadTarget
          title={i18n.t("admin.pdf-brand.logo.drop-title")}
          description={i18n.t("admin.pdf-brand.logo.drop-hint")}
          pickLabel={i18n.t("admin.pdf-brand.logo.pick-file")}
          accept=".png,.svg,image/png,image/svg+xml"
          disabled={busy}
          data-testid={`pdf-brand-logo-dropzone-${kind}`}
          onFile={acceptFile}
        />
        {existingBlob ? (
          <Button
            variant="outline"
            onClick={() => setDeleteRequested(true)}
            disabled={busy}
            prefix={<TrashIcon aria-hidden />}
          >
            {i18n.t("admin.common.delete")}
          </Button>
        ) : null}
      </ResponsiveGrid>
      {/* Keep the frame mounted so Mantine can finish closing and return focus. */}
      <AdminConfirmModal
        open={deleteRequested}
        onOpenChange={(open) => {
          if (!open) setDeleteRequested(false);
        }}
        title={i18n.t("admin.pdf-brand.logo.delete-confirm")}
        description={i18n.t("admin.pdf-brand.logo.delete-confirm")}
        cancelText={i18n.t("admin.common.cancel")}
        confirmText={i18n.t("admin.common.delete")}
        danger
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteRequested(false)}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Form sections
// ---------------------------------------------------------------------------

type BrandAsset = DocumentBrandingProfileAdmin;

function TextSection({
  workspaceId,
  asset,
  onChanged,
}: {
  workspaceId: string;
  asset: BrandAsset;
  onChanged: () => Promise<unknown>;
}) {
  const i18n = useI18n();
  const [footerText, setFooterText] = useState(asset.footerText ?? "");
  const lastFooter = useRef(asset.footerText ?? "");
  const footerId = useId();
  const [busy, setBusy] = useState(false);
  const update = useUpdateDocumentBrandingTextMutation();

  useEffect(() => {
    const next = asset.footerText ?? "";
    const previous = lastFooter.current;
    // Activity reactivates effects; only genuinely changed server values may
    // initialize a clean field, never overwrite a retained dirty draft.
    if (next !== previous) {
      setFooterText((current) => (current === previous ? next : current));
      lastFooter.current = next;
    }
  }, [asset.footerText]);

  const dirty = footerText !== (asset.footerText ?? "");

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      const saved = await update.updateDocumentBrandingText({
        workspaceId,
        footerText: footerText === "" ? null : footerText,
      });
      await onChanged();
      setFooterText((current) =>
        current === footerText ? (saved.footerText ?? "") : current,
      );
      notify.success({ title: i18n.t("admin.pdf-brand.text.saved") });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error({
        title: i18n.t("admin.pdf-brand.text.save-failed"),
        message: msg,
      });
    } finally {
      setBusy(false);
    }
  }, [update, workspaceId, footerText, onChanged, i18n]);

  return (
    <Stack component="section">
      <PdfPanelHeader title={i18n.t("admin.pdf-brand.text.title")} />
      <Stack>
        <Stack>
          <FieldLabel htmlFor={footerId}>
            {i18n.t("admin.pdf-brand.text.footer-text")}
          </FieldLabel>
          <Input
            id={footerId}
            value={footerText}
            onChange={setFooterText}
            maxLength={256}
            disabled={busy}
          />
        </Stack>
        <SettingsToolbar>
          <Button onClick={handleSave} disabled={!dirty || busy}>
            {busy ? i18n.t("admin.common.saving") : i18n.t("admin.common.save")}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty || busy}
            onClick={() => setFooterText(asset.footerText ?? "")}
          >
            {i18n.t("admin.common.discard")}
          </Button>
        </SettingsToolbar>
      </Stack>
    </Stack>
  );
}

function ColorsSection({
  workspaceId,
  asset,
  palettes,
  onChanged,
}: {
  workspaceId: string;
  asset: BrandAsset;
  palettes: DocumentBrandColorPaletteAdmin[];
  onChanged: () => Promise<unknown>;
}) {
  const i18n = useI18n();
  const customPrimaryBase =
    asset.colorPolicy === "custom" ? (asset.brandColorPrimary ?? "") : "";
  const customAccentBase =
    asset.colorPolicy === "custom" ? (asset.brandColorAccent ?? "") : "";
  const [{ primary, accent }, setColors] = useState({
    primary: customPrimaryBase,
    accent: customAccentBase,
  });
  const lastColors = useRef({
    primary: customPrimaryBase,
    accent: customAccentBase,
  });
  const primaryId = useId();
  const accentId = useId();
  const [busy, setBusy] = useState(false);
  const [policyBusyKey, setPolicyBusyKey] = useState<string | null>(null);
  const update = useUpdateDocumentBrandingColorsMutation();
  const policyMutation = useSetDocumentBrandingColorPolicyMutation();

  useEffect(() => {
    const previous = lastColors.current;
    if (
      customPrimaryBase !== previous.primary ||
      customAccentBase !== previous.accent
    ) {
      const next = { primary: customPrimaryBase, accent: customAccentBase };
      setColors((current) =>
        current.primary === previous.primary &&
        current.accent === previous.accent
          ? next
          : current,
      );
      lastColors.current = next;
    }
  }, [customPrimaryBase, customAccentBase]);

  const dirty = primary !== customPrimaryBase || accent !== customAccentBase;

  const isHex = (v: string) => v === "" || /^#[0-9a-fA-F]{6}$/.test(v.trim());

  const pairComplete =
    (primary.trim() === "" && accent.trim() === "") ||
    (primary.trim() !== "" && accent.trim() !== "");
  const valid = isHex(primary) && isHex(accent) && pairComplete;

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      const saved = await update.updateDocumentBrandingColors({
        workspaceId,
        primary: primary === "" ? null : primary,
        accent: accent === "" ? null : accent,
      });
      await onChanged();
      setColors((current) =>
        current.primary === primary && current.accent === accent
          ? {
              primary: saved.brandColorPrimary ?? "",
              accent: saved.brandColorAccent ?? "",
            }
          : current,
      );
      notify.success({ title: i18n.t("admin.pdf-brand.colors.saved") });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error({
        title: i18n.t("admin.pdf-brand.colors.save-failed"),
        message: msg,
      });
    } finally {
      setBusy(false);
    }
  }, [update, workspaceId, primary, accent, onChanged, i18n]);

  const handlePolicySelect = useCallback(
    async (palette: DocumentBrandColorPaletteAdmin) => {
      const policy = palette.paletteKey === "plain" ? "plain" : "theme_palette";
      setPolicyBusyKey(palette.paletteKey);
      try {
        await policyMutation.setDocumentBrandingColorPolicy({
          workspaceId,
          policy: policy as DocumentBrandColorPolicy,
          paletteKey: palette.paletteKey,
        });
        await onChanged();
        notify.success({ title: i18n.t("admin.pdf-brand.colors.saved") });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify.error({
          title: i18n.t("admin.pdf-brand.colors.save-failed"),
          message: msg,
        });
      } finally {
        setPolicyBusyKey(null);
      }
    },
    [i18n, onChanged, policyMutation, workspaceId],
  );

  const paletteLabel = useCallback(
    (palette: DocumentBrandColorPaletteAdmin) => {
      const key = `admin.pdf-brand.palette.${palette.paletteKey}`;
      const translated = i18n.t(key);
      return translated === key ? palette.name : translated;
    },
    [i18n],
  );

  return (
    <Stack component="section">
      <PdfPanelHeader
        title={i18n.t("admin.pdf-brand.colors.title")}
        description={i18n.t("admin.pdf-brand.colors.description")}
      />
      <Stack>
        {palettes.length > 0 ? (
          <Stack component="section">
            <PdfPanelHeader
              title={i18n.t("admin.pdf-brand.colors.palette-title")}
              description={i18n.t("admin.pdf-brand.colors.palette-description")}
            />
            <Stack>
              <ResponsiveGrid cols={{ base: 1, md: 2, lg: 4 }}>
                {palettes.map((palette) => {
                  const active =
                    asset.colorPaletteKey === palette.paletteKey &&
                    ((palette.paletteKey === "plain" &&
                      asset.colorPolicy === "plain") ||
                      (palette.paletteKey !== "plain" &&
                        asset.colorPolicy === "theme_palette"));
                  return (
                    <SelectableCardRow
                      key={palette.paletteKey}
                      selected={active}
                      disabled={busy || policyBusyKey !== null}
                      onClick={() => void handlePolicySelect(palette)}
                    >
                      <Stack>
                        <SettingsToolbar justify="space-between">
                          <SettingsListItemMeta tone="active">
                            {paletteLabel(palette)}
                          </SettingsListItemMeta>
                          {palette.isDefault ? (
                            <SettingsStatusText>
                              {i18n.t("admin.pdf-brand.colors.palette-default")}
                            </SettingsStatusText>
                          ) : null}
                        </SettingsToolbar>
                        <Group wrap="wrap">
                          {[
                            palette.primaryColor,
                            palette.accentColor,
                            palette.ruleColor,
                            palette.textColor,
                            palette.backgroundColor,
                          ].map((color, index) => (
                            <ColorSwatch
                              key={`${palette.paletteKey}-${index}`}
                              color={color}
                            />
                          ))}
                        </Group>
                        <SettingsListItemMeta>
                          {palette.themeName}
                        </SettingsListItemMeta>
                      </Stack>
                    </SelectableCardRow>
                  );
                })}
              </ResponsiveGrid>
            </Stack>
          </Stack>
        ) : null}
        <Stack component="section">
          <PdfPanelHeader
            title={i18n.t("admin.pdf-brand.colors.custom-title")}
            description={i18n.t("admin.pdf-brand.colors.custom-description")}
          />
          <Stack>
            <ResponsiveGrid cols={{ base: 1, md: 2 }}>
              <Stack>
                <FieldLabel htmlFor={primaryId}>
                  {i18n.t("admin.pdf-brand.colors.primary")}
                </FieldLabel>
                <Group align="center">
                  <Input
                    id={primaryId}
                    type="text"
                    value={primary}
                    onChange={(value) =>
                      setColors((current) => ({ ...current, primary: value }))
                    }
                    disabled={busy || policyBusyKey !== null}
                    placeholder="#1e96eb"
                    maxLength={7}
                    status={isHex(primary) ? "default" : "error"}
                  />
                  <ColorInput
                    value={
                      isHex(primary) && primary !== "" ? primary : "#000000"
                    }
                    onChange={(value) =>
                      setColors((current) => ({ ...current, primary: value }))
                    }
                    disabled={busy || policyBusyKey !== null}
                    aria-label={i18n.t("admin.pdf-brand.colors.primary-picker")}
                  />
                </Group>
              </Stack>
              <Stack>
                <FieldLabel htmlFor={accentId}>
                  {i18n.t("admin.pdf-brand.colors.accent")}
                </FieldLabel>
                <Group align="center">
                  <Input
                    id={accentId}
                    type="text"
                    value={accent}
                    onChange={(value) =>
                      setColors((current) => ({ ...current, accent: value }))
                    }
                    disabled={busy || policyBusyKey !== null}
                    placeholder="#0a6dca"
                    maxLength={7}
                    status={isHex(accent) ? "default" : "error"}
                  />
                  <ColorInput
                    value={isHex(accent) && accent !== "" ? accent : "#000000"}
                    onChange={(value) =>
                      setColors((current) => ({ ...current, accent: value }))
                    }
                    disabled={busy || policyBusyKey !== null}
                    aria-label={i18n.t("admin.pdf-brand.colors.accent-picker")}
                  />
                </Group>
              </Stack>
            </ResponsiveGrid>
            {!pairComplete ? (
              <ErrorMessage>
                {i18n.t("admin.pdf-brand.colors.pair-required")}
              </ErrorMessage>
            ) : null}
            <SettingsToolbar>
              <Button
                data-testid="pdf-brand-custom-colors-save"
                onClick={handleSave}
                disabled={!dirty || busy || policyBusyKey !== null || !valid}
              >
                {busy
                  ? i18n.t("admin.common.saving")
                  : i18n.t("admin.common.save")}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty || busy || policyBusyKey !== null}
                onClick={() =>
                  setColors({
                    primary: customPrimaryBase,
                    accent: customAccentBase,
                  })
                }
              >
                {i18n.t("admin.common.discard")}
              </Button>
            </SettingsToolbar>
          </Stack>
        </Stack>
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Brand panel for selected workspace
// ---------------------------------------------------------------------------

function BrandPanel({ workspaceId }: { workspaceId: string }) {
  const i18n = useI18n();
  const query = useDocumentBrandingProfileQuery(workspaceId);
  const paletteQuery = useDocumentBrandColorPalettesQuery(workspaceId);
  const reset = useResetWorkspaceDocumentBrandingMutation();
  const { appConfig } = useAppConfig();
  const asset = query.profile as BrandAsset | null;
  const [resetting, setResetting] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const maxBrandAssetSizeMb =
    (appConfig.pdf_export as { max_brand_asset_size_mb?: number } | undefined)
      ?.max_brand_asset_size_mb ?? 8;

  const handleRefresh = useCallback(() => {
    return query.mutate();
  }, [query]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await reset.resetWorkspaceDocumentBranding({ workspaceId });
      await handleRefresh();
      setResetVersion((version) => version + 1);
      notify.success({ title: i18n.t("admin.pdf-brand.reset.inherited") });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error({
        title: i18n.t("admin.pdf-brand.reset.failed"),
        message: msg,
      });
    } finally {
      setResetRequested(false);
      setResetting(false);
    }
  }, [handleRefresh, i18n, reset, workspaceId]);

  if (!asset) {
    return <Skeleton h={128} />;
  }

  return (
    <Stack>
      <PdfPanelHeader
        title={i18n.t("admin.pdf-brand.reset.title")}
        description={i18n.t("admin.pdf-brand.reset.description")}
        action={
          <Button
            variant="outline"
            onClick={() => setResetRequested(true)}
            disabled={resetting}
            prefix={<ResetIcon aria-hidden />}
          >
            {i18n.t("admin.pdf-brand.reset.action")}
          </Button>
        }
      />
      <ResponsiveGrid cols={{ base: 1, md: 2 }}>
        <LogoSlot
          workspaceId={workspaceId}
          kind={BrandLogoKind.Large}
          existingBlob={asset.logoLargeBlob}
          maxSizeMb={maxBrandAssetSizeMb}
          onChanged={handleRefresh}
        />
        <LogoSlot
          workspaceId={workspaceId}
          kind={BrandLogoKind.Small}
          existingBlob={asset.logoSmallBlob}
          maxSizeMb={maxBrandAssetSizeMb}
          onChanged={handleRefresh}
        />
      </ResponsiveGrid>
      <TextSection
        key={`text-${resetVersion}`}
        workspaceId={workspaceId}
        asset={asset}
        onChanged={handleRefresh}
      />
      <ColorsSection
        key={`colors-${resetVersion}`}
        workspaceId={workspaceId}
        asset={asset}
        palettes={paletteQuery.palettes}
        onChanged={handleRefresh}
      />
      <SettingsStatusText>
        {i18n.t("admin.pdf-brand.last-updated")}{" "}
        {formatAdminDateTime(
          i18n.language,
          (asset as unknown as { updatedAt: string }).updatedAt,
        )}
      </SettingsStatusText>
      <AdminConfirmModal
        open={resetRequested}
        onOpenChange={(open) => {
          if (!open) setResetRequested(false);
        }}
        title={i18n.t("admin.pdf-brand.reset.confirm")}
        description={i18n.t("admin.pdf-brand.reset.description")}
        cancelText={i18n.t("admin.common.cancel")}
        confirmText={i18n.t("admin.pdf-brand.reset.action")}
        danger
        onConfirm={() => void handleReset()}
        onCancel={() => setResetRequested(false)}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Inner content
// ---------------------------------------------------------------------------

function BrandAssetsTabContent() {
  const i18n = useI18n();
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<string[]>([]);
  const workspaces = useWorkspaceOptions();

  return (
    <Stack>
      <Stack>
        <Stack>
          <FormSelect
            id="brand-ws-picker"
            label={i18n.t("admin.pdf-brand.pick-workspace")}
            searchable
            value={workspaceId}
            onChange={(id) => {
              setWorkspaceId(id);
              if (id)
                setVisitedWorkspaces((current) =>
                  current.includes(id) ? current : [...current, id],
                );
            }}
            placeholder={i18n.t("admin.pdf-brand.placeholder")}
            data={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        </Stack>

        {/* Activity retains workspace-owned drafts and in-flight state without
            adding DOM or a parallel visual layout to native Facade controls. */}
        {visitedWorkspaces.map((id) => (
          <Activity key={id} mode={id === workspaceId ? "visible" : "hidden"}>
            <Suspense fallback={<Skeleton h={256} />}>
              <BrandPanel workspaceId={id} />
            </Suspense>
          </Activity>
        ))}
        {!workspaceId && (
          <SettingsStatusText>
            {i18n.t("admin.pdf-brand.select-prompt")}
          </SettingsStatusText>
        )}
      </Stack>
    </Stack>
  );
}

export function BrandAssetsTab() {
  return (
    <Suspense fallback={<Skeleton h={256} />}>
      <BrandAssetsTabContent />
    </Suspense>
  );
}
