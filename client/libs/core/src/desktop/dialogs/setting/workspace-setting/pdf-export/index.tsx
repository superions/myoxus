import {
  type PdfTemplateOption,
  type WorkspacePdfExportSettingsBootstrap,
  workspacePdfExportSettingsQuery,
} from "@myoxus/core/modules/pdf-export/types";
import { GraphQLService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  ColorSwatch,
  Group,
  InlineLink,
  MediaPreviewFrame,
  MediaPreviewImage,
  MyoxusText,
  SettingsControlEmpty,
  SettingsControlList,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsPage,
  SettingsSection,
  Stack,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListMeta,
} from "../../primitives";

type GraphQLCallOptions = Parameters<GraphQLService["gql"]>[0];

function localWorkspacePdfSettingsQueryOptions(
  workspaceId: string,
): GraphQLCallOptions {
  // Workspace PDF settings are served by a module-local query until this
  // operation is generated into @myoxus/graphql.
  return {
    query: workspacePdfExportSettingsQuery,
    variables: { workspaceId },
  } as unknown as GraphQLCallOptions;
}

type I18n = ReturnType<typeof useI18n>;

function capabilityTags(template: PdfTemplateOption, t: I18n): string[] {
  const caps = template.capabilities ?? {};
  const tags = new Set<string>();
  if (caps.coverPage?.kind === "boolean") {
    tags.add(t["com.myoxus.settings.workspace.pdf-export.capability.cover"]());
  }
  if (Array.isArray(caps.tocBehavior?.values)) {
    tags.add(t["com.myoxus.settings.workspace.pdf-export.capability.toc"]());
  }
  if ((caps.confidentialityLabels?.max_items ?? 0) > 0) {
    tags.add(t["com.myoxus.settings.workspace.pdf-export.capability.labels"]());
  }
  if (Array.isArray(caps.language?.values)) {
    tags.add(
      t["com.myoxus.settings.workspace.pdf-export.capability.locales"]({
        count: String(caps.language.values.length),
      }),
    );
  }
  return [...tags].slice(0, 4);
}

function displayValue(value: unknown, t: I18n) {
  if (value === undefined || value === null || value === "") {
    return t["com.myoxus.settings.workspace.pdf-export.value.not-configured"]();
  }
  if (typeof value === "boolean") {
    return value
      ? t["com.myoxus.settings.workspace.pdf-export.value.enabled"]()
      : t["com.myoxus.settings.workspace.pdf-export.value.disabled"]();
  }
  return String(value);
}

function brandBlobUrl(workspaceId: string, blobKey: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${blobKey}`;
}

function LogoSlot({
  label,
  workspaceId,
  blobKey,
  t,
}: {
  label: string;
  workspaceId: string;
  blobKey: string | null | undefined;
  t: I18n;
}) {
  return (
    <SurfaceListItem
      component="div"
      alignItems="center"
      density="compact"
      justifyContent="space-between"
      layout="row"
      data-myoxus-ui-role="pdf-settings-logo-card"
    >
      <SurfaceListItemMain compact grow>
        <SettingsListItemTitle>{label}</SettingsListItemTitle>
        {!blobKey ? (
          <SettingsListItemMeta>
            {t["com.myoxus.settings.workspace.pdf-export.logo.empty"]()}
          </SettingsListItemMeta>
        ) : null}
      </SurfaceListItemMain>
      {blobKey ? (
        <MediaPreviewFrame data-testid={`pdf-logo-preview:${label}`}>
          <MediaPreviewImage
            alt={`${label} preview`}
            src={brandBlobUrl(workspaceId, blobKey)}
          />
        </MediaPreviewFrame>
      ) : null}
    </SurfaceListItem>
  );
}

function ColorValue({
  label,
  value,
  t,
}: {
  label: string;
  value?: string | null;
  t: I18n;
}) {
  return (
    <SettingsDefinitionItem label={label}>
      <Group>
        {value ? (
          <ColorSwatch
            aria-label={label}
            color={value}
            size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-2xs))"
          />
        ) : null}
        <MyoxusText component="span" typographySlot="body">
          {displayValue(value, t)}
        </MyoxusText>
      </Group>
    </SettingsDefinitionItem>
  );
}

function ValueCard({
  label,
  value,
  t,
}: {
  label: string;
  value: unknown;
  t: I18n;
}) {
  return (
    <SettingsDefinitionItem label={label}>
      <MyoxusText component="span" typographySlot="body">
        {displayValue(value, t)}
      </MyoxusText>
    </SettingsDefinitionItem>
  );
}

function TemplateCard({
  template,
  t,
}: {
  template: PdfTemplateOption;
  t: I18n;
}) {
  const tags = capabilityTags(template, t);
  return (
    <SurfaceListItem
      component="article"
      alignItems="flex-start"
      density="compact"
      justifyContent="space-between"
      layout="row"
      data-myoxus-ui-role="pdf-settings-template-card"
    >
      <SurfaceListItemMain grow>
        <SettingsListItemTitle>{template.name}</SettingsListItemTitle>
        <SettingsListItemMeta>
          {template.slug} · v{template.version} · schema{" "}
          {template.schemaVersion}
        </SettingsListItemMeta>
        <Group>
          {tags.length > 0 ? (
            tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))
          ) : (
            <SettingsControlEmpty>
              {t["com.myoxus.settings.workspace.pdf-export.capability.none"]()}
            </SettingsControlEmpty>
          )}
        </Group>
      </SurfaceListItemMain>
      {template.isDefault ? (
        <SurfaceListMeta>
          <Badge tone="info">
            {t["com.myoxus.settings.workspace.pdf-export.template.default"]()}
          </Badge>
        </SurfaceListMeta>
      ) : null}
    </SurfaceListItem>
  );
}

function PdfSettingsEmpty({ children }: { children: string }) {
  return <SettingsControlEmpty>{children}</SettingsControlEmpty>;
}

function PdfSettingsError({
  error,
  onRetry,
  t,
}: {
  error: string;
  onRetry: () => void;
  t: I18n;
}) {
  return (
    <SettingsNotice
      role="alert"
      title={t["com.myoxus.settings.workspace.pdf-export.error.label"]()}
      tone="error"
    >
      <Stack>
        <MyoxusText typographySlot="body-small">{error}</MyoxusText>
        <Button
          data-myoxus-ui-role="button:compact"
          onClick={onRetry}
          type="button"
          variant="secondary"
        >
          {t["Retry"]()}
        </Button>
      </Stack>
    </SettingsNotice>
  );
}

export function WorkspacePdfExportSettingsView({
  workspaceId,
  graphqlService,
}: {
  workspaceId: string;
  graphqlService: Pick<GraphQLService, "gql">;
}) {
  const [bootstrap, setBootstrap] =
    useState<WorkspacePdfExportSettingsBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const t = useI18n();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBootstrap(null);
    void graphqlService
      .gql(localWorkspacePdfSettingsQueryOptions(workspaceId))
      .then((data) => {
        if (!cancelled)
          setBootstrap(data as unknown as WorkspacePdfExportSettingsBootstrap);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(
          "[pdf-export-settings] failed to load workspace pdf settings",
          err,
        );
        setError(
          err instanceof Error
            ? err.message
            : t["com.myoxus.settings.workspace.pdf-export.error.load"](),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [graphqlService, reloadKey, t, workspaceId]);

  const defaultTemplate = useMemo(() => {
    if (!bootstrap) return null;
    return (
      bootstrap.availablePdfTemplates.find(
        (template) =>
          template.id === bootstrap.pdfExportSettings.defaultTemplateId,
      ) ??
      bootstrap.availablePdfTemplates.find((template) => template.isDefault)
    );
  }, [bootstrap]);

  return (
    <SettingsPage
      title={t["com.myoxus.settings.workspace.pdf-export.header.title"]()}
      subtitle={t["com.myoxus.settings.workspace.pdf-export.header.subtitle"]()}
    >
      <SettingsNotice
        title={t["com.myoxus.settings.workspace.pdf-export.notice.title"]()}
        tone="neutral"
      >
        {t["com.myoxus.settings.workspace.pdf-export.notice.text"]()}{" "}
        <InlineLink href="/adminfrontend/pdf-export">
          {t["com.myoxus.settings.workspace.pdf-export.notice.admin-link"]()}
        </InlineLink>
        .
      </SettingsNotice>

      {error ? (
        <SettingsSection
          title={t[
            "com.myoxus.settings.workspace.pdf-export.section.settings"
          ]()}
        >
          <PdfSettingsError
            error={error}
            onRetry={() => setReloadKey((key) => key + 1)}
            t={t}
          />
        </SettingsSection>
      ) : null}

      {!bootstrap && !error ? (
        <SettingsSection
          title={t[
            "com.myoxus.settings.workspace.pdf-export.section.settings"
          ]()}
        >
          <PdfSettingsEmpty>
            {t["com.myoxus.settings.workspace.pdf-export.loading"]()}
          </PdfSettingsEmpty>
        </SettingsSection>
      ) : null}

      {bootstrap ? (
        <>
          <SettingsSection
            title={t[
              "com.myoxus.settings.workspace.pdf-export.section.templates"
            ]()}
          >
            {bootstrap.availablePdfTemplates.length > 0 ? (
              <SettingsControlList>
                {bootstrap.availablePdfTemplates.map((template) => (
                  <TemplateCard key={template.id} t={t} template={template} />
                ))}
              </SettingsControlList>
            ) : (
              <PdfSettingsEmpty>
                {t["com.myoxus.settings.workspace.pdf-export.template.empty"]()}
              </PdfSettingsEmpty>
            )}
          </SettingsSection>

          <SettingsSection
            title={t[
              "com.myoxus.settings.workspace.pdf-export.section.branding"
            ]()}
          >
            <SettingsControlList>
              <LogoSlot
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.logo.large"
                ]()}
                t={t}
                workspaceId={workspaceId}
                blobKey={bootstrap.documentBrandingProfile.logoLargeBlob}
              />
              <LogoSlot
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.logo.small"
                ]()}
                t={t}
                workspaceId={workspaceId}
                blobKey={bootstrap.documentBrandingProfile.logoSmallBlob}
              />
            </SettingsControlList>
            <SettingsDefinitionList>
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.footer"
                ]()}
                t={t}
                value={bootstrap.documentBrandingProfile.footerText}
              />
              <ColorValue
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.primary-color"
                ]()}
                t={t}
                value={bootstrap.documentBrandingProfile.brandColorPrimary}
              />
              <ColorValue
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.accent-color"
                ]()}
                t={t}
                value={bootstrap.documentBrandingProfile.brandColorAccent}
              />
            </SettingsDefinitionList>
          </SettingsSection>

          <SettingsSection
            title={t[
              "com.myoxus.settings.workspace.pdf-export.section.defaults"
            ]()}
          >
            <SettingsDefinitionList>
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.default-template"
                ]()}
                t={t}
                value={defaultTemplate?.name ?? null}
              />
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.paper-size"
                ]()}
                t={t}
                value={bootstrap.pdfExportSettings.defaultPaperSize}
              />
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.locale"
                ]()}
                t={t}
                value={bootstrap.pdfExportSettings.defaultLocale}
              />
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.color-profile"
                ]()}
                t={t}
                value={bootstrap.pdfExportSettings.defaultColorProfile}
              />
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.image-quality"
                ]()}
                t={t}
                value={bootstrap.pdfExportSettings.defaultImageQuality}
              />
              <ValueCard
                label={t[
                  "com.myoxus.settings.workspace.pdf-export.field.ligatures"
                ]()}
                t={t}
                value={bootstrap.pdfExportSettings.ligaturesEnabled}
              />
            </SettingsDefinitionList>
          </SettingsSection>
        </>
      ) : null}
    </SettingsPage>
  );
}

export function WorkspacePdfExportSettings() {
  const workspace = useService(WorkspaceService).workspace;
  const graphqlService = useService(GraphQLService);

  return (
    <WorkspacePdfExportSettingsView
      graphqlService={graphqlService}
      workspaceId={workspace.id}
    />
  );
}
