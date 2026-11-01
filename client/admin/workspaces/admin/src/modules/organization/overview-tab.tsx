import { useI18n } from "@myoxus/i18n";
import { RotateCcw, Save } from "@myoxus/icons/react";
import {
  Button,
  Input,
  Loading,
  notify,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsNotice,
  SettingsStatusText,
  SettingsToolbar,
  SimpleGrid,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatAdminDate } from "../../utils/locale-format";
import { useOrganizationQuery, useUpdateOrganizationMutation } from "./api";

export function OverviewTab() {
  const i18n = useI18n();
  const query = useOrganizationQuery();
  const { organization } = query;
  const update = useUpdateOrganizationMutation();
  const signature = organization
    ? JSON.stringify({ name: organization.name, slug: organization.slug })
    : "";
  const clean = useMemo(
    () =>
      signature
        ? (JSON.parse(signature) as { name: string; slug: string })
        : null,
    [signature],
  );
  const [draft, setDraft] = useState(clean);
  const [baseline, setBaseline] = useState(clean);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = Boolean(
    draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline),
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Retained tabs and background revalidation cannot discard an editing draft.
  useEffect(() => {
    if (clean && !dirtyRef.current) {
      setDraft(clean);
      setBaseline(clean);
    }
  }, [clean]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      busyRef.current ||
      !dirty ||
      !draft.name.trim() ||
      !draft.slug.trim()
    )
      return;
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await update.trigger({ input: draft });
      await query.mutate();
      setBaseline(draft);
      notify.success({ title: i18n.t("admin.organization.overview.saved") });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  if (query.error)
    return <SettingsNotice tone="error">{query.error.message}</SettingsNotice>;
  if (query.isLoading) return <Loading />;
  if (!organization || !draft)
    return (
      <SettingsEmptyState
        title={i18n.t("admin.organization.overview.loading")}
      />
    );
  const busy = saving || update.isMutating;

  return (
    <Stack component="section">
      <SettingsDetailHeader
        title={organization.name}
        description={organization.slug}
        headingLevel={2}
      />
      <SettingsDefinitionList>
        <SettingsDefinitionItem label={i18n.t("admin.common.created")}>
          {formatAdminDate(i18n.language, organization.createdAt)}
        </SettingsDefinitionItem>
        <SettingsDefinitionItem
          label={i18n.t("admin.organization.overview.key-short")}
        >
          {organization.key}
        </SettingsDefinitionItem>
      </SettingsDefinitionList>
      <Stack component="form" onSubmit={save}>
        <SimpleGrid cols={2}>
          <Input
            id="org-name"
            label={i18n.t("admin.organization.overview.name-label")}
            data-testid="organization-name-input"
            disabled={busy}
            value={draft.name}
            onChange={(name) => setDraft((old) => old && { ...old, name })}
          />
          <Input
            id="org-slug"
            label={i18n.t("admin.organization.overview.slug-label")}
            data-testid="organization-slug-input"
            disabled={busy}
            value={draft.slug}
            onChange={(slug) => setDraft((old) => old && { ...old, slug })}
          />
        </SimpleGrid>
        {saveError ? (
          <SettingsStatusText role="alert" tone="error">
            {saveError}
          </SettingsStatusText>
        ) : null}
        <SettingsToolbar>
          {dirty ? (
            <SettingsStatusText tone="active">
              {i18n.t("admin.state.unsaved-changes")}
            </SettingsStatusText>
          ) : null}
          <Button
            type="button"
            variant="plain"
            disabled={!dirty || busy}
            prefix={<RotateCcw aria-hidden />}
            onClick={() => {
              setDraft(clean);
              setBaseline(clean);
              setSaveError(null);
            }}
          >
            {i18n.t("admin.organization.overview.reset")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            prefix={<Save aria-hidden />}
            disabled={
              !dirty || busy || !draft.name.trim() || !draft.slug.trim()
            }
            data-testid="organization-save-button"
          >
            {busy
              ? i18n.t("admin.common.saving")
              : i18n.t("admin.organization.overview.save")}
          </Button>
        </SettingsToolbar>
      </Stack>
    </Stack>
  );
}
