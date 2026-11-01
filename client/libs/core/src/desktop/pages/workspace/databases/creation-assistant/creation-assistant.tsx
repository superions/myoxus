// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkspaceFolderOption } from "@myoxus/core/modules/workspace-pages";
import {
  DatabaseStarterTemplateCategory,
  type DatabaseStarterTemplateFragment,
  ProjectStructurePreset,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  DatabaseKanbanViewIcon,
  DatabaseTableViewIcon,
} from "@myoxus/icons/react";
import {
  Badge,
  Button,
  EmptyState,
  FormSelect,
  Group,
  Input,
  Modal,
  MyoxusText,
  Notice,
  OnboardingActions,
  OnboardingFooter,
  OnboardingStep,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SelectionCardGrid,
  SelectionCardSkeletonGrid,
  Stack,
  Stepper,
  StepperStep,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Textarea,
  ThemeIcon,
} from "@myoxus/ui-facade";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  databaseViewKindLabel,
  starterTemplateCopy,
  starterTemplateProfileLabel,
} from "./copy";
import {
  buildCreationRequest,
  createInitialCreationState,
  type CreationAssistantRequest,
  type CreationAssistantState,
  type CreationAssistantStep,
  type CreationIntent,
  resolveTemplateSelection,
  selectedTemplate,
  TEMPLATE_SEARCH_THRESHOLD,
  templatesForIntent,
  validateCreationDetails,
} from "./model";

type CreationResult = { databaseId: string; initialViewId?: string | null };

import {
  ProjectCreationAssistant,
  type ProjectCreationRetentionSlot,
} from "./project-creation-assistant";

export type DatabaseCreationAssistantProps = {
  open: boolean;
  projectRetention?: ProjectCreationRetentionSlot;
  intent: CreationIntent;
  initialStructurePreset?: ProjectStructurePreset;
  templates: readonly DatabaseStarterTemplateFragment[];
  templatesLoading: boolean;
  templatesError: boolean;
  folders: readonly WorkspaceFolderOption[];
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  onRetryTemplates: () => void | Promise<unknown>;
  onCreate: (request: CreationAssistantRequest) => Promise<CreationResult>;
  onLinkFolder: (databaseId: string, folderId: string) => void | Promise<void>;
  onComplete: (
    databaseId: string,
    initialViewId?: string | null,
    setupRequestId?: string,
  ) => void;
};

function errorText(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return null;
}

function templateMatchesSearch(
  template: DatabaseStarterTemplateFragment,
  query: string,
  name: string,
  description: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [template.id, template.name, template.description, name, description]
    .join("\n")
    .toLocaleLowerCase()
    .includes(normalized);
}

function TemplateStep({
  state,
  templates,
  loading,
  failed,
  onRetry,
  onChange,
}: {
  state: CreationAssistantState;
  templates: readonly DatabaseStarterTemplateFragment[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onChange: (next: CreationAssistantState) => void;
}) {
  const t = useI18n();
  const localizedTemplates = useMemo(
    () =>
      templates.map((template) => ({
        template,
        name: starterTemplateCopy(t, template.nameKey, template.name),
        description: starterTemplateCopy(
          t,
          template.descriptionKey,
          template.description,
        ),
      })),
    [t, templates],
  );
  const showSearch = templates.length >= TEMPLATE_SEARCH_THRESHOLD;
  const visibleTemplates = localizedTemplates.filter(
    ({ template, name, description }) =>
      templateMatchesSearch(template, state.search, name, description),
  );

  if (loading) {
    return (
      <OnboardingStep>
        <SelectionCardSkeletonGrid data-testid="database-assistant-template-loading" />
      </OnboardingStep>
    );
  }

  if (failed) {
    return (
      <OnboardingStep>
        <Notice
          tone="error"
          title={t["com.myoxus.template-list.load-error"]()}
          data-testid="database-assistant-template-error"
        >
          <Group>
            <Button variant="secondary" onClick={onRetry}>
              {t["Retry"]()}
            </Button>
          </Group>
        </Notice>
      </OnboardingStep>
    );
  }

  return (
    <OnboardingStep>
      {showSearch ? (
        <Input
          block
          label={t["com.myoxus.database.template.search.label"]()}
          placeholder={t["com.myoxus.database.template.search.placeholder"]()}
          value={state.search}
          onChange={(search) => {
            const selected = localizedTemplates.find(
              ({ template }) => template.id === state.templateId,
            );
            const selectionStillVisible = selected
              ? templateMatchesSearch(
                  selected.template,
                  search,
                  selected.name,
                  selected.description,
                )
              : false;
            onChange({
              ...state,
              search,
              templateId: selectionStillVisible ? state.templateId : null,
            });
          }}
          data-testid="database-assistant-template-search"
        />
      ) : null}
      {visibleTemplates.length ? (
        <RadioCardGroup
          value={state.templateId}
          onChange={(templateId) => {
            const template = templates.find(
              (candidate) => candidate.id === templateId,
            );
            onChange({
              ...state,
              templateId,
              includeSampleRows:
                state.includeSampleRows && (template?.sampleRowCount ?? 0) > 0,
            });
          }}
          label={t["com.myoxus.database.template.picker.label"]()}
        >
          <SelectionCardGrid>
            {visibleTemplates.map(({ template, name, description }) => (
              <RadioCard
                key={template.id}
                value={template.id}
                data-testid={`database-assistant-template-${template.id}`}
              >
                <Group align="flex-start" wrap="nowrap">
                  <ThemeIcon variant="light">
                    {template.category ===
                    DatabaseStarterTemplateCategory.Project ? (
                      <DatabaseKanbanViewIcon />
                    ) : (
                      <DatabaseTableViewIcon />
                    )}
                  </ThemeIcon>
                  <Stack flex={1} gap="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <MyoxusText typographySlot="nav">{name}</MyoxusText>
                      <RadioCardIndicator />
                    </Group>
                    <Group gap="xs" wrap="wrap">
                      <Badge tone="info">
                        {starterTemplateProfileLabel(t, template.category)}
                      </Badge>
                      {template.defaultViewKinds.map((viewKind) => (
                        <Badge key={viewKind} tone="neutral">
                          {databaseViewKindLabel(t, viewKind)}
                        </Badge>
                      ))}
                      <Badge tone="neutral">
                        {t["com.myoxus.database.template.sample-count"]({
                          count: String(template.sampleRowCount),
                        })}
                      </Badge>
                    </Group>
                    <MyoxusText tone="secondary">{description}</MyoxusText>
                  </Stack>
                </Group>
              </RadioCard>
            ))}
          </SelectionCardGrid>
        </RadioCardGroup>
      ) : (
        <EmptyState
          title={t["com.myoxus.database.template.no-results"]()}
          data-testid="database-assistant-template-empty"
        />
      )}
    </OnboardingStep>
  );
}

function DetailsStep({
  state,
  folders,
  titleError,
  descriptionError,
  titleRef,
  descriptionRef,
  onChange,
}: {
  state: CreationAssistantState;
  folders: readonly WorkspaceFolderOption[];
  titleError: string | null;
  descriptionError: string | null;
  titleRef: RefObject<HTMLInputElement | null>;
  descriptionRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (next: CreationAssistantState) => void;
}) {
  const t = useI18n();
  return (
    <OnboardingStep data-myoxus-ui-role="database-creation-details-step">
      <Input
        ref={titleRef}
        block
        label={t["com.myoxus.database.create.database-name"]()}
        value={state.title}
        error={titleError}
        onChange={(title) => onChange({ ...state, title })}
        data-testid="database-assistant-title"
      />
      <Textarea
        ref={descriptionRef}
        autosize
        minRows={3}
        maxRows={6}
        label={t["com.myoxus.common.description"]()}
        value={state.description}
        error={descriptionError}
        onChange={(description) => onChange({ ...state, description })}
        data-testid="database-assistant-description"
      />
      <FormSelect
        clearable
        searchable
        label={t["com.myoxus.m.selector.where-folder"]()}
        placeholder={t["com.myoxus.workspace-pages.move.no-folder"]()}
        value={state.folderId}
        data={[...folders]}
        onChange={(folderId) => onChange({ ...state, folderId })}
        onClear={() => onChange({ ...state, folderId: null })}
        data-testid="database-assistant-folder"
      />
    </OnboardingStep>
  );
}

function SetupStep({
  state,
  template,
  onChange,
}: {
  state: CreationAssistantState;
  template: DatabaseStarterTemplateFragment;
  onChange: (next: CreationAssistantState) => void;
}) {
  const t = useI18n();
  const supportsSamples = template.sampleRowCount > 0;
  return (
    <OnboardingStep data-myoxus-ui-role="database-creation-setup-step">
      <Stack gap="xs">
        <Switch
          checked={state.includeSampleRows && supportsSamples}
          disabled={!supportsSamples}
          onChange={(includeSampleRows) =>
            onChange({
              ...state,
              includeSampleRows: includeSampleRows && supportsSamples,
            })
          }
          data-testid="database-assistant-samples"
        >
          {t["com.myoxus.database.template.include-samples"]()}
        </Switch>
        <MyoxusText tone="secondary">
          {supportsSamples
            ? t["com.myoxus.database.template.sample-count"]({
                count: String(template.sampleRowCount),
              })
            : t["com.myoxus.database.template.samples-unavailable"]()}
        </MyoxusText>
      </Stack>
    </OnboardingStep>
  );
}

function ReviewStep({
  state,
  template,
  folders,
}: {
  state: CreationAssistantState;
  template: DatabaseStarterTemplateFragment;
  folders: readonly WorkspaceFolderOption[];
}) {
  const t = useI18n();
  const templateName = starterTemplateCopy(t, template.nameKey, template.name);
  const folder = folders.find(
    (candidate) => candidate.value === state.folderId,
  );
  const rows = [
    {
      label: t["com.myoxus.database.create.database-name"](),
      value: state.title.trim(),
    },
    {
      label: t["com.myoxus.common.description"](),
      value: state.description.trim(),
    },
    {
      label: t["com.myoxus.m.selector.where-folder"](),
      value: folder?.label ?? t["com.myoxus.workspace-pages.move.no-folder"](),
    },
    {
      label: t["com.myoxus.database.template.picker.label"](),
      value: templateName,
    },
    {
      label: t["com.myoxus.database.view.type"](),
      value: (
        <Group gap="xs" wrap="wrap">
          {template.defaultViewKinds.map((viewKind) => (
            <Badge key={viewKind} tone="neutral">
              {databaseViewKindLabel(t, viewKind)}
            </Badge>
          ))}
        </Group>
      ),
    },
    {
      label: t["com.myoxus.database.template.include-samples"](),
      value: t["com.myoxus.database.template.sample-count"]({
        count: String(state.includeSampleRows ? template.sampleRowCount : 0),
      }),
    },
  ];

  return (
    <OnboardingStep data-myoxus-ui-role="database-creation-review-step">
      <Table data-testid="database-assistant-review">
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableHead scope="row">{row.label}</TableHead>
              <TableCell>{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </OnboardingStep>
  );
}

export function DatabaseCreationAssistant(
  props: DatabaseCreationAssistantProps,
) {
  return props.intent === "project" ? (
    <ProjectCreationAssistant {...props} />
  ) : (
    <GenericDatabaseCreationAssistant {...props} />
  );
}

function GenericDatabaseCreationAssistant({
  open,
  templates,
  templatesLoading,
  templatesError,
  folders,
  creating,
  onOpenChange,
  onRetryTemplates,
  onCreate,
  onLinkFolder,
  onComplete,
}: DatabaseCreationAssistantProps) {
  const intent = "database" as const;
  const t = useI18n();
  const defaultTitle = t["com.myoxus.database.create.database-title"]();
  const [state, setState] = useState(() =>
    createInitialCreationState(defaultTitle),
  );
  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [createdDatabaseId, setCreatedDatabaseId] = useState<string | null>(
    null,
  );
  const [folderLinkError, setFolderLinkError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [linkingFolder, setLinkingFolder] = useState(false);
  const submittingRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const intentTemplates = useMemo(
    () => templatesForIntent(templates, intent),
    [intent, templates],
  );
  const template = selectedTemplate(intentTemplates, state.templateId);
  const busy = creating || linkingFolder || submitting;

  useEffect(() => {
    if (!open) return;
    setState(createInitialCreationState(defaultTitle));
    setTitleError(null);
    setDescriptionError(null);
    setCreationError(null);
    setCreatedDatabaseId(null);
    setFolderLinkError(false);
    setSubmitting(false);
    submittingRef.current = false;
  }, [defaultTitle, intent, open]);

  useEffect(() => {
    if (!open || templatesLoading || templatesError) return;
    setState((current) => {
      const templateId = resolveTemplateSelection(
        intentTemplates,
        current.templateId,
      );
      return templateId === current.templateId
        ? current
        : { ...current, templateId, includeSampleRows: false };
    });
  }, [intentTemplates, open, templatesError, templatesLoading]);

  const updateState = useCallback((next: CreationAssistantState) => {
    setState(next);
    if (next.title.trim()) setTitleError(null);
    if (next.description.trim()) setDescriptionError(null);
    setCreationError(null);
  }, []);

  const goNext = useCallback(() => {
    if (state.step === 0) {
      if (template) setState((current) => ({ ...current, step: 1 }));
      return;
    }
    if (state.step === 1) {
      const validation = validateCreationDetails(state);
      const nextTitleError = validation.titleRequired
        ? t["com.myoxus.database.create.assistant.name-required"]()
        : null;
      const nextDescriptionError = validation.descriptionRequired
        ? t["com.myoxus.database.create.assistant.overview-required"]()
        : null;
      setTitleError(nextTitleError);
      setDescriptionError(nextDescriptionError);
      if (nextTitleError) {
        titleRef.current?.focus();
        return;
      }
      if (nextDescriptionError) {
        descriptionRef.current?.focus();
        return;
      }
      setState((current) => ({ ...current, step: 2 }));
      return;
    }
    if (state.step === 2) {
      setState((current) => ({ ...current, step: 3 }));
    }
  }, [state, t, template]);

  const goBack = useCallback(() => {
    setCreationError(null);
    setState((current) => ({
      ...current,
      step: Math.max(0, current.step - 1) as CreationAssistantStep,
    }));
  }, []);

  const completeFolderLink = useCallback(
    async (databaseId: string, folderId: string) => {
      setLinkingFolder(true);
      try {
        await onLinkFolder(databaseId, folderId);
        setFolderLinkError(false);
      } catch {
        setFolderLinkError(true);
        return;
      } finally {
        setLinkingFolder(false);
      }
      onComplete(databaseId);
    },
    [onComplete, onLinkFolder],
  );

  const submit = useCallback(async () => {
    if (!template || createdDatabaseId || busy || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setCreationError(null);
    try {
      const result = await onCreate(buildCreationRequest(state, template));
      setCreatedDatabaseId(result.databaseId);
      if (state.folderId) {
        await completeFolderLink(result.databaseId, state.folderId);
      } else {
        onComplete(result.databaseId);
      }
    } catch (error) {
      setCreationError(
        errorText(error) ??
          t["com.myoxus.database.create.assistant.create-error.title"](),
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    busy,
    completeFolderLink,
    createdDatabaseId,
    onComplete,
    onCreate,
    state,
    t,
    template,
  ]);

  const modalTitle =
    t["com.myoxus.database.create.assistant.database-dialog.title"]();
  const selectedFolder = folders.find(
    (folder) => folder.value === state.folderId,
  );

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
      persistent={busy}
      title={modalTitle}
      width="xl"
      scrollable
      contentOptions={{ "data-testid": "database-creation-assistant" }}
    >
      <Stack gap="lg">
        <Stepper
          active={state.step}
          ariaLabel={t["com.myoxus.database.template.steps"]()}
          uiRole="database-creation-stepper"
        >
          <StepperStep
            label={t["com.myoxus.database.template.step.template"]()}
          />
          <StepperStep
            label={t["com.myoxus.database.create.assistant.step.details"]()}
          />
          <StepperStep
            label={t["com.myoxus.database.create.assistant.step.setup"]()}
          />
          <StepperStep
            label={t["com.myoxus.database.create.assistant.step.review"]()}
          />
        </Stepper>

        {state.step === 0 ? (
          <TemplateStep
            state={state}
            templates={intentTemplates}
            loading={templatesLoading}
            failed={templatesError}
            onRetry={() => void onRetryTemplates()}
            onChange={updateState}
          />
        ) : null}
        {state.step === 1 ? (
          <DetailsStep
            state={state}
            folders={folders}
            titleError={titleError}
            descriptionError={descriptionError}
            titleRef={titleRef}
            descriptionRef={descriptionRef}
            onChange={updateState}
          />
        ) : null}
        {state.step === 2 && template ? (
          <SetupStep state={state} template={template} onChange={updateState} />
        ) : null}
        {state.step === 3 && template ? (
          <Stack gap="md">
            <ReviewStep state={state} template={template} folders={folders} />
            {creationError ? (
              <Notice
                tone="error"
                title={t[
                  "com.myoxus.database.create.assistant.create-error.title"
                ]()}
                data-testid="database-assistant-create-error"
              >
                {creationError}
              </Notice>
            ) : null}
            {createdDatabaseId && folderLinkError ? (
              <Notice
                tone="warning"
                title={t[
                  "com.myoxus.database.create.assistant.folder-warning.title"
                ]()}
                data-testid="database-assistant-folder-warning"
              >
                {t[
                  "com.myoxus.database.create.assistant.folder-warning.description"
                ]({
                  folder:
                    selectedFolder?.label ??
                    t["com.myoxus.m.selector.where-folder"](),
                })}
              </Notice>
            ) : null}
          </Stack>
        ) : null}

        <OnboardingFooter bordered>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t["Cancel"]()}
          </Button>
          <OnboardingActions>
            {state.step > 0 && !createdDatabaseId ? (
              <Button variant="secondary" disabled={busy} onClick={goBack}>
                {t["common.back"]()}
              </Button>
            ) : null}
            {state.step < 3 ? (
              <Button
                variant="primary"
                onClick={goNext}
                disabled={
                  busy ||
                  (state.step === 0 &&
                    (!template || templatesLoading || templatesError))
                }
                data-testid="database-assistant-next"
              >
                {t["common.next"]()}
              </Button>
            ) : createdDatabaseId && folderLinkError && state.folderId ? (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void onComplete(createdDatabaseId)}
                >
                  {t["com.myoxus.database.embed.open"]()}
                </Button>
                <Button
                  variant="primary"
                  loading={linkingFolder}
                  onClick={() =>
                    void completeFolderLink(createdDatabaseId, state.folderId!)
                  }
                  data-testid="database-assistant-retry-folder"
                >
                  {t[
                    "com.myoxus.database.create.assistant.folder-warning.retry"
                  ]()}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                loading={busy}
                disabled={!template || Boolean(createdDatabaseId)}
                onClick={() => void submit()}
                data-testid="database-assistant-create"
              >
                {t["com.myoxus.database.create.assistant.submit-database"]()}
              </Button>
            )}
          </OnboardingActions>
        </OnboardingFooter>
      </Stack>
    </Modal>
  );
}
