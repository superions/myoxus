/** Catalog metadata is read-only; document revisions are imported as files. */
import { useI18n } from "@myoxus/i18n";
import {
  Drawer,
  Group,
  MonoText,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsNotice,
} from "@myoxus/ui-facade";
import type { RefObject } from "react";

import { formatAdminDateTime } from "../../utils/locale-format";
import {
  type TemplateSource,
  TemplateSourceBadge,
  type TemplateStatus,
  TemplateStatusBadge,
} from "./badges";
import type { CatalogEntryViewModel } from "./format-adapters";
import {
  templateDisplayDescription,
  templateDisplayTags,
  templateDisplayTitle,
  translateTemplateCategory,
} from "./localized-builtins";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TemplateDetailDrawerProps {
  entry: CatalogEntryViewModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

// ---------------------------------------------------------------------------
// Read-only field helper
// ---------------------------------------------------------------------------

function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <SettingsDefinitionItem label={label}>
      {value ?? "—"}
    </SettingsDefinitionItem>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TemplateDetailDrawer({
  entry,
  open,
  onOpenChange,
  returnFocusRef,
}: TemplateDetailDrawerProps) {
  const i18n = useI18n();
  if (!entry) return null;
  const isBuiltin = entry.source === "Builtin";

  const displayTitle = templateDisplayTitle(i18n, entry);
  const displayDescription = templateDisplayDescription(i18n, entry);
  const displayTags = templateDisplayTags(i18n, entry);

  return (
    <Drawer
      returnFocusRef={returnFocusRef}
      open={open}
      onOpenChange={onOpenChange}
      title={
        <Group align="center" wrap="wrap">
          {displayTitle}
          <TemplateSourceBadge source={entry.source as TemplateSource} />
        </Group>
      }
      description={<MonoText>{entry.slug}</MonoText>}
      size={480}
    >
      {isBuiltin && (
        <SettingsNotice
          role="status"
          tone="info"
          data-myoxus-ui-role="template-builtin-notice"
        >
          {i18n.t("admin.templates.builtin-readonly-banner")}
        </SettingsNotice>
      )}

      <SettingsDefinitionList>
        <ReadOnlyField
          label={i18n.t("admin.templates.catalog.col.slug")}
          value={entry.slug}
        />
        <ReadOnlyField
          label={i18n.t("admin.templates.catalog.col.title")}
          value={displayTitle}
        />
        {displayDescription && (
          <ReadOnlyField
            label={i18n.t("admin.templates.detail.field.description")}
            value={displayDescription}
          />
        )}
        <ReadOnlyField
          label={i18n.t("admin.templates.catalog.col.category")}
          value={translateTemplateCategory(i18n, entry.category)}
        />
        <ReadOnlyField
          label={i18n.t("admin.templates.catalog.col.tags")}
          value={displayTags.length > 0 ? displayTags.join(", ") : null}
        />
        <SettingsDefinitionItem label={i18n.t("admin.common.status")}>
          <TemplateStatusBadge
            status={entry.status as unknown as TemplateStatus}
          />
        </SettingsDefinitionItem>
        <ReadOnlyField
          label={i18n.t("admin.templates.detail.field.min-client-version")}
          value={entry.minClientVersion}
        />
        <ReadOnlyField
          label={i18n.t("admin.templates.detail.field.created")}
          value={formatAdminDateTime(i18n.language, entry.createdAt)}
        />
        <ReadOnlyField
          label={i18n.t("admin.templates.detail.field.updated")}
          value={formatAdminDateTime(i18n.language, entry.updatedAt)}
        />
      </SettingsDefinitionList>
    </Drawer>
  );
}
