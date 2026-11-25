/**
 * Templates — Archive tab.
 *
 * Displays archived templates filtered from the catalog with a "Restore"
 * action that sets the template status back to Active.
 */
import { TemplateStatusType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ArchiveRestoreIcon } from "@myoxus/icons/react";
import {
  Button,
  Group,
  MetricStack,
  MonoText,
  notify,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSkeleton,
  SettingsStatusText,
  Stack,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
} from "@myoxus/ui-facade";
import { Suspense, useCallback } from "react";

import {
  enableTemplate,
  useTemplateCatalogQuery,
  useTemplateRegistryRevalidate,
} from "./api";
import { TemplateStatusBadge } from "./badges";
import { withTemplateErrorContext } from "./error-utils";
import {
  templateDisplayDescription,
  templateDisplayTitle,
  translateTemplateCategory,
} from "./localized-builtins";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ArchiveSkeleton() {
  return <SettingsSkeleton />;
}

// ---------------------------------------------------------------------------
// Content (inside Suspense)
// ---------------------------------------------------------------------------

function ArchiveContent() {
  const i18n = useI18n();
  const { entries, totalCount } = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
    status: TemplateStatusType.Archived,
  });
  const { revalidateCatalog } = useTemplateRegistryRevalidate();

  const handleRefresh = useCallback(() => {
    revalidateCatalog();
  }, [revalidateCatalog]);

  const handleRestore = useCallback(
    async (entry: {
      id: string;
      title: string;
      slug: string;
      source: string;
    }) => {
      try {
        await enableTemplate(entry.id);
        notify.success({
          title: i18n.t("admin.templates.archive.toast.restored", {
            title: templateDisplayTitle(i18n, entry),
          }),
        });
        handleRefresh();
      } catch (e: unknown) {
        notify.error({
          title: withTemplateErrorContext(
            i18n.t("admin.templates.archive.toast.restore-failed"),
            e,
          ),
        });
      }
    },

    [handleRefresh, i18n],
  );

  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={i18n.t("admin.templates.archive.title")}
        description={i18n.t("admin.templates.archive.description", {
          count: totalCount,
        })}
        actions={
          <MetricStack
            rows={[
              {
                label: i18n.t("admin.templates.archive.metric.count"),
                value: totalCount,
              },
            ]}
          />
        }
        headingLevel={2}
      />
      {entries.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.templates.archive.empty")}
          description={i18n.t("admin.templates.archive.empty-hint")}
        />
      ) : (
        <SurfaceList data-testid="templates-archive-soft-list">
          {entries.map((entry: any) => {
            const displayTitle = templateDisplayTitle(i18n, entry);
            const displayDescription = templateDisplayDescription(i18n, entry);

            return (
              <SurfaceListItem key={entry.id}>
                <Group align="flex-start" justify="space-between" wrap="wrap">
                  <SurfaceListItemMain grow>
                    <SettingsListItemTitle truncate>
                      {displayTitle}
                    </SettingsListItemTitle>
                    {displayDescription ? (
                      <SettingsListItemMeta lineClamp={2}>
                        {displayDescription}
                      </SettingsListItemMeta>
                    ) : null}
                    {entry.slug ? (
                      <SettingsStatusText mono truncate>
                        <MonoText>{entry.slug}</MonoText>
                      </SettingsStatusText>
                    ) : null}
                  </SurfaceListItemMain>
                  <Button
                    type="button"
                    variant="plain"
                    prefix={<ArchiveRestoreIcon />}
                    onClick={() => handleRestore(entry)}
                  >
                    {i18n.t("admin.templates.archive.restore")}
                  </Button>
                </Group>
                <Group align="center" wrap="wrap">
                  <TemplateStatusBadge status="ARCHIVED" />
                </Group>
                <SettingsDefinitionList>
                  <SettingsDefinitionItem
                    label={i18n.t("admin.templates.archive.col.category")}
                  >
                    {translateTemplateCategory(i18n, entry.category)}
                  </SettingsDefinitionItem>
                  <SettingsDefinitionItem
                    label={i18n.t("admin.templates.archive.col.status")}
                    mono
                  >
                    {entry.status ?? "ARCHIVED"}
                  </SettingsDefinitionItem>
                </SettingsDefinitionList>
              </SurfaceListItem>
            );
          })}
        </SurfaceList>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ArchiveTab() {
  return (
    <Suspense fallback={<ArchiveSkeleton />}>
      <ArchiveContent />
    </Suspense>
  );
}
