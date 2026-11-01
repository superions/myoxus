/**
 * P-AR-1-06 — Branding-Tab.
 *
 * shared Admin role shell over the server-owned branding asset flow
 * (`POST /api/admin/branding/upload`, multipart `slot=<logo|productMark>`).
 * The tab presents three sections:
 *
 *   01. Logo            — SVG/PNG, hard-cap 256 kB.
 *   02. Product-Mark    — SVG/PNG, hard-cap 64 kB.
 *   03. Favicon-Pack    — ZIP with app-manifest PNGs from 32–192 px,
 *                          hard-cap 1 MiB.
 *
 * Upload metadata is persisted in `brand_assets` and read back through the
 * typed AdminRoot `appServerBranding` projection. The REST upload
 * endpoint remains only the binary transport; it is not an `app_configs`
 * authoring path.
 *
 * Each section also shows a side-by-side **Light** / **Dark** preview.
 * Each preview scopes both the Myoxus theme and Mantine color scheme so Facade
 * roles remain readable without changing the operator's global theme.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import { adminAppServerBrandingQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  FormFieldset,
  Group,
  Input,
  MediaPreviewFrame,
  MediaPreviewImage,
  notify,
  notifyBrandIdentityUpdated,
  ResponsiveGrid,
  SettingsHeadingGroup,
  SettingsListItemMeta,
  SettingsNotice,
  SettingsSection,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsStatusText,
  SimpleGrid,
  Stack,
  Textarea,
  UploadTarget,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useRef, useState } from "react";

import { uploadBrandingAsset } from "../../../api/asset-upload-api";
import { useMutateQueryResource } from "../../../use-mutation";
import { ConfigPageSaveButtons } from "../../settings/config-page-save-buttons";
import {
  type OrganizationIdentityAdmin,
  useUpdateOrganizationIdentityMutation,
} from "../../branding/brand-identity-api";
import {
  type AppServerBranding,
  FAVICON_MANIFEST_SIZES,
  faviconPublicUrlForSize,
  getBrandingAssetPublicUrl,
  resolveBrandingPublicUrl,
} from "../../theme/theme-contract";

type ImageSlot = "logo" | "productMark";
type SectionSlot = ImageSlot | "faviconPack";

type SlotState = {
  status: "idle" | "uploading" | "success" | "error";
  message?: string;
  previewOverride?: string;
};

const IDLE: SlotState = { status: "idle" };

const IMAGE_ACCEPT = "image/svg+xml,image/png,.svg,.png";
const ZIP_ACCEPT = "application/zip,.zip";

// Hard caps from the spec — independent from the server config bound,
// which may be configured higher (we always pick the lower of the two).
const HARD_CAP_BYTES: Record<SectionSlot, number> = {
  logo: 256 * 1024,
  productMark: 64 * 1024,
  faviconPack: 1 * 1024 * 1024,
};

function nullableText(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function linesFromIdentity(identity: OrganizationIdentityAdmin | null) {
  return Array.isArray(identity?.addressLines)
    ? identity.addressLines.filter(
        (line): line is string => typeof line === "string",
      )
    : [];
}

function identityDraft(identity: OrganizationIdentityAdmin | null) {
  return {
    displayName: identity?.displayName ?? "",
    shortName: identity?.shortName ?? "",
    legalName: identity?.legalName ?? "",
    jurisdiction: identity?.jurisdiction ?? "",
    websiteUrl: identity?.websiteUrl ?? "",
    contactEmail: identity?.contactEmail ?? "",
    taxId: identity?.taxId ?? "",
    registrationId: identity?.registrationId ?? "",
    addressLines: linesFromIdentity(identity).join("\n"),
  };
}

const IDENTITY_FIELDS = [
  ["displayName", "admin.design.branding.organization.display-name", "text"],
  ["shortName", "admin.design.branding.organization.short-name", "text"],
  ["legalName", "admin.design.branding.organization.legal-name", "text"],
  ["jurisdiction", "admin.design.branding.organization.jurisdiction", "text"],
  ["websiteUrl", "admin.design.branding.organization.website-url", "url"],
  ["contactEmail", "admin.design.branding.organization.contact-email", "email"],
  ["taxId", "admin.design.branding.organization.tax-id", "text"],
  [
    "registrationId",
    "admin.design.branding.organization.registration-id",
    "text",
  ],
] as const;

function OrganizationIdentitySection({
  identity,
}: {
  identity: OrganizationIdentityAdmin | null;
}) {
  const i18n = useI18n();
  const { updateOrganizationIdentity, isMutating } =
    useUpdateOrganizationIdentityMutation();
  const incoming = identityDraft(identity);
  const incomingVersion = JSON.stringify(incoming);
  const [lastIncomingVersion, setLastIncomingVersion] =
    useState(incomingVersion);
  const [saved, setSaved] = useState(incoming);
  const [draft, setDraft] = useState(incoming);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const saveLock = useRef(false);
  const identityInput = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const busy = saving || isMutating;

  // A hidden native tab reconnects effects; only changed server values may adopt
  // a new baseline. Background asset readback must not discard identity edits.
  if (incomingVersion !== lastIncomingVersion) {
    setLastIncomingVersion(incomingVersion);
    setSaved(incoming);
    if (!dirty) setDraft(incoming);
  }

  const handleSave = async () => {
    if (saveLock.current || isMutating || !dirty) return;
    saveLock.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await updateOrganizationIdentity({
        displayName: nullableText(draft.displayName),
        legalName: nullableText(draft.legalName),
        shortName: nullableText(draft.shortName),
        jurisdiction: nullableText(draft.jurisdiction),
        websiteUrl: nullableText(draft.websiteUrl),
        contactEmail: nullableText(draft.contactEmail),
        addressLines: draft.addressLines
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        taxId: nullableText(draft.taxId),
        registrationId: nullableText(draft.registrationId),
      });
      const accepted = identityDraft(result);
      setSaved(accepted);
      setDraft(accepted);
      notifyBrandIdentityUpdated();
      toast.success(i18n.t("admin.state.saved"));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : i18n.t("admin.design.branding.organization.save-failed");
      setSaveError(message);
      toast.error(message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };

  return (
    <Stack component="section" data-testid="design-branding-organization">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.design.branding.organization.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.design.branding.organization.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {saveError ? (
        <SettingsNotice tone="error">{saveError}</SettingsNotice>
      ) : null}
      <FormFieldset variant="unstyled" disabled={busy}>
        <Stack>
          <SimpleGrid cols={2}>
            {IDENTITY_FIELDS.map(([key, labelKey, type]) => (
              <Input
                key={key}
                ref={key === "displayName" ? identityInput : undefined}
                id={`brand-org-${key}`}
                label={i18n.t(labelKey)}
                type={type}
                autoComplete="off"
                value={draft[key]}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, [key]: value }))
                }
                maxLength={256}
              />
            ))}
          </SimpleGrid>
          <Textarea
            label={i18n.t("admin.design.branding.organization.address-lines")}
            id="brand-org-address"
            value={draft.addressLines}
            onChange={(addressLines) =>
              setDraft((current) => ({ ...current, addressLines }))
            }
            rows={3}
          />
          <Group justify="flex-end">
            {dirty ? (
              <Badge tone="warning">
                {i18n.t("admin.state.unsaved-changes")}
              </Badge>
            ) : null}
            <ConfigPageSaveButtons
              dirty={dirty}
              hasFieldError={false}
              saving={busy}
              onSave={handleSave}
              onReset={() => {
                setDraft(saved);
                setSaveError(undefined);
                // Cancel disappears on commit; restore focus after that removal.
                queueMicrotask(() => identityInput.current?.focus());
              }}
            />
          </Group>
        </Stack>
      </FormFieldset>
    </Stack>
  );
}

async function parseUploadResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  return text ? { message: text } : null;
}

function extractAssetPath(payload: any, slot: SectionSlot) {
  return (
    payload?.assetPath ??
    payload?.url ??
    payload?.data?.assetPath ??
    payload?.assets?.[slot]
  );
}

function assetsBySlot(branding: AppServerBranding | null) {
  return {
    logo: getBrandingAssetPublicUrl(branding, "logo_large"),
    productMark: getBrandingAssetPublicUrl(branding, "product_mark"),
    faviconPack: getBrandingAssetPublicUrl(branding, "favicon_pack"),
  } satisfies Record<SectionSlot, string | undefined>;
}

function PreviewPair({
  src,
  emptyLabel,
  lightLabel,
  darkLabel,
  testIdRoot,
}: {
  src: string | undefined;
  emptyLabel: string;
  lightLabel: string;
  darkLabel: string;
  testIdRoot: string;
}) {
  return (
    <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
      <SettingsSection
        data-testid={`${testIdRoot}-preview-light`}
        data-admin-visual-role="authoring-preview"
        data-mantine-color-scheme="light"
        data-theme="light"
      >
        <SettingsStatusText mono>{lightLabel}</SettingsStatusText>
        <MediaPreviewFrame aspectRatio="16 / 9">
          {src ? (
            <MediaPreviewImage src={src} alt={lightLabel} />
          ) : (
            <SettingsStatusText>{emptyLabel}</SettingsStatusText>
          )}
        </MediaPreviewFrame>
      </SettingsSection>
      <SettingsSection
        data-testid={`${testIdRoot}-preview-dark`}
        data-admin-visual-role="authoring-preview"
        data-mantine-color-scheme="dark"
        data-theme="dark"
      >
        <SettingsStatusText mono>{darkLabel}</SettingsStatusText>
        <MediaPreviewFrame aspectRatio="16 / 9">
          {src ? (
            <MediaPreviewImage src={src} alt={darkLabel} />
          ) : (
            <SettingsStatusText>{emptyLabel}</SettingsStatusText>
          )}
        </MediaPreviewFrame>
      </SettingsSection>
    </ResponsiveGrid>
  );
}

export function BrandingTab({
  branding,
  organizationIdentity = null,
}: {
  branding: AppServerBranding | null;
  organizationIdentity?: OrganizationIdentityAdmin | null;
}) {
  const i18n = useI18n();
  const revalidate = useMutateQueryResource();

  const [state, setState] = useState<Record<SectionSlot, SlotState>>({
    logo: IDLE,
    productMark: IDLE,
    faviconPack: IDLE,
  });
  const uploadLocks = useRef(new Set<SectionSlot>());

  const assets = useMemo(() => assetsBySlot(branding), [branding]);

  const setSlotState = useCallback(
    (slot: SectionSlot, next: Partial<SlotState>) => {
      setState((prev) => ({ ...prev, [slot]: { ...prev[slot], ...next } }));
    },
    [],
  );

  const resolvePreviewUrl = useCallback(
    (slot: ImageSlot) => {
      if (state[slot].previewOverride) return state[slot].previewOverride;
      return assets[slot];
    },
    [assets, state],
  );

  const handleUpload = useCallback(
    async (slot: SectionSlot, file: File) => {
      if (uploadLocks.current.has(slot)) return;
      const cap = HARD_CAP_BYTES[slot];
      if (file.size > cap) {
        setSlotState(slot, {
          status: "error",
          message: i18n.t("admin.design.branding.upload.too-large", {
            max: String(cap),
          }),
        });
        return;
      }

      uploadLocks.current.add(slot);
      setSlotState(slot, {
        status: "uploading",
        message: i18n.t("admin.design.branding.upload.in-progress"),
      });

      try {
        const response = await uploadBrandingAsset({ slot, file });
        const payload = await parseUploadResponse(response);
        if (!response.ok) {
          throw new Error(
            payload?.message || `Upload failed (${response.status})`,
          );
        }
        const assetPath = extractAssetPath(payload, slot);
        const next = resolveBrandingPublicUrl(assetPath);
        const cacheBusted = next
          ? `${next}${next.includes("?") ? "&" : "?"}ts=${Date.now()}`
          : undefined;

        setSlotState(slot, {
          previewOverride: cacheBusted,
        });

        await revalidate(adminAppServerBrandingQuery, () => true);
        setSlotState(slot, {
          status: "success",
          message: i18n.t("admin.design.branding.upload.success-title"),
        });
        notifyBrandIdentityUpdated();

        notify.success({
          title: i18n.t("admin.design.branding.upload.success-title"),
          message: i18n.t("admin.design.branding.upload.success-detail"),
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : i18n.t("admin.design.branding.upload.failed");
        setSlotState(slot, { status: "error", message });
        notify.error({
          title: i18n.t("admin.design.branding.upload.failed"),
          message,
        });
      } finally {
        uploadLocks.current.delete(slot);
      }
    },
    [i18n, revalidate, setSlotState],
  );

  const logoPreview = useMemo(
    () => resolvePreviewUrl("logo"),
    [resolvePreviewUrl],
  );
  const markPreview = useMemo(
    () => resolvePreviewUrl("productMark"),
    [resolvePreviewUrl],
  );
  const faviconPreview =
    state.faviconPack.previewOverride ?? assets.faviconPack;

  return (
    <Stack data-testid="design-branding-tab">
      <OrganizationIdentitySection identity={organizationIdentity} />

      <Stack component="section" data-testid="design-branding-section-logo">
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={2}>
            {i18n.t("admin.design.branding.section.logo")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.design.branding.section.logo-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
          <UploadTarget
            data-testid="design-branding-dropzone-logo"
            title={i18n.t("admin.design.branding.dropzone.logo.title")}
            description={i18n.t("admin.design.branding.dropzone.hint")}
            pickLabel={i18n.t("admin.design.branding.dropzone.pick")}
            accept={IMAGE_ACCEPT}
            disabled={state.logo.status === "uploading"}
            onFile={(f) => void handleUpload("logo", f)}
          />
          <PreviewPair
            src={logoPreview}
            emptyLabel={i18n.t("admin.design.branding.preview.no-asset")}
            lightLabel={i18n.t("admin.design.branding.preview.light")}
            darkLabel={i18n.t("admin.design.branding.preview.dark")}
            testIdRoot="design-branding-logo"
          />
        </ResponsiveGrid>

        {state.logo.message ? <SlotMessage state={state.logo} /> : null}
      </Stack>

      <Stack
        component="section"
        data-testid="design-branding-section-product-mark"
      >
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={2}>
            {i18n.t("admin.design.branding.section.product-mark")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.design.branding.section.product-mark-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
          <UploadTarget
            data-testid="design-branding-dropzone-product-mark"
            title={i18n.t("admin.design.branding.dropzone.mark.title")}
            description={i18n.t("admin.design.branding.dropzone.hint")}
            pickLabel={i18n.t("admin.design.branding.dropzone.pick")}
            accept={IMAGE_ACCEPT}
            disabled={state.productMark.status === "uploading"}
            onFile={(f) => void handleUpload("productMark", f)}
          />
          <PreviewPair
            src={markPreview}
            emptyLabel={i18n.t("admin.design.branding.preview.no-asset")}
            lightLabel={i18n.t("admin.design.branding.preview.light")}
            darkLabel={i18n.t("admin.design.branding.preview.dark")}
            testIdRoot="design-branding-product-mark"
          />
        </ResponsiveGrid>

        {state.productMark.message ? (
          <SlotMessage state={state.productMark} />
        ) : null}
      </Stack>

      <Stack
        component="section"
        data-testid="design-branding-section-favicon-pack"
      >
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={2}>
            {i18n.t("admin.design.branding.section.favicon-pack")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.design.branding.section.favicon-pack-description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
          <UploadTarget
            data-testid="design-branding-dropzone-favicon"
            title={i18n.t("admin.design.branding.dropzone.favicon.title")}
            description={i18n.t("admin.design.branding.dropzone.hint")}
            pickLabel={i18n.t("admin.design.branding.dropzone.pick")}
            accept={ZIP_ACCEPT}
            disabled={state.faviconPack.status === "uploading"}
            onFile={(f) => void handleUpload("faviconPack", f)}
          />
          <ResponsiveGrid
            cols={{ base: 2, sm: 4, lg: 7 }}
            data-testid="design-branding-favicon-sizes"
          >
            {FAVICON_MANIFEST_SIZES.map((size) => {
              const src = faviconPublicUrlForSize(faviconPreview, size);
              return (
                <Stack
                  align="center"
                  gap="xs"
                  justify="center"
                  key={size}
                  data-admin-visual-role="authoring-preview"
                >
                  <MediaPreviewFrame aspectRatio="1">
                    {src ? (
                      <MediaPreviewImage src={src} alt={`favicon ${size}`} />
                    ) : (
                      <SettingsStatusText>-</SettingsStatusText>
                    )}
                  </MediaPreviewFrame>
                  <SettingsStatusText mono>{size}px</SettingsStatusText>
                </Stack>
              );
            })}
          </ResponsiveGrid>
        </ResponsiveGrid>

        <SettingsStatusText>
          {i18n.t("admin.design.branding.favicon-pack.note")}
        </SettingsStatusText>
        {state.faviconPack.message ? (
          <SlotMessage state={state.faviconPack} />
        ) : null}
      </Stack>
    </Stack>
  );
}

function SlotMessage({ state }: { state: SlotState }) {
  const tone =
    state.status === "error"
      ? "error"
      : state.status === "success"
        ? "active"
        : "muted";
  const message = (
    <SettingsListItemMeta tone={tone}>{state.message}</SettingsListItemMeta>
  );
  return state.status === "error" ? <div role="alert">{message}</div> : message;
}
