/**
 * @file PDF export module — ICC Color Profiles tab.
 *
 * Manages the ICC color-profile library used for L1 brand-color
 * management in PDFs (sRGB / CMYK FOGRA39 / CMYK SWOP). System-seeded
 * profiles (e.g. bundled sRGB/CMYK profiles) are read-only; admin uploads
 * can be deleted.
 *
 * Server contract:
 *  - GraphQL query: `pdfIccProfiles`
 *  - Mutations: `uploadIccProfile`, `deleteIccProfile`
 *  - Resolver: `crates/api/src/graphql/pdf_icc.rs`
 */
import { PdfIccProfileTypeEnum } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { TrashIcon, UploadIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  DialogFooterActions,
  Divider,
  FormSelect,
  Group,
  Input,
  Modal,
  notify,
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  IconButton,
  MonoText,
  MyoxusText,
  SettingsNotice,
  Skeleton,
  Stack,
  UploadTarget,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { formatAdminDateTime } from "../../../utils/locale-format";
import {
  useDeleteIccProfileMutation,
  usePdfIccProfilesQuery,
  useUploadIccProfileMutation,
} from "../api";
import { PdfIccProfileTypeBadge } from "../badges";
import {
  adaptPdfIccProfile,
  type PdfIccProfileViewModel,
} from "../format-adapters";
import { logPdfExportUiEvent } from "../logging";
import { EmptyState as RoleEmptyState } from "../pdf-role-primitives";

// ---------------------------------------------------------------------------
// Error mapping + upload helpers
// ---------------------------------------------------------------------------

const ICC_ACCEPT = ".icc,.icm";
const ICC_EXTENSION_PATTERN = /\.(icc|icm)$/i;

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeIccValidationError(
  message: string,
  t: (key: string) => string,
): string {
  const lower = message.toLowerCase();
  if (lower.includes("profile-class") && lower.includes("display")) {
    return t("admin.pdf-icc.validation.profile-class-display");
  }
  if (lower.includes("profile-class") && lower.includes("output")) {
    return t("admin.pdf-icc.validation.profile-class-output-required");
  }
  if (lower.includes("not an icc") || lower.includes("invalid icc")) {
    return t("admin.pdf-icc.validation.invalid-icc");
  }
  if (lower.includes("too large") || lower.includes("max")) {
    return t("admin.pdf-icc.validation.too-large");
  }
  if (lower.includes("srgb") && lower.includes("cmyk")) {
    return t("admin.pdf-icc.validation.type-mismatch");
  }
  return message;
}

function formatDate(value: string, language: string | undefined): string {
  return formatAdminDateTime(language, value);
}

// ---------------------------------------------------------------------------
// Upload dialog
// ---------------------------------------------------------------------------

function UploadDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const i18n = useI18n();
  const [name, setName] = useState("");
  const [profileType, setProfileType] = useState<PdfIccProfileTypeEnum>(
    PdfIccProfileTypeEnum.sRGB,
  );
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const upload = useUploadIccProfileMutation();

  const pickFile = useCallback(
    (nextFile: File | null) => {
      setValidationError(null);
      if (!nextFile) {
        setFile(null);
        return;
      }
      if (!ICC_EXTENSION_PATTERN.test(nextFile.name)) {
        const message = i18n.t("admin.pdf-icc.validation.extension");
        setValidationError(message);
        logPdfExportUiEvent(
          "icc.upload.rejected-client-validation",
          { fileName: nextFile.name },
          "warn",
        );
        return;
      }
      setFile(nextFile);
    },
    [i18n],
  );

  const handleSubmit = useCallback(async () => {
    if (!file || !name.trim()) return;
    setUploading(true);
    setValidationError(null);
    try {
      logPdfExportUiEvent("icc.upload.started", {
        name: name.trim(),
        profileType,
        fileName: file.name,
        size: file.size,
      });
      await upload.trigger({ name: name.trim(), profileType, file });
      logPdfExportUiEvent("icc.upload.completed", {
        name: name.trim(),
        profileType,
      });
      notify.success({ title: i18n.t("admin.pdf-icc.upload.success") });
      onUploaded();
    } catch (err) {
      const raw = rawErrorMessage(err);
      const friendly = normalizeIccValidationError(raw, i18n.t);
      setValidationError(friendly);
      logPdfExportUiEvent(
        "icc.upload.failed",
        { name: name.trim(), profileType, message: raw },
        "error",
      );
      notify.error({
        title: `${i18n.t("admin.pdf-icc.upload.failed")}: ${friendly}`,
      });
    } finally {
      setUploading(false);
    }
  }, [file, name, profileType, upload, onUploaded, i18n]);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={i18n.t("admin.pdf-icc.upload.title")}
      description={i18n.t("admin.pdf-icc.upload.description")}
    >
      <Stack>
        <Input
          id="pdf-icc-name"
          label={i18n.t("admin.pdf-icc.upload.name")}
          value={name}
          onChange={setName}
          maxLength={120}
          placeholder="FOGRA39 (CMYK)"
          disabled={uploading}
        />
        <FormSelect
          id="pdf-icc-type"
          label={i18n.t("admin.pdf-icc.upload.type")}
          value={profileType}
          onChange={(value) => setProfileType(value as PdfIccProfileTypeEnum)}
          data={[
            { value: PdfIccProfileTypeEnum.sRGB, label: "sRGB" },
            { value: PdfIccProfileTypeEnum.CMYK, label: "CMYK" },
          ]}
        />
        <UploadTarget
          title={file?.name ?? i18n.t("admin.pdf-icc.upload.dropzone")}
          description={i18n.t("admin.pdf-icc.upload.format-hint")}
          pickLabel={i18n.t("admin.pdf-icc.upload.pick-file")}
          accept={ICC_ACCEPT}
          disabled={uploading}
          data-testid="pdf-icc-upload-dropzone"
          onFiles={(selected) => pickFile(selected[0] ?? null)}
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
            disabled={!file || !name.trim() || uploading}
            prefix={<UploadIcon aria-hidden />}
          >
            {uploading
              ? i18n.t("admin.pdf-icc.upload.uploading")
              : i18n.t("admin.pdf-icc.upload.button")}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Inner content
// ---------------------------------------------------------------------------

function IccProfilesTabContent() {
  const i18n = useI18n();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<PdfIccProfileViewModel | null>(null);
  const query = usePdfIccProfilesQuery();
  const remove = useDeleteIccProfileMutation();

  const profiles = (query.profiles ?? []).map(adaptPdfIccProfile);

  const handleRefresh = useCallback(() => {
    void query.mutate();
  }, [query]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      logPdfExportUiEvent("icc.delete.confirmed", {
        profileId: deleteTarget.id,
        name: deleteTarget.name,
      });
      await remove.trigger({ id: deleteTarget.id });
      notify.success({ title: i18n.t("admin.pdf-icc.delete.success") });
      setDeleteTarget(null);
      handleRefresh();
    } catch (err) {
      const msg = rawErrorMessage(err);
      logPdfExportUiEvent(
        "icc.delete.failed",
        { profileId: deleteTarget.id, message: msg },
        "error",
      );
      notify.error({
        title: `${i18n.t("admin.pdf-icc.delete.failed")}: ${msg}`,
      });
    }
  }, [deleteTarget, remove, handleRefresh, i18n]);

  return (
    <>
      <Stack>
        <Group justify="flex-end">
          <Button
            onClick={() => setUploadOpen(true)}
            prefix={<UploadIcon aria-hidden />}
          >
            {i18n.t("admin.pdf-icc.upload.button")}
          </Button>
        </Group>
        <SettingsNotice tone="neutral">
          {i18n.t("admin.pdf-icc.system-default-hint")}
        </SettingsNotice>
        {profiles.length === 0 ? (
          <RoleEmptyState title={i18n.t("admin.pdf-icc.list.empty")} />
        ) : (
          <Table aria-label={i18n.t("admin.pdf-icc.list.aria-label")}>
            <TableHeader>
              <TableRow>
                <TableHead>{i18n.t("admin.pdf-icc.column.name")}</TableHead>
                <TableHead>{i18n.t("admin.pdf-icc.column.type")}</TableHead>
                <TableHead>{i18n.t("admin.pdf-icc.column.sha256")}</TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-icc.column.uploaded-by")}
                </TableHead>
                <TableHead>
                  {i18n.t("admin.pdf-icc.column.uploaded-at")}
                </TableHead>
                <TableHead>{i18n.t("admin.pdf-jobs.column.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Stack>
                      <MyoxusText>{p.name}</MyoxusText>
                      {p.isSystem ? (
                        <Badge tone="neutral">
                          {i18n.t("admin.pdf-icc.system-seeded")}
                        </Badge>
                      ) : null}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <PdfIccProfileTypeBadge kind={p.profileType} />
                  </TableCell>
                  <TableCell>
                    <MonoText>{p.sha256.slice(0, 16)}...</MonoText>
                  </TableCell>
                  <TableCell>{p.uploadedBy ?? "-"}</TableCell>
                  <TableCell>
                    {formatDate(p.uploadedAt, i18n.language)}
                  </TableCell>
                  <TableCell>
                    {p.isSystem ? null : (
                      <IconButton
                        variant="destructive"
                        tooltip={i18n.t("admin.pdf-icc.action.delete")}
                        onClick={() => setDeleteTarget(p)}
                      >
                        <TrashIcon aria-hidden />
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>

      {uploadOpen ? (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            setUploadOpen(false);
            handleRefresh();
          }}
        />
      ) : null}

      <AdminConfirmModal
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={i18n.t("admin.pdf-icc.delete.title")}
        description={i18n
          .t("admin.pdf-icc.delete.description")
          .replace("{name}", deleteTarget?.name ?? "")}
        cancelText={i18n.t("admin.common.cancel")}
        confirmText={i18n.t("admin.pdf-icc.action.delete")}
        danger
        onConfirm={handleDelete}
      />
    </>
  );
}

/** Render the ICC profile admin table behind the shared Suspense boundary. */
export function IccProfilesTab() {
  return (
    <Suspense fallback={<Skeleton h={256} />}>
      <IccProfilesTabContent />
    </Suspense>
  );
}
