import type { AdminDocumentVersionPolicyFieldsFragment } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Checkbox,
  Loading,
  MonoText,
  NavigationLink,
  NumberInput,
  SettingsDetailHeader,
  SettingsMasterDetailLayout,
  SettingsNotice,
  SimpleGrid,
  Stack,
  SurfaceList,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";

import {
  useDocumentVersionPoliciesQuery,
  useUpsertDocumentVersionPolicyMutation,
} from "../api";
import {
  BooleanField,
  EmptyState,
  ErrorText,
  FormActions,
  SelectField,
  TextField,
} from "./shared";

const SCHEME_PRESETS = [
  "simple_counter",
  "date_counter",
  "event_counter",
  "semver_manual",
  "custom_pattern",
];
const TIMEZONE_MODES = ["utc", "workspace", "user"];
const POLICY_SCOPES = ["global", "workspace", "doc_template"];
const AUTO_TRIGGERS = ["on_pdf_export", "on_publish", "daily"] as const;
const AUTO_TRIGGER_LABEL_KEYS = {
  on_pdf_export: "admin.nav.pdf-export",
  on_publish: "admin.templates.action.publish",
  daily: "admin.templates.tag.daily",
} satisfies Record<(typeof AUTO_TRIGGERS)[number], string>;

function policyToDraft(policy: AdminDocumentVersionPolicyFieldsFragment) {
  return {
    id: policy.id,
    scope: policy.scope,
    workspaceId: policy.workspaceId ?? "",
    name: policy.name,
    isDefault: policy.isDefault,
    enabledByDefault: policy.enabledByDefault,
    schemePreset: policy.schemePreset,
    customPattern: policy.customPattern ?? "",
    timezoneMode: policy.timezoneMode,
    autoVersionOn: policy.autoVersionOn.map(String),
    retentionCount: String(policy.retentionCount),
    pinManualVersions: policy.pinManualVersions,
    pinPublishVersions: policy.pinPublishVersions,
    publishedVersionsProtected: policy.publishedVersionsProtected,
    exportVersionsProtected: policy.exportVersionsProtected,
  };
}

export function VersioningTab() {
  const i18n = useI18n();
  const query = useDocumentVersionPoliciesQuery();
  const mutation = useUpsertDocumentVersionPolicyMutation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    query.policies.find((policy) => policy.id === selectedId) ??
    query.policies[0];
  const [draft, setDraft] = useState(() =>
    selected ? policyToDraft(selected) : null,
  );
  const [baseline, setBaseline] = useState(draft);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedSignature = selected
    ? JSON.stringify(policyToDraft(selected))
    : "";
  const clean = useMemo(
    () =>
      selectedSignature
        ? (JSON.parse(selectedSignature) as ReturnType<typeof policyToDraft>)
        : null,
    [selectedSignature],
  );

  useEffect(() => {
    if (!selectedId && query.policies[0]) setSelectedId(query.policies[0].id);
  }, [query.policies, selectedId]);

  const dirty = Boolean(
    baseline && draft && JSON.stringify(baseline) !== JSON.stringify(draft),
  );
  const valid = Boolean(
    draft?.name.trim() &&
    Number.isInteger(Number(draft.retentionCount)) &&
    Number(draft.retentionCount) >= 1,
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Activity reactivation and query refresh must not replace an unsaved draft.
  useEffect(() => {
    if (clean && !dirtyRef.current) {
      setDraft(clean);
      setBaseline(clean);
    }
  }, [clean]);

  const selectPolicy = (id: string) => {
    if (id === selected?.id || busyRef.current) return;
    if (dirty) setPendingId(id);
    else setSelectedId(id);
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || busyRef.current || !valid) return;
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await mutation.upsertPolicy({
        id: draft.id,
        scope: draft.scope,
        workspaceId: draft.workspaceId || null,
        name: draft.name,
        isDefault: draft.isDefault,
        enabledByDefault: draft.enabledByDefault,
        schemePreset: draft.schemePreset,
        customPattern: draft.customPattern || null,
        timezoneMode: draft.timezoneMode,
        autoVersionOn: draft.autoVersionOn,
        retentionCount: Number(draft.retentionCount),
        pinManualVersions: draft.pinManualVersions,
        pinPublishVersions: draft.pinPublishVersions,
        publishedVersionsProtected: draft.publishedVersionsProtected,
        exportVersionsProtected: draft.exportVersionsProtected,
        metadataSchema: selected?.metadataSchema ?? {},
      });
      await query.mutate();
      setBaseline(draft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  if (query.error) return <ErrorText>{query.error.message}</ErrorText>;
  if (query.isLoading) return <Loading />;
  if (query.policies.length === 0 || !draft || !clean) {
    return (
      <EmptyState>{i18n.t("admin.documents.versioning.empty")}</EmptyState>
    );
  }

  const schemePresetLabels: Record<string, string> = {
    simple_counter: i18n.t("admin.documents.versioning.scheme.simple_counter"),
    date_counter: i18n.t("admin.documents.versioning.scheme.date_counter"),
    event_counter: i18n.t("admin.documents.versioning.scheme.event_counter"),
    semver_manual: i18n.t("admin.documents.versioning.scheme.semver_manual"),
    custom_pattern: i18n.t("admin.documents.versioning.scheme.custom_pattern"),
  };
  const timezoneModeLabels: Record<string, string> = {
    utc: i18n.t("admin.documents.versioning.timezone.utc"),
    workspace: i18n.t("admin.documents.versioning.timezone.workspace"),
    user: i18n.t("admin.documents.versioning.timezone.user"),
  };
  const policyScopeLabels: Record<string, string> = {
    global: i18n.t("admin.documents.versioning.scope.global"),
    workspace: i18n.t("admin.documents.versioning.scope.workspace"),
    doc_template: i18n.t("admin.documents.versioning.scope.doc_template"),
  };
  const previewContract =
    draft.schemePreset === "custom_pattern" && draft.customPattern
      ? draft.customPattern
      : (schemePresetLabels[draft.schemePreset] ?? draft.schemePreset);

  return (
    <Stack data-testid="documents-versioning-tab">
      <SettingsMasterDetailLayout
        detailOpen
        detailPriority="detail"
        detail={
          <Stack component="section">
            <SettingsDetailHeader
              headingLevel={2}
              title={selected.name}
              description={i18n.t(
                "admin.documents.versioning.editor.description",
              )}
            />
            <Stack component="form" onSubmit={save}>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextField
                  id="policy-name"
                  label={i18n.t("admin.common.name")}
                  value={draft.name}
                  disabled={saving}
                  onChange={(name) =>
                    setDraft((old) => old && { ...old, name })
                  }
                />
                <SelectField
                  id="policy-scope"
                  label={i18n.t("admin.documents.field.scope")}
                  value={draft.scope}
                  disabled={saving}
                  values={POLICY_SCOPES}
                  optionLabels={policyScopeLabels}
                  onChange={(scope) =>
                    setDraft((old) => old && { ...old, scope })
                  }
                />
                <BooleanField
                  label={i18n.t("admin.documents.field.default-policy")}
                  checked={draft.isDefault}
                  disabled={saving}
                  onCheckedChange={(isDefault) =>
                    setDraft((old) => old && { ...old, isDefault })
                  }
                />
                <BooleanField
                  label={i18n.t("admin.documents.field.enabled-by-default")}
                  checked={draft.enabledByDefault}
                  disabled={saving}
                  onCheckedChange={(enabledByDefault) =>
                    setDraft((old) => old && { ...old, enabledByDefault })
                  }
                />
              </SimpleGrid>
              <SettingsDetailHeader
                headingLevel={3}
                title={i18n.t("admin.documents.field.label-scheme")}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <SelectField
                  id="policy-scheme"
                  label={i18n.t("admin.documents.field.label-scheme")}
                  value={draft.schemePreset}
                  disabled={saving}
                  values={SCHEME_PRESETS}
                  optionLabels={schemePresetLabels}
                  onChange={(schemePreset) =>
                    setDraft((old) => old && { ...old, schemePreset })
                  }
                />
                <SelectField
                  id="policy-timezone"
                  label={i18n.t("admin.documents.field.timezone-mode")}
                  value={draft.timezoneMode}
                  disabled={saving}
                  values={TIMEZONE_MODES}
                  optionLabels={timezoneModeLabels}
                  onChange={(timezoneMode) =>
                    setDraft((old) => old && { ...old, timezoneMode })
                  }
                />
                <TextField
                  id="policy-custom-pattern"
                  label={i18n.t("admin.documents.field.custom-pattern")}
                  value={draft.customPattern}
                  disabled={draft.schemePreset !== "custom_pattern" || saving}
                  onChange={(customPattern) =>
                    setDraft((old) => old && { ...old, customPattern })
                  }
                />
              </SimpleGrid>

              <SettingsNotice
                tone="neutral"
                title={i18n.t("admin.documents.field.preview")}
              >
                <MonoText>{previewContract}</MonoText>
              </SettingsNotice>
              <SettingsDetailHeader
                headingLevel={3}
                title={i18n.t("admin.documents.field.auto-version-on")}
              />
              <SimpleGrid cols={3}>
                {AUTO_TRIGGERS.map((trigger) => {
                  const triggerLabel = i18n.t(AUTO_TRIGGER_LABEL_KEYS[trigger]);
                  return (
                    <Checkbox
                      key={trigger}
                      label={triggerLabel}
                      checked={draft.autoVersionOn.includes(trigger)}
                      disabled={saving}
                      aria-label={triggerLabel}
                      onChange={(_event, checked) =>
                        setDraft(
                          (old) =>
                            old && {
                              ...old,
                              autoVersionOn: checked
                                ? [...old.autoVersionOn, trigger]
                                : old.autoVersionOn.filter(
                                    (item) => item !== trigger,
                                  ),
                            },
                        )
                      }
                    />
                  );
                })}
              </SimpleGrid>
              <SettingsDetailHeader
                headingLevel={3}
                title={i18n.t(
                  "admin.documents.versioning.retention-protection",
                )}
              />
              <NumberInput
                id="policy-retention"
                label={i18n.t("admin.documents.field.retention-count")}
                value={draft.retentionCount}
                min={1}
                allowDecimal={false}
                clampBehavior="none"
                disabled={saving}
                onChange={(retentionCount) =>
                  setDraft(
                    (old) =>
                      old && { ...old, retentionCount: String(retentionCount) },
                  )
                }
              />

              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <BooleanField
                  label={i18n.t("admin.documents.field.pin-manual")}
                  checked={draft.pinManualVersions}
                  disabled={saving}
                  onCheckedChange={(pinManualVersions) =>
                    setDraft((old) => old && { ...old, pinManualVersions })
                  }
                />
                <BooleanField
                  label={i18n.t("admin.documents.field.pin-publish")}
                  checked={draft.pinPublishVersions}
                  disabled={saving}
                  onCheckedChange={(pinPublishVersions) =>
                    setDraft((old) => old && { ...old, pinPublishVersions })
                  }
                />
                <BooleanField
                  label={i18n.t("admin.documents.field.protect-published")}
                  checked={draft.publishedVersionsProtected}
                  disabled={saving}
                  onCheckedChange={(publishedVersionsProtected) =>
                    setDraft(
                      (old) => old && { ...old, publishedVersionsProtected },
                    )
                  }
                />
                <BooleanField
                  label={i18n.t("admin.documents.field.protect-export")}
                  checked={draft.exportVersionsProtected}
                  disabled={saving}
                  onCheckedChange={(exportVersionsProtected) =>
                    setDraft(
                      (old) => old && { ...old, exportVersionsProtected },
                    )
                  }
                />
              </SimpleGrid>

              {saveError ? <ErrorText>{saveError}</ErrorText> : null}
              <FormActions
                dirty={dirty}
                saving={saving || mutation.isMutating}
                canSave={valid}
                onReset={() => {
                  setDraft(clean);
                  setBaseline(clean);
                  setSaveError(null);
                }}
              />
            </Stack>
          </Stack>
        }
      >
        <Stack component="section">
          <SettingsDetailHeader
            headingLevel={2}
            title={i18n.t("admin.documents.versioning.policies.title")}
          />
          <SurfaceList data-testid="documents-versioning-policies-soft-list">
            {query.policies.map((policy) => (
              <NavigationLink
                component="button"
                type="button"
                key={policy.id}
                active={selected?.id === policy.id}
                label={policy.name}
                description={policyScopeLabels[policy.scope] ?? policy.scope}
                disabled={saving || mutation.isMutating}
                aria-label={policy.name}
                aria-pressed={selected?.id === policy.id}
                onClick={() => selectPolicy(policy.id)}
              />
            ))}
          </SurfaceList>
        </Stack>
      </SettingsMasterDetailLayout>
      <AdminConfirmModal
        open={pendingId !== null}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.unsaved.discard-description")}
        confirmText={i18n.t("admin.common.discard-changes")}
        onCancel={() => setPendingId(null)}
        onConfirm={() => {
          const policy = query.policies.find((item) => item.id === pendingId);
          if (policy) {
            const next = policyToDraft(policy);
            setDraft(next);
            setBaseline(next);
            dirtyRef.current = false;
            setSelectedId(policy.id);
            setSaveError(null);
          }
          setPendingId(null);
        }}
      />
    </Stack>
  );
}
