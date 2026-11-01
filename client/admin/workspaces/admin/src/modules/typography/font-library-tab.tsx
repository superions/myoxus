// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Global Typography Font Library.
 *
 * Bundled families come from the server-owned Theme Catalog. Uploaded add-ons
 * use the historical AdminRoot `pdfFont` GraphQL fields because the server
 * validates TTF/OTF material for Typst/PDF rendering before those assets can be
 * trusted by global typography. PDF Export must not own this UI.
 */
import { PdfFontLicenseStatusEnum } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CheckIcon,
  EyeIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "@myoxus/icons/react";
import {
  Badge,
  Button,
  DialogFooterActions,
  Divider,
  Drawer,
  ErrorMessage,
  FieldLabel,
  FormSelect,
  Group,
  IconButton,
  Input,
  InlineActionButton,
  Menu,
  MenuItem,
  MenuSeparator,
  MonoText,
  Modal,
  notify,
  SettingsCollectionToolbar,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsHeadingGroup,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsSectionDescription,
  SettingsSectionHeading,
  SettingsSkeleton,
  SettingsToolbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UploadTarget,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { formatAdminDateTime } from "../../utils/locale-format";
import {
  type FontAddon,
  type FontAddonDetail,
  useApproveFontAddonMutation,
  useDeleteFontAddonMutation,
  useFontAddonQuery,
  useFontAddonsQuery,
  useRejectFontAddonMutation,
  useUploadFontAddonMutation,
} from "../theme/font-addons-api";
import type { ThemeFontFamily } from "../theme/theme-contract";

export interface FontLibraryTabProps {
  fontFamilies: ThemeFontFamily[];
}

type FontLibraryStatus = "ready" | "blocked" | "incomplete";
type FontAddonStatusFilter = "all" | PdfFontLicenseStatusEnum;

const FONT_ACCEPT = ".ttf,.otf";
const FONT_EXTENSION_PATTERN = /\.(ttf|otf)$/iu;

const LICENSE_OPTIONS = [
  "auto",
  "OFL-1.1",
  "Apache-2.0",
  "MIT",
  "GPL",
  "Proprietary",
] as const;

const ADDON_STATUS_LABEL = {
  [PdfFontLicenseStatusEnum.Approved]:
    "admin.typography.font-addons.status.approved",
  [PdfFontLicenseStatusEnum.Pending]:
    "admin.typography.font-addons.status.pending",
  [PdfFontLicenseStatusEnum.Rejected]:
    "admin.typography.font-addons.status.rejected",
} as const;

const LIBRARY_STATUS_LABEL = {
  ready: "admin.typography.font-library.status.ready",
  blocked: "admin.typography.font-library.status.blocked",
  incomplete: "admin.typography.font-library.status.incomplete",
} as const;

function hasAsset(family: ThemeFontFamily, usage: "web" | "pdf") {
  return family.assets.some((asset) => asset.usage === usage);
}

function uniqueWeights(family: ThemeFontFamily) {
  return [
    ...new Set(
      family.assets.flatMap((asset) => [asset.weightMin, asset.weightMax]),
    ),
  ]
    .filter((weight) => Number.isFinite(weight))
    .sort((a, b) => a - b);
}

function libraryStatus(family: ThemeFontFamily): FontLibraryStatus {
  if (!hasAsset(family, "web") || !hasAsset(family, "pdf")) {
    return "incomplete";
  }
  if (!family.isSelectable || family.licenseStatus !== "approved") {
    return "blocked";
  }
  return "ready";
}

function statusTone(status: FontLibraryStatus) {
  switch (status) {
    case "ready":
      return "success";
    case "blocked":
      return "warning";
    case "incomplete":
      return "error";
  }
}

function addonStatusTone(status: PdfFontLicenseStatusEnum) {
  switch (status) {
    case PdfFontLicenseStatusEnum.Approved:
      return "success";
    case PdfFontLicenseStatusEnum.Pending:
      return "warning";
    case PdfFontLicenseStatusEnum.Rejected:
      return "error";
  }
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeFontValidationError(
  message: string,
  t: (key: string) => string,
): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("woff") ||
    lower.includes("woff2") ||
    lower.includes("ttf or otf") ||
    lower.includes("not supported")
  ) {
    return t("admin.typography.font-addons.validation.extension");
  }
  if (lower.includes("too large") || lower.includes("max")) {
    return t("admin.typography.font-addons.validation.too-large");
  }
  if (lower.includes("already") || lower.includes("duplicate")) {
    return t("admin.typography.font-addons.validation.duplicate");
  }
  if (lower.includes("license")) {
    return t("admin.typography.font-addons.validation.license");
  }
  return message;
}

function formatDate(
  language: string | undefined,
  value: string | null | undefined,
) {
  return value ? formatAdminDateTime(language, value) : "-";
}

function ThemeCatalogSection({
  fontFamilies,
  actions,
}: FontLibraryTabProps & {
  actions: ReactNode;
}) {
  const i18n = useI18n();
  const [search, setSearch] = useState("");
  const filteredFamilies = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(i18n.language);
    return fontFamilies.filter((family) =>
      [family.displayName, family.cssFamily, family.slug, family.licenseSpdx]
        .join(" ")
        .toLocaleLowerCase(i18n.language)
        .includes(needle),
    );
  }, [fontFamilies, search, i18n.language]);
  const readyCount = fontFamilies.filter(
    (family) => libraryStatus(family) === "ready",
  ).length;
  const bundledCount = fontFamilies.filter(
    (family) => family.source === "bundled",
  ).length;
  const uploadedCount = fontFamilies.filter(
    (family) => family.source === "uploaded",
  ).length;

  return (
    <Stack
      component="section"
      aria-label={i18n.t("admin.typography.font-library.title")}
    >
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={2}>
          {i18n.t("admin.typography.font-library.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.typography.font-library.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <SettingsCollectionToolbar
        search={
          <Input
            aria-label={i18n.t(
              "com.myoxus.settings.editorSettings.general.font-family.search.placeholder",
            )}
            placeholder={i18n.t(
              "com.myoxus.settings.editorSettings.general.font-family.search.placeholder",
            )}
            value={search}
            onChange={setSearch}
            preFix={<SearchIcon aria-hidden />}
            data-testid="font-library-search"
          />
        }
        actions={
          <>
            {search ? (
              <IconButton
                aria-label={i18n.t("admin.actions.clear")}
                tooltip={i18n.t("admin.actions.clear")}
                icon={<XIcon aria-hidden />}
                onClick={() => setSearch("")}
              />
            ) : null}
            {actions}
          </>
        }
      />
      <Group>
        {(
          [
            [
              "total",
              "admin.typography.font-library.summary.total",
              fontFamilies.length,
            ],
            [
              "ready",
              "admin.typography.font-library.summary.ready",
              readyCount,
            ],
            [
              "bundled",
              "admin.typography.font-library.summary.bundled",
              bundledCount,
            ],
            [
              "uploaded",
              "admin.typography.font-library.summary.uploaded",
              uploadedCount,
            ],
          ] as const
        ).map(([key, label, value]) => (
          <SettingsListItemMeta
            key={key}
            data-testid={`font-library-summary-${key}`}
          >
            {i18n.t(label)}:{" "}
            {new Intl.NumberFormat(i18n.language).format(value)}
          </SettingsListItemMeta>
        ))}
      </Group>

      {fontFamilies.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.typography.font-library.empty-message")}
        />
      ) : filteredFamilies.length === 0 ? (
        <SettingsEmptyState title={i18n.t("admin.common.no-results-found")} />
      ) : (
        <Table aria-label={i18n.t("admin.typography.font-library.title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{i18n.t("admin.typography.field.family")}</TableHead>
              <TableHead>
                {i18n.t("admin.typography.font-library.label.source")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.typography.font-library.label.license")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.typography.font-library.label.assets")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.typography.font-library.label.weights")}
              </TableHead>
              <TableHead>{i18n.t("admin.common.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredFamilies.map((family) => {
              const status = libraryStatus(family);
              const webAsset = hasAsset(family, "web");
              const pdfAsset = hasAsset(family, "pdf");
              const weights = uniqueWeights(family);
              return (
                <TableRow
                  key={family.slug}
                  data-testid={`font-library-family-${family.slug}`}
                >
                  <TableCell>
                    <SettingsListItemTitle
                      data-admin-visual-role="authoring-preview"
                      previewFontFamily={`${JSON.stringify(family.cssFamily)}, ${family.genericClass}`}
                    >
                      {family.displayName}
                    </SettingsListItemTitle>
                    <SettingsListItemMeta>{family.slug}</SettingsListItemMeta>
                  </TableCell>
                  <TableCell>
                    {family.source === "bundled"
                      ? i18n.t("admin.typography.font-library.summary.bundled")
                      : family.source === "uploaded"
                        ? i18n.t(
                            "admin.typography.font-library.summary.uploaded",
                          )
                        : family.source}
                  </TableCell>
                  <TableCell>
                    {family.licenseSpdx}
                    <SettingsListItemMeta>
                      {family.licenseStatus === "approved"
                        ? i18n.t("admin.typography.font-addons.status.approved")
                        : family.licenseStatus === "rejected"
                          ? i18n.t(
                              "admin.typography.font-addons.status.rejected",
                            )
                          : family.licenseStatus === "pending"
                            ? i18n.t(
                                "admin.typography.font-addons.status.pending",
                              )
                            : family.licenseStatus}
                    </SettingsListItemMeta>
                  </TableCell>
                  <TableCell>
                    <Group>
                      <SettingsListItemMeta>
                        {family.assets.length}
                      </SettingsListItemMeta>
                      <Badge tone={webAsset ? "success" : "error"}>
                        {webAsset ? "✓ " : "× "}
                        {i18n.t("admin.typography.font-library.asset.web")}
                      </Badge>
                      <Badge tone={pdfAsset ? "success" : "error"}>
                        {pdfAsset ? "✓ " : "× "}
                        {i18n.t("admin.typography.font-library.asset.pdf")}
                      </Badge>
                      {!family.isSelectable ? (
                        <Badge tone="error">
                          {i18n.t(
                            "admin.typography.font-library.asset.not-selectable",
                          )}
                        </Badge>
                      ) : null}
                    </Group>
                  </TableCell>
                  <TableCell>
                    <MonoText>
                      {weights.length ? weights.join(", ") : "-"}
                    </MonoText>
                  </TableCell>
                  <TableCell>
                    <Badge tone={statusTone(status)}>
                      {i18n.t(LIBRARY_STATUS_LABEL[status])}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

function UploadFontAddonDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const i18n = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [license, setLicense] =
    useState<(typeof LICENSE_OPTIONS)[number]>("auto");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const upload = useUploadFontAddonMutation();

  const pickFile = useCallback(
    (nextFile: File | null) => {
      setValidationError(null);
      if (!nextFile) {
        setFile(null);
        return;
      }
      if (!FONT_EXTENSION_PATTERN.test(nextFile.name)) {
        setValidationError(
          i18n.t("admin.typography.font-addons.validation.extension"),
        );
        setFile(null);
        return;
      }
      setFile(nextFile);
    },
    [i18n],
  );

  const handleSubmit = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setValidationError(null);
    try {
      await upload.uploadFontAddon({
        file,
        license: license === "auto" ? null : license,
      });
      notify.success({
        title: i18n.t("admin.typography.font-addons.upload.completed"),
      });
      onUploaded();
    } catch (err) {
      const friendly = normalizeFontValidationError(
        rawErrorMessage(err),
        i18n.t,
      );
      setValidationError(friendly);
      notify.error({
        title: `${i18n.t("admin.typography.font-addons.upload.failed")}: ${friendly}`,
      });
    } finally {
      setUploading(false);
    }
  }, [file, i18n, license, onUploaded, upload]);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t("admin.typography.font-addons.upload.title")}
      description={i18n.t("admin.typography.font-addons.upload.description")}
    >
      <Stack>
        <SettingsNotice tone="neutral">
          {i18n.t("admin.typography.font-addons.upload.server-validation")}
        </SettingsNotice>
        <UploadTarget
          title={
            file?.name ?? i18n.t("admin.typography.font-addons.upload.dropzone")
          }
          description={i18n.t(
            "admin.typography.font-addons.upload.format-hint",
          )}
          pickLabel={i18n.t("admin.typography.font-addons.upload.pick-file")}
          accept={FONT_ACCEPT}
          disabled={uploading}
          data-testid="font-addons-upload-dropzone"
          onFiles={(selected) => pickFile(selected[0] ?? null)}
        />
        <FormSelect
          id="font-addons-license"
          label={i18n.t("admin.typography.font-addons.upload.license")}
          value={license}
          onChange={(value) =>
            setLicense((value ?? "auto") as (typeof LICENSE_OPTIONS)[number])
          }
          data={LICENSE_OPTIONS.map((value) => ({
            value,
            label:
              value === "auto"
                ? i18n.t("admin.typography.font-addons.upload.license-auto")
                : value,
          }))}
          disabled={uploading}
        />
        {validationError ? (
          <SettingsNotice tone="error">{validationError}</SettingsNotice>
        ) : null}
        <Divider />
        <DialogFooterActions>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>
            {i18n.t("admin.common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            variant="primary"
            disabled={!file || uploading}
            prefix={<UploadIcon aria-hidden />}
            data-testid="font-addons-upload-submit"
          >
            {uploading
              ? i18n.t("admin.typography.font-addons.upload.uploading")
              : i18n.t("admin.typography.font-addons.upload.button")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}

function RejectFontAddonDialog({
  addon,
  onClose,
  onRejected,
}: {
  addon: FontAddon;
  onClose: () => void;
  onRejected: () => void;
}) {
  const i18n = useI18n();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reject = useRejectFontAddonMutation();

  const handleReject = useCallback(async () => {
    if (!reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await reject.rejectFontAddon({ id: addon.id, reason: reason.trim() });
      notify.success({
        title: i18n.t("admin.typography.font-addons.reject.completed"),
      });
      onRejected();
    } catch (err) {
      const message = rawErrorMessage(err);
      setError(message);
      notify.error({
        title: `${i18n.t("admin.typography.font-addons.reject.failed")}: ${message}`,
      });
    } finally {
      setSaving(false);
    }
  }, [addon.id, i18n, onRejected, reason, reject]);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t("admin.typography.font-addons.reject.title")}
      description={i18n.t("admin.typography.font-addons.reject.description")}
    >
      <Stack>
        <SettingsNotice tone="warning">
          {addon.familyName} · {addon.style} · {addon.weight}
        </SettingsNotice>
        <Stack>
          <FieldLabel htmlFor="font-addons-reject-reason">
            {i18n.t("admin.typography.font-addons.reject.reason")}
          </FieldLabel>
          <Textarea
            id="font-addons-reject-reason"
            value={reason}
            onChange={setReason}
            minRows={4}
            disabled={saving}
          />
        </Stack>
        {error ? <ErrorMessage role="alert">{error}</ErrorMessage> : null}
        <SettingsToolbar>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {i18n.t("admin.common.cancel")}
          </Button>
          <Button
            variant="error"
            prefix={<XIcon aria-hidden />}
            onClick={handleReject}
            disabled={!reason.trim() || saving}
          >
            {i18n.t("admin.typography.font-addons.reject.button")}
          </Button>
        </SettingsToolbar>
      </Stack>
    </Modal>
  );
}

function FontAddonDetailDrawer({
  addonId,
  onClose,
}: {
  addonId: string | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const query = useFontAddonQuery(addonId);
  const addon = query.fontAddon;

  return (
    <Drawer
      open={Boolean(addonId)}
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t("admin.typography.font-addons.detail.title")}
      description={i18n.t("admin.typography.font-addons.detail.description")}
    >
      {query.isLoading ? (
        <SettingsSkeleton />
      ) : query.error ? (
        <ErrorMessage role="alert">{rawErrorMessage(query.error)}</ErrorMessage>
      ) : addon ? (
        <FontAddonDetailContent addon={addon} />
      ) : (
        <SettingsEmptyState
          title={i18n.t("admin.typography.font-addons.detail.unavailable")}
        />
      )}
    </Drawer>
  );
}

function FontAddonDetailContent({ addon }: { addon: FontAddonDetail }) {
  const i18n = useI18n();

  return (
    <Stack>
      <SettingsDetailHeader
        title={addon.familyName}
        description={`${addon.style} · ${addon.weight}`}
        headingLevel={2}
        actions={
          <Badge tone={addonStatusTone(addon.licenseStatus)}>
            {i18n.t(ADDON_STATUS_LABEL[addon.licenseStatus])}
          </Badge>
        }
      />
      <SettingsDefinitionList>
        <SettingsDefinitionItem
          label={i18n.t("admin.typography.font-addons.field.license")}
        >
          {addon.license}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.typography.font-addons.field.sha256")}
        >
          {addon.sha256}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.typography.font-addons.field.uploaded-by")}
        >
          {addon.uploadedBy ?? "-"}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.typography.font-addons.field.uploaded-at")}
        >
          {formatDate(i18n.language, addon.uploadedAt)}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.typography.font-addons.field.approved-by")}
        >
          {addon.approvedBy ?? "-"}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.typography.font-addons.field.approved-at")}
        >
          {formatDate(i18n.language, addon.approvedAt)}
        </SettingsDefinitionItem>
      </SettingsDefinitionList>
    </Stack>
  );
}

function FontAddonRow({
  addon,
  busy,
  onApprove,
  onReject,
  onDelete,
  onInspect,
}: {
  addon: FontAddon;
  busy: boolean;
  onApprove: (addon: FontAddon) => void;
  onReject: (addon: FontAddon) => void;
  onDelete: (addon: FontAddon) => void;
  onInspect: (addon: FontAddon) => void;
}) {
  const i18n = useI18n();
  const approved = addon.licenseStatus === PdfFontLicenseStatusEnum.Approved;
  const rejected = addon.licenseStatus === PdfFontLicenseStatusEnum.Rejected;

  return (
    <TableRow data-testid={`font-addon-${addon.id}`}>
      <TableCell>
        <SettingsListItemTitle>
          <InlineActionButton onClick={() => onInspect(addon)}>
            {addon.familyName}
          </InlineActionButton>
        </SettingsListItemTitle>
        <SettingsListItemMeta>{addon.sha256.slice(0, 12)}</SettingsListItemMeta>
      </TableCell>
      <TableCell>
        {addon.style} · {addon.weight}
      </TableCell>
      <TableCell>{addon.license}</TableCell>
      <TableCell>{formatDate(i18n.language, addon.uploadedAt)}</TableCell>
      <TableCell>
        <Badge tone={addonStatusTone(addon.licenseStatus)}>
          {i18n.t(ADDON_STATUS_LABEL[addon.licenseStatus])}
        </Badge>
      </TableCell>
      <TableCell>
        <Menu
          contentOptions={{ align: "end" }}
          items={
            <>
              <MenuItem
                prefixIcon={<EyeIcon aria-hidden />}
                onSelect={() => onInspect(addon)}
              >
                {i18n.t("admin.typography.font-addons.detail.button")}
              </MenuItem>
              <MenuItem
                prefixIcon={<CheckIcon aria-hidden />}
                onSelect={() => onApprove(addon)}
                disabled={busy || approved}
              >
                {i18n.t("admin.typography.font-addons.approve.button")}
              </MenuItem>
              <MenuItem
                prefixIcon={<XIcon aria-hidden />}
                onSelect={() => onReject(addon)}
                disabled={busy || rejected}
              >
                {i18n.t("admin.typography.font-addons.reject.button")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                type="danger"
                prefixIcon={<TrashIcon aria-hidden />}
                onSelect={() => onDelete(addon)}
                disabled={busy}
              >
                {i18n.t("admin.common.delete")}
              </MenuItem>
            </>
          }
        >
          <IconButton
            aria-label={i18n.t("admin.common.actions")}
            tooltip={i18n.t("admin.common.actions")}
            icon={<MoreHorizontalIcon aria-hidden />}
          />
        </Menu>
      </TableCell>
    </TableRow>
  );
}

function FontAddonsSection({
  query,
  onRefresh,
}: {
  query: ReturnType<typeof useFontAddonsQuery>;
  onRefresh: () => void;
}) {
  const i18n = useI18n();
  const approve = useApproveFontAddonMutation();
  const remove = useDeleteFontAddonMutation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<FontAddonStatusFilter>("all");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<FontAddon | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FontAddon | null>(null);

  const fontAddons = query.fontAddons;
  const filteredAddons = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return fontAddons.filter((addon) => {
      const statusMatches =
        statusFilter === "all" || addon.licenseStatus === statusFilter;
      if (!statusMatches) return false;
      if (!needle) return true;
      return [
        addon.familyName,
        addon.style,
        addon.license,
        addon.sha256,
        addon.uploadedBy ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [fontAddons, search, statusFilter]);

  const counts = useMemo(
    () => ({
      total: fontAddons.length,
      pending: fontAddons.filter(
        (addon) => addon.licenseStatus === PdfFontLicenseStatusEnum.Pending,
      ).length,
      approved: fontAddons.filter(
        (addon) => addon.licenseStatus === PdfFontLicenseStatusEnum.Approved,
      ).length,
      rejected: fontAddons.filter(
        (addon) => addon.licenseStatus === PdfFontLicenseStatusEnum.Rejected,
      ).length,
    }),
    [fontAddons],
  );

  const handleApprove = useCallback(
    async (addon: FontAddon) => {
      try {
        await approve.approveFontAddon(addon.id);
        notify.success({
          title: i18n.t("admin.typography.font-addons.approve.completed"),
        });
        onRefresh();
      } catch (err) {
        notify.error({
          title: `${i18n.t("admin.typography.font-addons.approve.failed")}: ${rawErrorMessage(err)}`,
        });
      }
    },
    [approve, onRefresh, i18n],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await remove.deleteFontAddon(deleteTarget.id);
      notify.success({
        title: i18n.t("admin.typography.font-addons.delete.completed"),
      });
      setDeleteTarget(null);
      onRefresh();
    } catch (err) {
      notify.error({
        title: `${i18n.t("admin.typography.font-addons.delete.failed")}: ${rawErrorMessage(err)}`,
      });
    }
  }, [deleteTarget, onRefresh, i18n, remove]);

  const statusOptions = [
    { value: "all", label: i18n.t("admin.typography.font-addons.filter.all") },
    {
      value: PdfFontLicenseStatusEnum.Pending,
      label: i18n.t("admin.typography.font-addons.status.pending"),
    },
    {
      value: PdfFontLicenseStatusEnum.Approved,
      label: i18n.t("admin.typography.font-addons.status.approved"),
    },
    {
      value: PdfFontLicenseStatusEnum.Rejected,
      label: i18n.t("admin.typography.font-addons.status.rejected"),
    },
  ];

  const busy = approve.isMutating || remove.isMutating;

  return (
    <>
      <Stack
        component="section"
        aria-label={i18n.t("admin.typography.font-addons.title")}
      >
        <SettingsHeadingGroup>
          <SettingsSectionHeading level={2}>
            {i18n.t("admin.typography.font-addons.title")}
          </SettingsSectionHeading>
          <SettingsSectionDescription>
            {i18n.t("admin.typography.font-addons.description")}
          </SettingsSectionDescription>
        </SettingsHeadingGroup>
        <SettingsListItemMeta>
          {i18n.t("admin.typography.font-addons.ttfotf-only")}
        </SettingsListItemMeta>
        <Group>
          {(
            [
              ["total", "admin.typography.font-addons.summary.total"],
              ["pending", "admin.typography.font-addons.summary.pending"],
              ["approved", "admin.typography.font-addons.summary.approved"],
              ["rejected", "admin.typography.font-addons.summary.rejected"],
            ] as const
          ).map(([key, label]) => (
            <SettingsListItemMeta
              key={key}
              data-testid={`font-addons-summary-${key}`}
            >
              {i18n.t(label)}:{" "}
              {new Intl.NumberFormat(i18n.language).format(counts[key])}
            </SettingsListItemMeta>
          ))}
        </Group>

        <SettingsCollectionToolbar
          search={
            <Input
              id="font-addons-search"
              aria-label={i18n.t("admin.typography.font-addons.filter.query")}
              placeholder={i18n.t("admin.typography.font-addons.filter.query")}
              value={search}
              onChange={setSearch}
              preFix={<SearchIcon aria-hidden />}
            />
          }
          filters={
            <FormSelect
              id="font-addons-status"
              aria-label={i18n.t("admin.typography.font-addons.filter.status")}
              value={statusFilter}
              onChange={(value) =>
                setStatusFilter((value ?? "all") as FontAddonStatusFilter)
              }
              data={statusOptions}
            />
          }
          actions={
            <IconButton
              aria-label={i18n.t("admin.actions.refresh")}
              tooltip={i18n.t("admin.actions.refresh")}
              icon={<RefreshCwIcon aria-hidden />}
              onClick={onRefresh}
            />
          }
        />

        {query.isLoading ? (
          <SettingsSkeleton />
        ) : query.error ? (
          <ErrorMessage role="alert">
            {rawErrorMessage(query.error)}
          </ErrorMessage>
        ) : filteredAddons.length === 0 ? (
          <SettingsEmptyState
            title={i18n.t("admin.typography.font-addons.list.no-matches")}
          />
        ) : (
          <Table aria-label={i18n.t("admin.typography.font-addons.title")}>
            <TableHeader>
              <TableRow>
                <TableHead>{i18n.t("admin.typography.field.family")}</TableHead>
                <TableHead>
                  {i18n.t("admin.typography.field.font-style")} /{" "}
                  {i18n.t("admin.typography.field.weight")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.typography.font-addons.field.license")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.typography.font-addons.field.uploaded-at")}
                </TableHead>
                <TableHead>{i18n.t("admin.common.status")}</TableHead>
                <TableHead>{i18n.t("admin.common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAddons.map((addon) => (
                <FontAddonRow
                  key={addon.id}
                  addon={addon}
                  busy={busy}
                  onApprove={handleApprove}
                  onReject={setRejectTarget}
                  onDelete={setDeleteTarget}
                  onInspect={(nextAddon) => setInspectId(nextAddon.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>
      {rejectTarget ? (
        <RejectFontAddonDialog
          addon={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onRejected={() => {
            setRejectTarget(null);
            onRefresh();
          }}
        />
      ) : null}
      <FontAddonDetailDrawer
        addonId={inspectId}
        onClose={() => setInspectId(null)}
      />
      <AdminConfirmModal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={i18n.t("admin.typography.font-addons.delete.title")}
        description={i18n.t("admin.typography.font-addons.delete.description")}
        confirmText={i18n.t("admin.common.delete")}
        danger
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </>
  );
}

export function FontLibraryTab({ fontFamilies }: FontLibraryTabProps) {
  const i18n = useI18n();
  const query = useFontAddonsQuery();
  const { mutate } = query;
  const [uploadOpen, setUploadOpen] = useState(false);
  // One query owns add-on refreshes from the inventory toolbar and mutations.
  const handleRefresh = useCallback(() => {
    void mutate();
  }, [mutate]);
  return (
    <Stack data-testid="font-library-tab">
      <ThemeCatalogSection
        fontFamilies={fontFamilies}
        actions={
          <>
            <Button
              prefix={<UploadIcon aria-hidden />}
              onClick={() => setUploadOpen(true)}
              data-testid="font-addons-upload-open"
            >
              {i18n.t("admin.typography.font-addons.upload.button")}
            </Button>
          </>
        }
      />
      <FontAddonsSection query={query} onRefresh={handleRefresh} />
      {uploadOpen ? (
        <UploadFontAddonDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            handleRefresh();
          }}
        />
      ) : null}
    </Stack>
  );
}
