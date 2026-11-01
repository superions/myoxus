/**
 * @file PDF export module — visual badges for templates and ICC.
 *
 * The badges follow the Myoxus UI facade with semantic status tones. All
 * visible labels are i18n keys so the badges work in every supported locale;
 * status colours stay readable in both light and dark mode because they pull
 * from the runtime theme tokens.
 */
import { useI18n } from "@myoxus/i18n";
import { Badge } from "@myoxus/ui-facade";

// ---------------------------------------------------------------------------
// Template source badge
// ---------------------------------------------------------------------------

/**
 * `system` = no createdBy (seeded built-in: default/report/letter)
 * `admin`  = uploaded by an admin via uploadPdfTemplate
 *
 * The label mirrors the V2 architecture concept §1 (L2 templates are
 * either system-seeded or operator-uploaded — workspaces never own a
 * template directly; they enable an existing one).
 */
export type PdfTemplateSource = "system" | "admin";

export function PdfTemplateSourceBadge({
  source,
}: {
  source: PdfTemplateSource;
}) {
  const i18n = useI18n();
  if (source === "system") {
    const label = i18n.t("admin.pdf-export.source.system");
    return (
      <Badge tone="info" aria-label={label}>
        {label}
      </Badge>
    );
  }
  const label = i18n.t("admin.pdf-export.source.admin");
  return (
    <Badge tone="neutral" aria-label={label}>
      {label}
    </Badge>
  );
}

/** Active vs. soft-deleted (recovery view). */
export function PdfTemplateStatusBadge({ deleted }: { deleted: boolean }) {
  const i18n = useI18n();
  if (deleted) {
    return (
      <Badge tone="error">{i18n.t("admin.pdf-export.status.deleted")}</Badge>
    );
  }
  return (
    <Badge tone="success">{i18n.t("admin.pdf-export.status.active")}</Badge>
  );
}

// ---------------------------------------------------------------------------
// ICC profile-type badge
// ---------------------------------------------------------------------------

export type PdfIccProfileKind = "sRGB" | "CMYK";

export function PdfIccProfileTypeBadge({ kind }: { kind: PdfIccProfileKind }) {
  const i18n = useI18n();
  if (kind === "CMYK") {
    return <Badge tone="info">{i18n.t("admin.pdf-icc.type.cmyk")}</Badge>;
  }
  return <Badge tone="neutral">{i18n.t("admin.pdf-icc.type.srgb")}</Badge>;
}
