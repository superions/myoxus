import { DocumentInfoSection } from "@myoxus/core/components/document-info";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { isDocumentNotFoundError } from "@myoxus/core/modules/doc/errors";
import { DocumentLifecycleStore } from "@myoxus/core/modules/doc/stores/document-lifecycle";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { formatRegionalDateTime } from "@myoxus/core/modules/i18n";
import {
  GraphQLService,
  PublicUserService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import { type Tag, TagService } from "@myoxus/core/modules/tag";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { SetDocumentMetadataInput } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import {
  Badge,
  BadgeList,
  BadgeListItem,
  Box,
  Button,
  ColorSwatch,
  DisclosureCard,
  DisclosureCardIndicator,
  DisclosureCardTrigger,
  FormSelect,
  Grid,
  Group,
  Input,
  MyoxusMultiSelect,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  SettingsNotice,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import {
  createContext,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  loadDocumentMetadataModel,
  setDocumentMetadata,
  stateFromMetadata,
  transitionDocumentStatus,
} from "./api";
import { DocumentMetadataCacheService } from "./services/document-metadata-cache";
import type {
  CanonicalMetadataKey,
  DocumentMetadataModel,
  DocumentMetadataValueDefinition,
} from "./types";
import {
  CANONICAL_METADATA_LABELS,
  definitionMap,
  displayValueForMetadataField,
  fromDateTimeLocal,
  hasDisplayValueForMetadataField,
  HEADER_METADATA_KEYS,
  labelForDefinition,
  parseCsvIds,
  PRIMARY_PROPERTY_METADATA_KEYS,
  PROPERTY_METADATA_KEYS,
  SECONDARY_PROPERTY_METADATA_KEYS,
  toDateTimeLocal,
} from "./utils";

export interface DocumentMetadataEditorProps {
  docId: string;
  readonly?: boolean;
  showSummary?: boolean;
  detailsLayout?: DocumentMetadataDetailsLayout;
  canConfigureWorkspaceDefaults?: boolean;
  onConfigureWorkspaceDefaults?: () => void;
  canOpenGlobalPolicy?: boolean;
  onOpenGlobalPolicy?: () => void;
  graphqlService?: Pick<GraphQLService, "gql">;
  metadataCache?: Pick<
    DocumentMetadataCacheService,
    "getModel" | "writeModel" | "markStale" | "invalidateIndex"
  > &
    Partial<Pick<DocumentMetadataCacheService, "hydrateModel" | "watchModel">>;
  headerVisibilityOverrides?: Partial<Record<CanonicalMetadataKey, boolean>>;
  onSetHeaderVisibilityOverride?: (
    key: CanonicalMetadataKey,
    visible: boolean,
  ) => void;
  tagService?: DocumentMetadataTagService;
}

export interface DocumentMetadataViewProps extends DocumentMetadataEditorProps {
  graphqlService: Pick<GraphQLService, "gql">;
}

export type DocumentMetadataDetailsLayout =
  "editor" | "embedded" | "dialog" | "context";

export interface DocumentMetadataDetailsProps {
  /**
   * `editor` keeps the document-width panel chrome used in desktop/editor
   * content. `embedded` lets sheets and drawers provide their own outer
   * spacing. `dialog` keeps the content open and lets the modal own the width.
   */
  layout?: DocumentMetadataDetailsLayout;
}

type I18nApi = ReturnType<typeof useI18n>;

type DocumentMetadataSavingKey = CanonicalMetadataKey;
type DocumentMetadataTagService = Pick<TagService, "tagList">;

const METADATA_FIELD_LABEL_KEYS: Record<CanonicalMetadataKey, string> = {
  status: "com.myoxus.document-metadata.field.status",
  documentType: "com.myoxus.document-metadata.field.document-type",
  version: "com.myoxus.document-metadata.field.version",
  responsible: "com.myoxus.document-metadata.field.responsible",
  reviewDueAt: "com.myoxus.document-metadata.field.review-due-at",
  validFrom: "com.myoxus.document-metadata.field.valid-from",
  validUntil: "com.myoxus.document-metadata.field.valid-until",
  classification: "com.myoxus.document-metadata.field.classification",
  documentNumber: "com.myoxus.document-metadata.field.document-number",
  language: "com.myoxus.document-metadata.field.language",
  audience: "com.myoxus.document-metadata.field.audience",
  retentionPolicy: "com.myoxus.document-metadata.field.retention-policy",
};

function displayMessages(t: I18nApi) {
  return {
    noStatus: t["com.myoxus.document-metadata.value.no-status"](),
    noType: t["com.myoxus.document-metadata.value.no-type"](),
    noVersion: t["com.myoxus.document-metadata.value.no-version"](),
    notSet: t["com.myoxus.document-metadata.value.not-set"](),
    unversionedChanges:
      t["com.myoxus.document-metadata.value.unversioned-changes"](),
    changedSuffix: t["com.myoxus.document-metadata.value.changed"](),
    principal_one: t["com.myoxus.document-metadata.value.principal.one"](),
    principal_other: t["com.myoxus.document-metadata.value.principal.other"](),
  };
}

function localizedLabel(
  t: I18nApi,
  definitions: Map<string, DocumentMetadataModel["definitions"][number]>,
  key: CanonicalMetadataKey,
) {
  const fallback = t[METADATA_FIELD_LABEL_KEYS[key]]();
  const definitionLabel = labelForDefinition(definitions, key);
  // Server defaults are canonical English labels. Keep admin-customized labels,
  // but localize untouched defaults in the editor UI.
  return definitionLabel === CANONICAL_METADATA_LABELS[key]
    ? fallback
    : definitionLabel;
}

function formatMetadataDateTime(
  value: string | null | undefined,
  empty: string,
  regionalPreferences: ReturnType<typeof useRegionalPreferences>,
) {
  if (!value) return empty;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatRegionalDateTime(date, regionalPreferences);
}

function nonEmptyValue(value: string | null | undefined, empty: string) {
  return value && value.trim() ? value : empty;
}

function isCanonicalMetadataKey(key: string): key is CanonicalMetadataKey {
  return key in METADATA_FIELD_LABEL_KEYS;
}

function defaultHeaderVisibility(
  definitions: Map<string, DocumentMetadataModel["definitions"][number]>,
  key: CanonicalMetadataKey,
) {
  const definition = definitions.get(key);
  return Boolean(definition?.enabled && definition.visibleInHeader);
}

function effectiveHeaderVisibility(
  definitions: Map<string, DocumentMetadataModel["definitions"][number]>,
  overrides: Partial<Record<CanonicalMetadataKey, boolean>> | undefined,
  key: CanonicalMetadataKey,
) {
  const serverVisible = defaultHeaderVisibility(definitions, key);
  return serverVisible && (overrides?.[key] ?? true);
}

interface DocumentMetadataContextValue {
  docId: string;
  readonly?: boolean;
  model: DocumentMetadataModel | null;
  loading: boolean;
  savingKey: DocumentMetadataSavingKey | null;
  error: string | null;
  canConfigureWorkspaceDefaults?: boolean;
  onConfigureWorkspaceDefaults?: () => void;
  canOpenGlobalPolicy?: boolean;
  onOpenGlobalPolicy?: () => void;
  headerVisibilityOverrides?: Partial<Record<CanonicalMetadataKey, boolean>>;
  onSetHeaderVisibilityOverride?: (
    key: CanonicalMetadataKey,
    visible: boolean,
  ) => void;
  load: () => Promise<void>;
  applyPatch: (key: CanonicalMetadataKey, value: string) => Promise<boolean>;
  applyStatus: (statusId: string) => Promise<boolean>;
  tagService?: DocumentMetadataTagService;
}

const DocumentMetadataContext =
  createContext<DocumentMetadataContextValue | null>(null);

function useDocumentMetadataContext() {
  const value = useContext(DocumentMetadataContext);
  if (!value) {
    throw new Error(
      "Document metadata components must be rendered inside DocumentMetadataProvider",
    );
  }
  return value;
}

function idOrNull(value: string): string | null {
  return value === "" ? null : value;
}

function selectOptions(values: DocumentMetadataValueDefinition[]) {
  return values.map((value) => ({ value: value.id, label: value.label }));
}

function memberOptions(model: DocumentMetadataModel) {
  const options = model.lookup.workspaceMembers.map((member) => ({
    value: member.id,
    label: member.name || member.email || member.id,
  }));
  const selected = model.state.responsibleUserId;
  if (selected && !options.some((option) => option.value === selected)) {
    options.unshift({ value: selected, label: selected });
  }
  return options;
}

function statusOptions(model: DocumentMetadataModel) {
  const options = model.lookup.statusValues.map((status) => ({
    value: status.id,
    label: status.label,
  }));
  const selected = model.state.statusId;
  if (selected && !options.some((option) => option.value === selected)) {
    options.unshift({
      value: selected,
      label: model.state.statusLabel ?? selected,
    });
  }
  return options;
}

function metadataPatch(
  key: CanonicalMetadataKey,
  rawValue: string,
): SetDocumentMetadataInput | null {
  switch (key) {
    case "documentType":
      return { documentTypeId: idOrNull(rawValue) };
    case "classification":
      return { classificationId: idOrNull(rawValue) };
    case "retentionPolicy":
      return { retentionPolicyId: idOrNull(rawValue) };
    case "documentNumber":
      return { documentNumber: rawValue.trim() || null };
    case "language":
      return { languageId: idOrNull(rawValue) };
    case "reviewDueAt":
      return { reviewDueAt: fromDateTimeLocal(rawValue) };
    case "validFrom":
      return { validFrom: fromDateTimeLocal(rawValue) };
    case "validUntil":
      return { validUntil: fromDateTimeLocal(rawValue) };
    case "audience":
      return { audienceIds: parseCsvIds(rawValue) };
    case "responsible":
      return { responsibleUserId: idOrNull(rawValue.trim()) };
    case "status":
    case "version":
      return null;
  }
}

function HeaderChips({ model }: { model: DocumentMetadataModel }) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const { headerVisibilityOverrides, readonly } = useDocumentMetadataContext();
  const publicUsers = useServiceOptional(PublicUserService);
  const responsibleId = model.state.responsibleUserId;
  const responsibleMember = model.lookup.workspaceMembers.find(
    (member) => member.id === responsibleId,
  );
  const responsibleUser = useLiveData(
    useMemo(
      () =>
        responsibleId ? publicUsers?.publicUser$(responsibleId) : undefined,
      [publicUsers, responsibleId],
    ),
  );
  useEffect(() => {
    // Reuse public identity lookup when member enumeration is unavailable to a reader.
    if (responsibleId && !responsibleMember && !responsibleUser)
      publicUsers?.revalidate(responsibleId);
  }, [publicUsers, responsibleId, responsibleMember, responsibleUser]);
  const definitions = useMemo(() => definitionMap(model.definitions), [model]);
  const headerKeys = HEADER_METADATA_KEYS.filter(
    (key) =>
      effectiveHeaderVisibility(definitions, headerVisibilityOverrides, key) &&
      hasDisplayValueForMetadataField(model, key),
  );
  const errors = model.validation.errors;
  const warnings = model.validation.warnings;
  const issueCount =
    errors.length || model.validation.missingRequiredMetadataFields.length;
  const issueLabel = t["com.myoxus.document-metadata.validation.issues"]();
  const warningLabel = t["com.myoxus.document-metadata.validation.warnings"]();

  return (
    <BadgeList data-testid="document-metadata-header" justify="center">
      {headerKeys.map((key) => {
        const label = localizedLabel(t, definitions, key);
        const value =
          key === "responsible" &&
          !responsibleMember &&
          responsibleUser &&
          !responsibleUser.removed &&
          responsibleUser.name
            ? responsibleUser.name
            : displayValueForMetadataField(
                model,
                key,
                displayMessages(t),
                regionalPreferences,
              );
        const editable =
          SELECTABLE_METADATA_KEYS.includes(key) &&
          canEditField(model, key, readonly);
        const chip = (
          <Badge
            aria-label={`${label}: ${value}`}
            title={`${label}: ${value}`}
            truncate
            component={editable ? "button" : "div"}
            type={editable ? "button" : undefined}
            data-metadata-key={key}
            surface="floating"
            tone="neutral"
          >
            <MyoxusText
              component="span"
              data-myoxus-ui-role="document-metadata-chip-label"
              tone="secondary"
              typographySlot="label-compact"
            >
              {label}
            </MyoxusText>{" "}
            <MyoxusText
              component="span"
              data-myoxus-ui-role="document-metadata-chip-value"
              tone="primary"
              typographySlot="body-small"
            >
              {value}
            </MyoxusText>
          </Badge>
        );
        return (
          <BadgeListItem key={key}>
            {editable ? (
              <HeaderFieldPopover metadataKey={key} label={label}>
                {chip}
              </HeaderFieldPopover>
            ) : (
              chip
            )}
          </BadgeListItem>
        );
      })}
      {model.validation.valid ? null : (
        <BadgeListItem>
          <Badge
            aria-label={`${issueCount} ${issueLabel}`}
            data-testid="document-metadata-invalid-chip"
            surface="floating"
            tone="error"
          >
            {issueCount} {issueLabel}
          </Badge>
        </BadgeListItem>
      )}
      {warnings.length ? (
        <BadgeListItem>
          <Badge
            aria-label={`${warnings.length} ${warningLabel}`}
            data-testid="document-metadata-warning-chip"
            surface="floating"
            tone="warning"
          >
            {warnings.length} {warningLabel}
          </Badge>
        </BadgeListItem>
      ) : null}
    </BadgeList>
  );
}

function TagChip({ tag, label }: { tag: Tag; label: string }) {
  const name = useLiveData(tag.value$);
  const color = useLiveData(tag.color$);
  if (!name) return null;

  return (
    <BadgeListItem>
      <Badge
        aria-label={`${label}: ${name}`}
        data-myoxus-ui-role="document-metadata-tag-chip"
        data-tag-id={tag.id}
        prefix={
          <ColorSwatch
            data-myoxus-ui-role="document-metadata-tag-color"
            shape="circle"
            tagColorRole={color}
          />
        }
        tagColorRole={color}
      >
        <MyoxusText component="span" tone="primary" typographySlot="body-small">
          {name}
        </MyoxusText>
      </Badge>
    </BadgeListItem>
  );
}

function ResolvedTagChips({
  docId,
  tagService,
}: {
  docId: string;
  tagService: DocumentMetadataTagService;
}) {
  const t = useI18n();
  const tags = useLiveData(tagService.tagList.tagsByPageId$(docId));
  if (!tags.length) return null;

  const label = t["com.myoxus.page-properties.property.tags"]();

  return (
    <BadgeList
      data-myoxus-ui-role="document-metadata-tag-list"
      data-testid="document-metadata-tags"
      justify="center"
    >
      {tags.map((tag) => (
        <TagChip key={tag.id} label={label} tag={tag} />
      ))}
    </BadgeList>
  );
}

function TagChips() {
  const { docId, tagService } = useDocumentMetadataContext();
  if (!tagService) return null;
  return <ResolvedTagChips docId={docId} tagService={tagService} />;
}

function IssueList() {
  const t = useI18n();
  const { model } = useDocumentMetadataContext();
  if (!model) return null;
  const definitions = definitionMap(model.definitions);
  const issues = [
    ...model.validation.errors.map((issue) => ({
      ...issue,
      kind: "error" as const,
    })),
    ...model.validation.warnings.map((issue) => ({
      ...issue,
      kind: "warning" as const,
    })),
  ];
  if (!issues.length) return null;
  return (
    <Stack data-testid="document-metadata-validation">
      {issues.map((issue, index) => {
        const message =
          issue.code === "required" &&
          issue.key &&
          isCanonicalMetadataKey(issue.key)
            ? t["com.myoxus.document-metadata.validation.required"]({
                label: localizedLabel(t, definitions, issue.key),
              })
            : issue.message;
        const blockedActions = issue.blockedActions.length
          ? ` ${t["com.myoxus.document-metadata.validation.blocks"]()}: ${issue.blockedActions.join(", ")}`
          : "";

        return (
          <SettingsNotice
            data-metadata-key={issue.key ?? undefined}
            key={`${issue.code}-${issue.key ?? "global"}-${index}`}
            tone={issue.kind === "error" ? "error" : "warning"}
          >
            {message}
            {blockedActions}
          </SettingsNotice>
        );
      })}
    </Stack>
  );
}

const SELECTABLE_METADATA_KEYS: CanonicalMetadataKey[] = [
  "status",
  "documentType",
  "classification",
  "language",
  "retentionPolicy",
  "audience",
  "responsible",
];

function selectionValue(
  model: DocumentMetadataModel,
  key: CanonicalMetadataKey,
): string | string[] {
  const state = model.state;
  switch (key) {
    case "status":
      return state.statusId ?? "";
    case "documentType":
      return state.typeId ?? "";
    case "classification":
      return state.classificationId ?? "";
    case "language":
      return state.languageId ?? "";
    case "retentionPolicy":
      return state.retentionPolicyId ?? "";
    case "responsible":
      return state.responsibleUserId ?? "";
    case "audience":
      return state.audienceIds;
    default:
      return "";
  }
}

function canEditField(
  model: DocumentMetadataModel,
  key: CanonicalMetadataKey,
  readonly?: boolean,
) {
  const definition = definitionMap(model.definitions).get(key);
  return Boolean(
    definition?.enabled &&
    !readonly &&
    // Status is system-owned for raw patches; its declared transition writer
    // remains available through the existing status capability, as in Details.
    (definition.editableBy !== "admin_only" ||
      (key === "status" && definition.metadata?.write === "transition_only")) &&
    !definition.metadata?.computed,
  );
}

// Both header and details consume the same controlled selection and catalogs.
function MetadataValueControl({
  metadataKey,
  model,
  disabled,
  onStatusChange,
  onPatch,
  inPopover = false,
}: {
  metadataKey: CanonicalMetadataKey;
  model: DocumentMetadataModel;
  disabled: boolean;
  onStatusChange: (statusId: string) => void;
  onPatch: (key: CanonicalMetadataKey, value: string) => void;
  inPopover?: boolean;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const label = localizedLabel(
    t,
    definitionMap(model.definitions),
    metadataKey,
  );
  const state = model.state;
  if (SELECTABLE_METADATA_KEYS.includes(metadataKey)) {
    const options =
      metadataKey === "status"
        ? statusOptions(model)
        : metadataKey === "documentType"
          ? model.lookup.documentTypes.map((type) => ({
              value: type.id,
              label: type.label,
            }))
          : metadataKey === "responsible"
            ? memberOptions(model)
            : selectOptions(
                model.lookup.valueDefinitions[
                  metadataKey as
                    | "classification"
                    | "language"
                    | "audience"
                    | "retentionPolicy"
                ],
              );
    const value = selectionValue(model, metadataKey);
    // Persisted references can outlive their active catalog entries. Preserve
    // the acknowledged selection without inventing a replacement value.
    if (
      typeof value === "string" &&
      value &&
      !options.some((option) => option.value === value)
    )
      options.unshift({
        value,
        label: displayValueForMetadataField(
          model,
          metadataKey,
          displayMessages(t),
          regionalPreferences,
        ),
      });
    if (metadataKey === "audience") {
      // Keep assigned IDs even when a reference catalog no longer includes them.
      const data = [...options];
      for (const id of state.audienceIds)
        if (!data.some((option) => option.value === id))
          data.push({ value: id, label: id });
      return (
        <MyoxusMultiSelect
          aria-label={label}
          block
          data={data}
          disabled={disabled}
          searchable
          // Popovers keep options local; otherwise the Facade owns the modal layer.
          comboboxProps={inPopover ? { withinPortal: false } : undefined}
          onChange={(values) => onPatch(metadataKey, values.join(","))}
          value={Array.isArray(value) ? value : []}
        />
      );
    }
    return (
      <FormSelect
        aria-label={label}
        // A transition requires a target ID; an unset status is a placeholder,
        // not a selectable clearing operation.
        placeholder={
          metadataKey === "status"
            ? t["com.myoxus.document-metadata.value.no-status"]()
            : undefined
        }
        data={
          metadataKey === "status"
            ? options
            : [
                {
                  value: "",
                  label:
                    metadataKey === "documentType"
                      ? t["com.myoxus.document-metadata.value.no-type"]()
                      : t["com.myoxus.document-metadata.value.not-set"](),
                },
                ...options,
              ]
        }
        disabled={disabled}
        searchable
        allowDeselect={false}
        comboboxProps={inPopover ? { withinPortal: false } : undefined}
        onChange={(value) =>
          metadataKey === "status"
            ? onStatusChange(value)
            : onPatch(metadataKey, value)
        }
        value={typeof value === "string" ? value : ""}
      />
    );
  }
  if (metadataKey === "version")
    return (
      <Input
        aria-label={label}
        block
        disabled
        readOnly
        value={displayValueForMetadataField(
          model,
          metadataKey,
          displayMessages(t),
          regionalPreferences,
        )}
      />
    );
  if (["reviewDueAt", "validFrom", "validUntil"].includes(metadataKey)) {
    const value =
      metadataKey === "reviewDueAt"
        ? state.reviewDueAt
        : metadataKey === "validFrom"
          ? state.validFrom
          : state.validUntil;
    return (
      <Input
        aria-label={label}
        block
        disabled={disabled}
        type="datetime-local"
        onChange={(value) => onPatch(metadataKey, value)}
        value={toDateTimeLocal(value)}
      />
    );
  }
  return (
    <Input
      aria-label={label}
      block
      disabled={disabled}
      onBlur={(event) => onPatch(metadataKey, event.currentTarget.value)}
      defaultValue={state.documentNumber ?? ""}
    />
  );
}

function MetadataFieldControl({
  metadataKey,
  model,
  readonly,
  savingKey,
  onStatusChange,
  onPatch,
}: {
  metadataKey: CanonicalMetadataKey;
  model: DocumentMetadataModel;
  readonly?: boolean;
  savingKey: DocumentMetadataSavingKey | null;
  onStatusChange: (statusId: string) => void;
  onPatch: (key: CanonicalMetadataKey, value: string) => void;
}) {
  const t = useI18n();
  const definitions = definitionMap(model.definitions);
  if (!definitions.get(metadataKey)?.visibleInProperties) return null;
  const label = localizedLabel(t, definitions, metadataKey);
  return (
    <>
      <Grid.Col data-myoxus-ui-role="metadata-label" span={{ base: 12, sm: 4 }}>
        <MyoxusText component="span" tone="secondary" typographySlot="nav">
          {label}
        </MyoxusText>
      </Grid.Col>
      <Grid.Col
        data-myoxus-ui-role="metadata-value"
        data-testid={`document-metadata-field-${metadataKey}`}
        span={{ base: 12, sm: 8 }}
      >
        <MetadataValueControl
          metadataKey={metadataKey}
          model={model}
          disabled={
            !canEditField(model, metadataKey, readonly) || Boolean(savingKey)
          }
          onStatusChange={onStatusChange}
          onPatch={onPatch}
        />
      </Grid.Col>
    </>
  );
}

function HeaderFieldPopover({
  metadataKey,
  label,
  children,
}: {
  metadataKey: CanonicalMetadataKey;
  label: string;
  children: ReactNode;
}) {
  const t = useI18n();
  const { model, savingKey, error, applyPatch, applyStatus } =
    useDocumentMetadataContext();
  const [opened, setOpened] = useState(false);
  const [retryValue, setRetryValue] = useState<string | null>(null);
  if (!model) return null;
  const save = async (value: string) => {
    setRetryValue(null);
    const success =
      metadataKey === "status"
        ? await applyStatus(value)
        : await applyPatch(metadataKey, value);
    if (success) {
      if (metadataKey !== "audience") setOpened(false);
    } else setRetryValue(value);
  };
  const trigger = cloneElement(
    children as ReactElement<{ onClick?: () => void }>,
    {
      onClick: () => setOpened(!opened),
    },
  );
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      fitViewport
      contentMeasure="reading"
      trapFocus
      returnFocus
      position="bottom-start"
    >
      <PopoverTarget>{trigger}</PopoverTarget>
      <PopoverContent data-testid={`document-metadata-popover-${metadataKey}`}>
        <Stack>
          <MyoxusText typographySlot="label">{label}</MyoxusText>
          <MetadataValueControl
            metadataKey={metadataKey}
            model={model}
            disabled={Boolean(savingKey)}
            inPopover
            onStatusChange={(value) => void save(value)}
            onPatch={(_, value) => void save(value)}
          />
          {retryValue !== null && error ? (
            <>
              <SettingsNotice tone="error">{error}</SettingsNotice>
              <Button
                disabled={Boolean(savingKey)}
                onClick={() => void save(retryValue)}
              >
                {t["Retry"]()}
              </Button>
            </>
          ) : null}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}

type DocumentInfoFact = {
  key: string;
  label: string;
  value: string | number | null | undefined;
};

function DocumentInfoFactTable({
  facts,
  testIdPrefix,
}: {
  facts: DocumentInfoFact[];
  testIdPrefix: string;
}) {
  const t = useI18n();
  const empty = t["com.myoxus.document-metadata.value.not-set"]();

  return (
    <Table withRowBorders>
      <TableBody>
        {facts.map((fact) => (
          <TableRow data-testid={`${testIdPrefix}-${fact.key}`} key={fact.key}>
            <TableHead scope="row">
              <MyoxusText tone="secondary" typographySlot="label-compact">
                {fact.label}
              </MyoxusText>
            </TableHead>
            <TableCell>
              <MyoxusText
                data-myoxus-ui-role="metadata-static-value"
                preserveWhitespace
                typographySlot="body"
              >
                {fact.value === null ||
                fact.value === undefined ||
                fact.value === ""
                  ? empty
                  : String(fact.value)}
              </MyoxusText>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function memberDisplayName(
  model: DocumentMetadataModel,
  memberId: string | null | undefined,
  empty: string,
  historicalName?: string | null,
) {
  if (!memberId) return empty;
  const member = model.lookup.workspaceMembers.find(
    (candidate) => candidate.id === memberId,
  );
  return member?.name || historicalName || member?.email || memberId;
}

function InformationSection({ model }: { model: DocumentMetadataModel }) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const empty = t["com.myoxus.document-metadata.value.not-set"]();
  const messages = displayMessages(t);
  const workspaceServer = useServiceOptional(WorkspaceServerService);
  const server = useLiveData(workspaceServer?.server$);
  const publicUsers = server?.scope.get(PublicUserService);
  const createdBy = model.metadata.system.createdBy;
  const updatedBy = model.metadata.system.updatedBy;
  const creator = useLiveData(
    useMemo(
      () => (createdBy ? publicUsers?.publicUser$(createdBy) : undefined),
      [createdBy, publicUsers],
    ),
  );
  const editor = useLiveData(
    useMemo(
      () => (updatedBy ? publicUsers?.publicUser$(updatedBy) : undefined),
      [updatedBy, publicUsers],
    ),
  );
  useEffect(() => {
    // Authorship outlives membership; resolve retained identities through the existing server profile owner.
    for (const id of new Set([createdBy, updatedBy])) {
      if (
        id &&
        !model.lookup.workspaceMembers.some((member) => member.id === id)
      )
        publicUsers?.revalidate(id);
    }
  }, [createdBy, updatedBy, model.lookup.workspaceMembers, publicUsers]);
  const facts: DocumentInfoFact[] = [
    {
      key: "created-by",
      label: t["com.myoxus.document-metadata.field.created-by"](),
      value: memberDisplayName(
        model,
        createdBy,
        empty,
        creator && !creator.removed ? creator.name : undefined,
      ),
    },
    {
      key: "created-at",
      label: t["com.myoxus.document-metadata.field.created-at"](),
      value: formatMetadataDateTime(
        model.metadata.system.createdAt,
        empty,
        regionalPreferences,
      ),
    },
    {
      key: "updated-by",
      label: t["com.myoxus.document-metadata.field.updated-by"](),
      value: memberDisplayName(
        model,
        updatedBy,
        empty,
        editor && !editor.removed ? editor.name : undefined,
      ),
    },
    {
      key: "updated-at",
      label: t["com.myoxus.document-metadata.field.updated-at"](),
      value: formatMetadataDateTime(
        model.metadata.system.updatedAt,
        empty,
        regionalPreferences,
      ),
    },
    ...(
      [
        "documentNumber",
        "reviewDueAt",
        "validFrom",
        "validUntil",
        "language",
        "audience",
        "retentionPolicy",
      ] as const
    ).map((key) => ({
      key,
      label: localizedLabel(t, definitionMap(model.definitions), key),
      value: displayValueForMetadataField(
        model,
        key,
        messages,
        regionalPreferences,
      ),
    })),
  ];

  return (
    <DocumentInfoSection
      testId="document-info-section-information"
      title={t["com.myoxus.document-metadata.section.information"]()}
    >
      <DocumentInfoFactTable
        facts={facts}
        testIdPrefix="document-info-information"
      />
    </DocumentInfoSection>
  );
}

function SystemFactsSection({ model }: { model: DocumentMetadataModel }) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const empty = t["com.myoxus.document-metadata.value.not-set"]();
  const facts: DocumentInfoFact[] = [
    {
      key: "document-id",
      label: t["com.myoxus.document-metadata.field.document-id"](),
      value: model.metadata.docId,
    },
    {
      key: "workspace",
      label: t["com.myoxus.settings.workspace"](),
      value: model.metadata.workspaceId,
    },
    {
      key: "metadata-revision",
      label: t["com.myoxus.document-metadata.field.metadata-revision"](),
      value: model.metadata.metadataRevision,
    },
    {
      key: "metadata-updated-at",
      label: t["com.myoxus.document-metadata.field.metadata-updated-at"](),
      value: formatMetadataDateTime(
        model.metadata.metadataUpdatedAt,
        empty,
        regionalPreferences,
      ),
    },
    {
      key: "projection-version",
      label: t["com.myoxus.document-metadata.field.projection-version"](),
      value: model.metadata.projectionVersion,
    },
  ];

  return (
    <DocumentInfoSection
      testId="document-info-section-system"
      title={t["com.myoxus.document-metadata.section.system"]()}
    >
      <DocumentInfoFactTable
        facts={facts}
        testIdPrefix="document-info-system"
      />
    </DocumentInfoSection>
  );
}

function PresentationSection({ model }: { model: DocumentMetadataModel }) {
  const t = useI18n();
  const empty = t["com.myoxus.document-metadata.value.not-set"]();
  const presentation = model.metadata.presentation;
  const facts: DocumentInfoFact[] = [
    {
      key: "primary-mode",
      label: t["com.myoxus.document-metadata.field.primary-mode"](),
      value:
        presentation?.primaryMode === "edgeless"
          ? t["Edgeless"]()
          : t["Page"](),
    },
    {
      key: "page-width",
      label: t["com.myoxus.document-metadata.field.page-width"](),
      value: nonEmptyValue(presentation?.pageWidth, empty),
    },
    {
      key: "edgeless-color-theme",
      label: t["com.myoxus.document-metadata.field.edgeless-color-theme"](),
      value: nonEmptyValue(presentation?.edgelessColorTheme, empty),
    },
    {
      key: "template-state",
      label: t["com.myoxus.document-metadata.field.template-state"](),
      value: nonEmptyValue(model.metadata.template?.state, empty),
    },
    {
      key: "journal-date",
      label: t["com.myoxus.document-metadata.field.journal-date"](),
      value: nonEmptyValue(model.metadata.journal?.journalDate, empty),
    },
    {
      key: "integration-type",
      label: t["com.myoxus.document-metadata.field.integration-type"](),
      value: nonEmptyValue(model.metadata.integration?.integrationType, empty),
    },
  ];

  return (
    <DocumentInfoSection
      testId="document-info-section-presentation"
      title={t["com.myoxus.document-metadata.section.presentation"]()}
    >
      <DocumentInfoFactTable
        facts={facts}
        testIdPrefix="document-info-presentation"
      />
    </DocumentInfoSection>
  );
}

export function DocumentMetadataEditorView({
  canOpenGlobalPolicy,
  canConfigureWorkspaceDefaults,
  detailsLayout,
  docId,
  metadataCache,
  headerVisibilityOverrides,
  onOpenGlobalPolicy,
  onConfigureWorkspaceDefaults,
  onSetHeaderVisibilityOverride,
  readonly,
  showSummary = true,
  graphqlService,
  tagService,
}: DocumentMetadataViewProps) {
  return (
    <DocumentMetadataProviderView
      key={docId}
      canOpenGlobalPolicy={canOpenGlobalPolicy}
      canConfigureWorkspaceDefaults={canConfigureWorkspaceDefaults}
      docId={docId}
      graphqlService={graphqlService}
      metadataCache={metadataCache}
      headerVisibilityOverrides={headerVisibilityOverrides}
      onOpenGlobalPolicy={onOpenGlobalPolicy}
      onConfigureWorkspaceDefaults={onConfigureWorkspaceDefaults}
      onSetHeaderVisibilityOverride={onSetHeaderVisibilityOverride}
      readonly={readonly}
      tagService={tagService}
    >
      {showSummary ? <DocumentMetadataSummary /> : null}
      <DocumentMetadataDetails layout={detailsLayout} />
    </DocumentMetadataProviderView>
  );
}

interface ProviderViewProps extends DocumentMetadataViewProps {
  children: ReactNode;
}

function DocumentMetadataProviderView({
  children,
  canOpenGlobalPolicy,
  canConfigureWorkspaceDefaults,
  docId,
  metadataCache,
  headerVisibilityOverrides,
  onOpenGlobalPolicy,
  onConfigureWorkspaceDefaults,
  onSetHeaderVisibilityOverride,
  readonly,
  graphqlService,
  tagService,
}: ProviderViewProps) {
  const workspace = useService(WorkspaceService).workspace;
  const documentLifecycle = useService(DocumentLifecycleStore);
  const workspaceId = workspace.id;
  const workspaceFlavour = workspace.flavour;
  const lifecycleState$ = useMemo(
    () => documentLifecycle.state$(docId),
    [docId, documentLifecycle],
  );
  const lifecycleState = useLiveData(lifecycleState$);
  const cachedModel$ = useMemo(
    () => metadataCache?.watchModel?.(docId) ?? null,
    [docId, metadataCache],
  );
  const cachedModel = useLiveData(cachedModel$);
  const [model, setModel] = useState<DocumentMetadataModel | null>(
    () => metadataCache?.getModel(docId) ?? null,
  );
  const [loading, setLoading] = useState(() => !metadataCache?.getModel(docId));
  const [savingKey, setSavingKey] = useState<DocumentMetadataSavingKey | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const writeInFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (cachedModel$) setModel(cachedModel ?? null);
  }, [cachedModel, cachedModel$]);

  const load = useCallback(async () => {
    if (workspaceFlavour === "local") {
      setLoading(false);
      return;
    }
    if (lifecycleState !== "available") {
      setLoading(lifecycleState === "creating");
      setError(null);
      return;
    }
    const cached = metadataCache?.getModel(docId) ?? null;
    if (cached) {
      setModel(cached);
    }
    setLoading(true);
    setError(null);
    try {
      const fresh = metadataCache?.hydrateModel
        ? await metadataCache.hydrateModel(docId, { refresh: true })
        : await loadDocumentMetadataModel(
            graphqlService,
            workspaceId,
            docId,
            documentLifecycle.requestSignal(docId),
          );
      if (!metadataCache?.hydrateModel) {
        metadataCache?.writeModel(fresh, "refresh", docId);
      }
      setModel(fresh);
    } catch (err) {
      if (isDocumentNotFoundError(err)) {
        documentLifecycle.markNotFound(docId);
      }
      console.warn("[document-metadata] load failed", { docId, error: err });
      metadataCache?.markStale(
        docId,
        err instanceof Error ? err.message : "load failed",
      );
      setError(
        err instanceof Error ? err.message : "Failed to load document metadata",
      );
    } finally {
      setLoading(false);
    }
  }, [
    docId,
    documentLifecycle,
    graphqlService,
    lifecycleState,
    metadataCache,
    workspaceFlavour,
    workspaceId,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyPatch = useCallback(
    async (key: CanonicalMetadataKey, value: string) => {
      const patch = metadataPatch(key, value);
      if (
        !patch ||
        writeInFlight.current ||
        !model ||
        !canEditField(model, key, readonly)
      )
        return false;
      if (SELECTABLE_METADATA_KEYS.includes(key)) {
        const current = selectionValue(model, key);
        const unchanged = Array.isArray(current)
          ? current.length === parseCsvIds(value).length &&
            current.every((id) => parseCsvIds(value).includes(id))
          : current === value;
        if (unchanged) return true;
      }
      // Disable before awaiting: two same-tick audience changes must not race full-set writes.
      writeInFlight.current = true;
      setSavingKey(key);
      setError(null);
      try {
        const metadata = await setDocumentMetadata(
          graphqlService,
          workspaceId,
          docId,
          patch,
          documentLifecycle.requestSignal(docId),
        );
        if (!mounted.current) return false;
        // Cache publication notifies sibling consumers; keep it outside React updaters.
        const current = metadataCache?.getModel(docId) ?? model;
        if (current) {
          const next = {
            ...current,
            metadata,
            state: stateFromMetadata(metadata),
          };
          metadataCache?.writeModel(next, "setDocumentMetadata", docId);
          setModel(next);
        }
        metadataCache?.invalidateIndex();
        return true;
      } catch (err) {
        if (!mounted.current) return false;
        if (isDocumentNotFoundError(err)) {
          documentLifecycle.markNotFound(docId);
        }
        console.warn("[document-metadata] update failed", {
          docId,
          key,
          error: err,
        });
        setError(
          err instanceof Error
            ? err.message
            : "Failed to update document metadata",
        );
        return false;
      } finally {
        writeInFlight.current = false;
        if (mounted.current) setSavingKey(null);
      }
    },
    [
      docId,
      documentLifecycle,
      graphqlService,
      metadataCache,
      model,
      readonly,
      workspaceId,
    ],
  );

  const applyStatus = useCallback(
    async (statusId: string) => {
      if (
        !statusId ||
        writeInFlight.current ||
        !model ||
        !canEditField(model, "status", readonly)
      )
        return false;
      if (model.state.statusId === statusId) return true;
      writeInFlight.current = true;
      setSavingKey("status");
      setError(null);
      try {
        const metadata = await transitionDocumentStatus(
          graphqlService,
          workspaceId,
          docId,
          statusId,
          documentLifecycle.requestSignal(docId),
        );
        if (!mounted.current) return false;
        // Cache publication notifies sibling consumers; keep it outside React updaters.
        const current = metadataCache?.getModel(docId) ?? model;
        if (current) {
          const next = {
            ...current,
            metadata,
            state: stateFromMetadata(metadata),
          };
          metadataCache?.writeModel(next, "transitionDocumentStatus", docId);
          setModel(next);
        }
        metadataCache?.invalidateIndex();
        return true;
      } catch (err) {
        if (!mounted.current) return false;
        if (isDocumentNotFoundError(err)) {
          documentLifecycle.markNotFound(docId);
        }
        console.warn("[document-metadata] status transition failed", {
          docId,
          statusId,
          error: err,
        });
        setError(
          err instanceof Error
            ? err.message
            : "Failed to transition document status",
        );
        return false;
      } finally {
        writeInFlight.current = false;
        if (mounted.current) setSavingKey(null);
      }
    },
    [
      docId,
      documentLifecycle,
      graphqlService,
      metadataCache,
      model,
      readonly,
      workspaceId,
    ],
  );

  const contextValue = useMemo<DocumentMetadataContextValue>(
    () => ({
      docId,
      readonly,
      model,
      loading,
      savingKey,
      error,
      canConfigureWorkspaceDefaults,
      onConfigureWorkspaceDefaults,
      canOpenGlobalPolicy,
      onOpenGlobalPolicy,
      headerVisibilityOverrides,
      onSetHeaderVisibilityOverride,
      load,
      applyPatch,
      applyStatus,
      tagService,
    }),
    [
      docId,
      readonly,
      model,
      loading,
      savingKey,
      error,
      canConfigureWorkspaceDefaults,
      onConfigureWorkspaceDefaults,
      canOpenGlobalPolicy,
      onOpenGlobalPolicy,
      headerVisibilityOverrides,
      onSetHeaderVisibilityOverride,
      load,
      applyPatch,
      applyStatus,
      tagService,
    ],
  );

  return (
    <DocumentMetadataContext.Provider value={contextValue}>
      {children}
    </DocumentMetadataContext.Provider>
  );
}

export function DocumentMetadataSummary() {
  const { model } = useDocumentMetadataContext();

  return (
    <Box component="section" data-testid="document-metadata-summary">
      <Stack
        maw="var(--myoxus-editor-width)"
        mx="auto"
        px="var(--myoxus-editor-content-padding-inline)"
        w="100%"
      >
        {model ? <HeaderChips model={model} /> : null}
        <TagChips />
      </Stack>
    </Box>
  );
}

export function DocumentMetadataDetails({
  layout = "editor",
}: DocumentMetadataDetailsProps = {}) {
  const t = useI18n();
  const contentId = useId();
  const {
    model,
    loading,
    savingKey,
    error,
    canConfigureWorkspaceDefaults,
    onConfigureWorkspaceDefaults,
    canOpenGlobalPolicy,
    onOpenGlobalPolicy,
    readonly,
    load,
    applyPatch,
    applyStatus,
  } = useDocumentMetadataContext();
  const [expanded, setExpanded] = useState(false);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const visibleFields = model
    ? PROPERTY_METADATA_KEYS.filter(
        (key) => definitionMap(model.definitions).get(key)?.visibleInProperties,
      ).length
    : 0;
  const embedded = layout === "embedded";
  const dialog = layout === "dialog";
  const context = layout === "context";
  const constrained = layout === "editor";
  const tabbed = dialog || embedded;
  const renderFields = (keys: CanonicalMetadataKey[]) =>
    model
      ? keys.map((key) => (
          <MetadataFieldControl
            metadataKey={key}
            key={key}
            model={model}
            onPatch={(metadataKey, value) =>
              void applyPatch(metadataKey, value)
            }
            onStatusChange={(statusId) => void applyStatus(statusId)}
            readonly={readonly}
            savingKey={savingKey}
          />
        ))
      : null;
  const actions = (
    <Group
      data-myoxus-ui-role="document-metadata-actions"
      justify="flex-end"
      wrap="wrap"
    >
      <Button
        data-myoxus-ui-role="button:compact"
        disabled={loading}
        onClick={() => void load()}
        type="button"
        variant="secondary"
      >
        {t["com.myoxus.document-metadata.action.refresh"]()}
      </Button>
      {canConfigureWorkspaceDefaults &&
      onConfigureWorkspaceDefaults &&
      !readonly ? (
        <Button
          data-myoxus-ui-role="button:compact"
          data-testid="document-metadata-configure-defaults"
          onClick={onConfigureWorkspaceDefaults}
          type="button"
          variant="secondary"
        >
          {t["com.myoxus.settings.workspace.documents.section.settings"]()}
        </Button>
      ) : null}
      {canOpenGlobalPolicy && onOpenGlobalPolicy ? (
        <Button
          data-myoxus-ui-role="button:compact"
          data-testid="document-metadata-open-global-policy"
          onClick={onOpenGlobalPolicy}
          type="button"
          variant="secondary"
        >
          {t["admin.documents.metadata-fields.editor.title"]()}
        </Button>
      ) : null}
    </Group>
  );
  const loadState = (
    <>
      {loading ? (
        <MyoxusText component="p" tone="secondary" typographySlot="body-small">
          {t["com.myoxus.document-metadata.loading"]()}
        </MyoxusText>
      ) : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    </>
  );
  const tabbedBody = (
    <Stack data-expanded data-myoxus-ui-role="editor-card-body" id={contentId}>
      {loadState}
      <Tabs data-testid="document-info-tabs" defaultValue="information">
        <TabsList>
          <TabsTrigger data-testid="document-info-tab-edit" value="edit">
            {t["Edit"]()}
          </TabsTrigger>
          <TabsTrigger
            data-testid="document-info-tab-information"
            value="information"
          >
            {t["com.myoxus.document-metadata.tab.information"]()}
          </TabsTrigger>
          <TabsTrigger data-testid="document-info-tab-system" value="system">
            {t["com.myoxus.document-metadata.section.system"]()}
          </TabsTrigger>
        </TabsList>
        <TabsContent layout="stack" value="edit">
          <MyoxusText
            component="p"
            tone="secondary"
            typographySlot="body-small"
          >
            {t["com.myoxus.document-metadata.description"]()}
          </MyoxusText>
          {model ? <IssueList /> : null}
          {model ? (
            <DocumentInfoSection
              testId="document-info-section-metadata"
              title={t["com.myoxus.document-metadata.section.metadata"]()}
            >
              <Grid align="center">{renderFields(PROPERTY_METADATA_KEYS)}</Grid>
            </DocumentInfoSection>
          ) : null}
          {actions}
        </TabsContent>
        <TabsContent layout="stack" value="information">
          {model ? <InformationSection model={model} /> : null}
        </TabsContent>
        <TabsContent layout="stack" value="system">
          {model ? <PresentationSection model={model} /> : null}
          {model ? <SystemFactsSection model={model} /> : null}
        </TabsContent>
      </Tabs>
    </Stack>
  );
  const editorBody = (
    <Stack
      data-expanded={expanded}
      data-myoxus-ui-role="editor-card-body"
      id={contentId}
      py="var(--mantine-spacing-sm)"
      px="var(--mantine-spacing-xs)"
    >
      <MyoxusText component="p" tone="secondary" typographySlot="body-small">
        {t["com.myoxus.document-metadata.description"]()}
      </MyoxusText>
      {loadState}
      {model ? <IssueList /> : null}
      {model ? (
        <DocumentInfoSection
          testId="document-info-section-metadata"
          title={t["com.myoxus.document-metadata.section.metadata"]()}
        >
          <Grid align="center">
            {renderFields(PRIMARY_PROPERTY_METADATA_KEYS)}
          </Grid>
        </DocumentInfoSection>
      ) : null}
      {model ? <PresentationSection model={model} /> : null}
      {model ? <SystemFactsSection model={model} /> : null}
      {model ? (
        <Stack data-myoxus-ui-role="document-metadata-more">
          <DisclosureCardTrigger
            aria-expanded={moreExpanded}
            expanded={moreExpanded}
            data-myoxus-ui-role="editor-section-toggle"
            data-testid="document-metadata-more-toggle"
            onClick={() => setMoreExpanded((value) => !value)}
          >
            <DisclosureCardIndicator expanded={moreExpanded} />
            {t["com.myoxus.document-metadata.more.title"]()}
          </DisclosureCardTrigger>
          {moreExpanded ? (
            <Grid align="center">
              {renderFields(SECONDARY_PROPERTY_METADATA_KEYS)}
            </Grid>
          ) : null}
        </Stack>
      ) : null}
      {actions}
    </Stack>
  );

  if (context) {
    return (
      <Box
        component="section"
        data-myoxus-ui-role="document-context-information"
        data-testid="document-context-information"
      >
        <Stack>
          {loadState}
          {model ? <InformationSection model={model} /> : null}
          {model ? <SystemFactsSection model={model} /> : null}
        </Stack>
      </Box>
    );
  }

  return (
    <Box
      component="section"
      data-myoxus-ui-role="document-metadata"
      data-testid="document-metadata-editor"
    >
      <Stack
        data-document-metadata-layout={layout}
        data-myoxus-ui-role="editor-panel"
        maw={constrained ? "var(--myoxus-editor-width)" : undefined}
        px={
          constrained
            ? "var(--myoxus-editor-content-padding-inline)"
            : undefined
        }
      >
        {tabbed ? (
          tabbedBody
        ) : (
          <DisclosureCard
            component="section"
            expanded={expanded}
            data-myoxus-ui-role="editor-card"
          >
            <Group component="header" data-myoxus-ui-role="editor-card-header">
              <DisclosureCardTrigger
                aria-controls={contentId}
                aria-expanded={expanded}
                expanded={expanded}
                data-myoxus-ui-role="editor-section-toggle"
                data-testid="document-metadata-toggle"
                onClick={() => setExpanded((value) => !value)}
              >
                <DisclosureCardIndicator expanded={expanded} />
                <Box miw={0}>
                  <MyoxusText
                    component="span"
                    data-myoxus-ui-role="editor-card-eyebrow"
                    tone="secondary"
                    typographySlot="label-compact"
                  >
                    {t["com.myoxus.document-metadata.eyebrow"]()}
                  </MyoxusText>
                  <MyoxusText
                    component="span"
                    data-myoxus-ui-role="editor-card-title"
                    tone="primary"
                    typographySlot="section"
                  >
                    {t["com.myoxus.document-metadata.title"]()}
                  </MyoxusText>
                  <MyoxusText
                    component="span"
                    data-myoxus-ui-role="editor-card-meta"
                    tone="secondary"
                    typographySlot="body-small"
                  >
                    {visibleFields
                      ? t["com.myoxus.document-metadata.summary.fields"]({
                          count: String(visibleFields),
                        })
                      : t["com.myoxus.document-metadata.summary.loading"]()}
                  </MyoxusText>
                </Box>
              </DisclosureCardTrigger>
            </Group>
            {expanded ? editorBody : null}
          </DisclosureCard>
        )}
      </Stack>
    </Box>
  );
}

export function DocumentMetadataProvider({
  children,
  ...props
}: DocumentMetadataEditorProps & { children: ReactNode }) {
  const injectedGraphqlService = useService(GraphQLService);
  const metadataCache = useService(DocumentMetadataCacheService);
  const editorSettingService = useService(EditorSettingService);
  const tagService = useService(TagService);
  const workspaceService = useService(WorkspaceService);
  const settings = useLiveData(editorSettingService.editorSetting.settings$);
  const workspaceId = workspaceService.workspace.id;
  const headerVisibilityOverrides =
    settings.documentMetadataHeaderVisibility[workspaceId] ?? {};
  const onSetHeaderVisibilityOverride = useCallback(
    (key: CanonicalMetadataKey, visible: boolean) => {
      const current = editorSettingService.editorSetting.get(
        "documentMetadataHeaderVisibility",
      );
      editorSettingService.editorSetting.set(
        "documentMetadataHeaderVisibility",
        {
          ...current,
          [workspaceId]: {
            ...current[workspaceId],
            [key]: visible,
          },
        },
      );
    },
    [editorSettingService, workspaceId],
  );
  return (
    <DocumentMetadataProviderView
      key={props.docId}
      {...props}
      graphqlService={props.graphqlService ?? injectedGraphqlService}
      metadataCache={props.metadataCache ?? metadataCache}
      headerVisibilityOverrides={
        props.headerVisibilityOverrides ?? headerVisibilityOverrides
      }
      onSetHeaderVisibilityOverride={
        props.onSetHeaderVisibilityOverride ?? onSetHeaderVisibilityOverride
      }
      tagService={props.tagService ?? tagService}
    >
      {children}
    </DocumentMetadataProviderView>
  );
}

export function DocumentMetadataEditor(props: DocumentMetadataEditorProps) {
  const injectedGraphqlService = useService(GraphQLService);
  const metadataCache = useService(DocumentMetadataCacheService);
  const tagService = useService(TagService);
  return (
    <DocumentMetadataEditorView
      {...props}
      graphqlService={props.graphqlService ?? injectedGraphqlService}
      metadataCache={props.metadataCache ?? metadataCache}
      tagService={props.tagService ?? tagService}
    />
  );
}

export { DocumentMetadataCacheService } from "./services/document-metadata-cache";
export { SYSTEM_LIST_METADATA_KEYS } from "./utils";
export { shouldShowDocumentMetadata } from "./visibility";
