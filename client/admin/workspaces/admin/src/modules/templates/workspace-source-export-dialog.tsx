// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { DownloadIcon, PlusIcon, XIcon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Button,
  FormFieldset,
  FormSelect,
  Group,
  IconButton,
  Input,
  InlineActionButton,
  Modal,
  SelectionIndicator,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsSkeleton,
  SimpleGrid,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TagsInput,
  Textarea,
} from "@myoxus/ui-facade";
import { type RefObject, useEffect, useRef, useState } from "react";

import {
  fetchWorkspaceTemplateSourceExport,
  type WorkspaceTemplateSourceExportRequest,
  type WorkspaceTemplateSourceSelection,
} from "../../api/download-api";
import { WorkspacePicker } from "../../components/domain-pickers";
import { useWorkspaceTemplateSourcesQuery } from "./api";
import { parseTemplateExportFilename } from "./status-models";

type Source = ReturnType<
  typeof useWorkspaceTemplateSourcesQuery
>["sources"][number];
type Metadata = WorkspaceTemplateSourceExportRequest["metadata"];
type Draft = Metadata & { sourceType: "document" | "building-block" };
type LanguageSource = { id: number; locale: string; source: Source | null };
type FieldErrors = Partial<
  Record<"templateId" | "version" | "title" | "locale" | "category", string>
>;
type Feedback = { tone: "error" | "success"; message: string };

function sameSource(
  source: Source,
  selected: WorkspaceTemplateSourceSelection | null,
) {
  return selected !== null && source.docId === selected.docId;
}

function selection(source: Source): WorkspaceTemplateSourceSelection {
  return { docId: source.docId };
}

function normalizeLocale(locale: string) {
  return locale.trim().replaceAll("_", "-").toLowerCase();
}

function validLocale(locale: string) {
  return /^[a-z0-9-]+$/i.test(normalizeLocale(locale));
}

function draftFromSource(source: Source): Draft {
  return {
    templateId: source.identifier ?? "",
    version: source.version ?? "1.0.0",
    title: source.title,
    locale: source.locale ?? "",
    description: source.description ?? "",
    category:
      source.category === "building-blocks" ? "" : (source.category ?? ""),
    tags: source.tags,
    titlePolicy:
      source.titlePolicy === "template" ||
      source.titlePolicy === "template-date" ||
      source.titlePolicy === "date"
        ? source.titlePolicy
        : null,
    sourceType:
      source.category === "building-blocks" ? "building-block" : "document",
  };
}

function WorkspaceSources({
  workspaceId,
  selected,
  onSelect,
  disabled = false,
}: {
  workspaceId: string;
  selected: Source | null;
  onSelect: (source: Source | null) => void;
  disabled?: boolean;
}) {
  const i18n = useI18n();
  const [offsets, setOffsets] = useState([0]);
  const [changing, setChanging] = useState(false);
  const { sources, nextOffset, data, error, isLoading, isValidating, mutate } =
    useWorkspaceTemplateSourcesQuery(workspaceId, {
      skip: offsets[offsets.length - 1],
      take: 10,
    });

  // Selection is scoped to current source availability and access. Displayed
  // revisions are informational; the server captures current content on download.
  useEffect(() => {
    if (
      selected &&
      (error ||
        (!isLoading && !sources.some((source) => sameSource(source, selected))))
    )
      onSelect(null);
  }, [error, isLoading, selected, sources, onSelect]);

  const retry = () => {
    onSelect(null);
    void mutate(undefined, { throwOnError: false });
  };
  const numbers = new Intl.NumberFormat(i18n.language);

  if (error)
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("admin.templates.export.sources-error")}
      >
        <Stack>
          {i18n.t("admin.templates.export.sources-error-hint")}
          <Group>
            <Button onClick={retry} disabled={disabled || isValidating}>
              {i18n.t("admin.error.retry")}
            </Button>
          </Group>
        </Stack>
      </SettingsNotice>
    );
  if (isLoading || !data) return <SettingsSkeleton />;

  const collapsed = selected !== null && !changing;
  const visibleSources = collapsed
    ? [sources.find((source) => source.docId === selected.docId) ?? selected]
    : sources;
  return (
    <Stack>
      {sources.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.templates.export.sources-empty")}
          description={i18n.t("admin.templates.export.sources-empty-hint")}
        />
      ) : (
        <Table aria-label={i18n.t("admin.templates.export.sources")}>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Group justify="space-between">
                  {i18n.t("admin.templates.catalog.col.title")}
                  {collapsed ? (
                    <Button
                      disabled={disabled}
                      onClick={() => setChanging(true)}
                    >
                      {i18n.t("admin.templates.export.change-source")}
                    </Button>
                  ) : null}
                </Group>
              </TableHead>
              <TableHead>
                {i18n.t("admin.templates.export.source-type")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.templates.export.source-revision")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleSources.map((source) => {
              const active = sameSource(source, selected);
              return (
                <TableRow key={source.docId}>
                  <TableCell selected={active}>
                    <Group>
                      <SelectionIndicator selected={active} />
                      <InlineActionButton
                        aria-pressed={active}
                        disabled={disabled || isValidating}
                        onClick={() => {
                          onSelect(source);
                          setChanging(false);
                        }}
                      >
                        <SettingsListItemTitle>
                          {source.title}
                        </SettingsListItemTitle>
                      </InlineActionButton>
                    </Group>
                    <SettingsListItemMeta breakAnywhere>
                      {source.docId}
                    </SettingsListItemMeta>
                  </TableCell>
                  <TableCell selected={active}>
                    {source.category === "building-blocks"
                      ? i18n.t("admin.templates.type.building-block")
                      : i18n.t("admin.documents.versioning.scope.doc_template")}
                  </TableCell>
                  <TableCell selected={active}>
                    {i18n.t("admin.templates.export.source-head", {
                      document: numbers.format(source.documentRevision),
                      metadata: numbers.format(source.metadataRevision),
                    })}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {!collapsed && (offsets.length > 1 || nextOffset !== null) ? (
        <Group justify="space-between">
          <Button
            disabled={disabled || offsets.length === 1 || isValidating}
            onClick={() => {
              onSelect(null);
              setOffsets((previous) => previous.slice(0, -1));
            }}
          >
            {i18n.t("admin.common.previous")}
          </Button>
          <Button
            disabled={disabled || nextOffset === null || isValidating}
            onClick={() => {
              if (nextOffset === null) return;
              onSelect(null);
              setOffsets((previous) => [...previous, nextOffset]);
            }}
          >
            {i18n.t("admin.common.next")}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

function WorkspaceExportForm({
  workspaceId,
  onCancel,
}: {
  workspaceId: string;
  onCancel: () => void;
}) {
  const i18n = useI18n();
  const [source, setSource] = useState<Source | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftSourceId = useRef<string | null>(null);
  const [languages, setLanguages] = useState<LanguageSource[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const nextLanguage = useRef(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    target: "field" | "feedback";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => {
    if (focusRequest)
      form.current
        ?.querySelector<HTMLElement>(
          focusRequest.target === "field"
            ? '[aria-invalid="true"]'
            : '[role="alert"]',
        )
        ?.focus();
  }, [focusRequest]);

  const showFeedback = (next: Feedback) => {
    setFeedback(next);
    setFocusRequest({ target: "feedback" });
  };
  const chooseSource = (chosen: Source | null) => {
    setSource(chosen);
    if (chosen) setFeedback(null);
    // Re-selecting the same source preserves edited export fields. A different
    // source prefills its own metadata.
    if (chosen && draftSourceId.current !== chosen.docId) {
      draftSourceId.current = chosen.docId;
      setDraft(draftFromSource(chosen));
      setLanguages([]);
      setErrors({});
    }
  };
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((previous) =>
      previous ? { ...previous, [key]: value } : previous,
    );
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    setFeedback(null);
  };
  const changeLanguage = (id: number, patch: Partial<LanguageSource>) => {
    setLanguages((previous) =>
      previous.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
    setFeedback(null);
  };
  const download = async () => {
    if (flight.current || !source || !draft) return;
    const invalid: FieldErrors = {};
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.templateId.trim()))
      invalid.templateId = i18n.t("admin.templates.export.invalid-identifier");
    if (
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        draft.version.trim(),
      )
    )
      invalid.version = i18n.t("admin.templates.export.invalid-version");
    if (!draft.title.trim())
      invalid.title = i18n.t("admin.state.required-field");
    if (!validLocale(draft.locale))
      invalid.locale = i18n.t("admin.templates.export.invalid-language");
    if (
      draft.sourceType === "document" &&
      draft.category?.trim() === "building-blocks"
    )
      invalid.category = i18n.t("admin.templates.export.invalid-category");
    setErrors(invalid);
    if (invalid.category)
      setSections((previous) => Array.from(new Set([...previous, "metadata"])));
    if (Object.values(invalid).some(Boolean)) {
      setFocusRequest({ target: "field" });
      return;
    }
    const distinct = new Set([normalizeLocale(draft.locale)]);
    for (const language of languages) {
      const locale = normalizeLocale(language.locale);
      if (!language.source || !validLocale(locale) || distinct.has(locale)) {
        setSections((previous) =>
          Array.from(new Set([...previous, "languages"])),
        );
        showFeedback({
          tone: "error",
          message: i18n.t("admin.templates.export.invalid-languages"),
        });
        return;
      }
      distinct.add(locale);
    }
    const controller = new AbortController();
    flight.current = controller;
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetchWorkspaceTemplateSourceExport(
        {
          workspaceId,
          source: selection(source),
          metadata: {
            templateId: draft.templateId.trim(),
            version: draft.version.trim(),
            title: draft.title.trim(),
            locale: normalizeLocale(draft.locale),
            description: draft.description?.trim() || null,
            category:
              draft.sourceType === "building-block"
                ? "building-blocks"
                : draft.category?.trim() || null,
            tags: draft.tags,
            titlePolicy: draft.titlePolicy,
          },
          localizedSources: languages.map((row) => ({
            locale: normalizeLocale(row.locale),
            source: selection(row.source!),
          })),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const failure: {
          code?: string;
          findings?: { field?: string; severity?: string }[];
        } = response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : {};
        if (controller.signal.aborted) return;
        if (failure.code === "SOURCE_UNAVAILABLE") {
          showFeedback({
            tone: "error",
            message: i18n.t("admin.templates.export.source-unavailable"),
          });
        } else if (failure.code === "INVALID_METADATA") {
          const fields: FieldErrors = {};
          for (const finding of failure.findings ?? []) {
            if (finding.severity !== "error" && finding.severity !== "Error")
              continue;
            if (finding.field === "template_id")
              fields.templateId = i18n.t(
                "admin.templates.export.invalid-identifier",
              );
            else if (finding.field === "version")
              fields.version = i18n.t("admin.templates.export.invalid-version");
            else if (finding.field === "title")
              fields.title = i18n.t("admin.state.required-field");
          }
          setErrors(fields);
          showFeedback({
            tone: "error",
            message: i18n.t("admin.templates.export.failed-hint"),
          });
        } else
          showFeedback({
            tone: "error",
            message:
              response.status === 413
                ? i18n.t("admin.templates.export.limit-exceeded")
                : failure.code === "INVALID_LOCALE_MAPPING"
                  ? i18n.t("admin.templates.export.invalid-languages")
                  : response.status === 422
                    ? i18n.t("admin.templates.export.unsupported-content")
                    : i18n.t("admin.templates.export.failed-hint"),
          });
        return;
      }
      if (
        response.headers.get("content-type")?.split(";")[0].trim() !==
        "application/zip"
      )
        throw new Error("Unexpected template download response");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const filename =
        parseTemplateExportFilename(
          response.headers.get("content-disposition"),
        ) ?? `${draft.templateId.trim()}-${draft.version.trim()}.zip`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = filename;
        link.hidden = true;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      showFeedback({
        tone: "success",
        message: i18n.t("admin.templates.export.downloaded", {
          identifier: draft.templateId.trim(),
          version: draft.version.trim(),
        }),
      });
    } catch {
      if (!controller.signal.aborted)
        showFeedback({
          tone: "error",
          message: i18n.t("admin.templates.export.failed-hint"),
        });
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <form
      ref={form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void download();
      }}
    >
      <Stack>
        <FormFieldset variant="unstyled" disabled={busy}>
          <Stack>
            <WorkspaceSources
              workspaceId={workspaceId}
              selected={source}
              onSelect={chooseSource}
              disabled={busy}
            />
            {draft ? (
              <>
                <SimpleGrid cols={3}>
                  <Input
                    label={i18n.t("admin.templates.export.identifier")}
                    title={i18n.t("admin.templates.export.identifier-hint")}
                    value={draft.templateId}
                    onChange={(value) => change("templateId", value)}
                    error={errors.templateId}
                    required
                  />
                  <Input
                    label={i18n.t("admin.templates.versions.col.version")}
                    value={draft.version}
                    onChange={(value) => change("version", value)}
                    error={errors.version}
                    required
                  />
                  <Input
                    label={i18n.t("admin.templates.catalog.col.title")}
                    value={draft.title}
                    onChange={(value) => change("title", value)}
                    error={errors.title}
                    required
                  />
                  <FormSelect
                    label={i18n.t("admin.templates.export.source-type")}
                    value={draft.sourceType}
                    onChange={(value) => {
                      if (value === "document" || value === "building-block")
                        change("sourceType", value);
                    }}
                    data={[
                      {
                        value: "document",
                        label: i18n.t(
                          "admin.documents.versioning.scope.doc_template",
                        ),
                      },
                      {
                        value: "building-block",
                        label: i18n.t("admin.templates.type.building-block"),
                      },
                    ]}
                  />
                  <Input
                    label={i18n.t("admin.templates.export.body-language")}
                    title={i18n.t("admin.templates.export.body-language-hint")}
                    value={draft.locale}
                    onChange={(value) => change("locale", value)}
                    error={errors.locale}
                    required
                  />
                  <FormSelect
                    label={i18n.t("admin.templates.export.title-policy")}
                    value={draft.titlePolicy ?? "default"}
                    onChange={(value) => {
                      if (
                        value === "template" ||
                        value === "template-date" ||
                        value === "date"
                      )
                        change("titlePolicy", value);
                      else change("titlePolicy", null);
                    }}
                    data={[
                      {
                        value: "default",
                        label: i18n.t(
                          "admin.templates.export.title-policy-default",
                        ),
                      },
                      {
                        value: "template",
                        label: i18n.t(
                          "admin.templates.export.title-policy-template",
                        ),
                      },
                      {
                        value: "template-date",
                        label: i18n.t(
                          "admin.templates.export.title-policy-template-date",
                        ),
                      },
                      {
                        value: "date",
                        label: i18n.t(
                          "admin.templates.export.title-policy-date",
                        ),
                      },
                    ]}
                  />
                </SimpleGrid>
                <Accordion
                  multiple
                  value={sections}
                  onChange={(value) =>
                    setSections(Array.isArray(value) ? value : [])
                  }
                >
                  <AccordionItem value="metadata">
                    <AccordionControl>
                      {i18n.t("admin.templates.export.additional-metadata")}
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        <Textarea
                          label={i18n.t(
                            "admin.templates.detail.field.description",
                          )}
                          value={draft.description ?? ""}
                          onChange={(value) => change("description", value)}
                        />
                        <SimpleGrid cols={2}>
                          <Input
                            label={i18n.t(
                              "admin.templates.catalog.col.category",
                            )}
                            disabled={draft.sourceType === "building-block"}
                            value={
                              draft.sourceType === "building-block"
                                ? "building-blocks"
                                : (draft.category ?? "")
                            }
                            onChange={(value) => change("category", value)}
                            error={errors.category}
                          />
                          <TagsInput
                            label={i18n.t("admin.templates.catalog.col.tags")}
                            value={draft.tags ?? []}
                            onChange={(value) => change("tags", value)}
                          />
                        </SimpleGrid>
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                  <AccordionItem value="languages">
                    <AccordionControl>
                      {i18n.t("admin.templates.export.languages")}
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        {languages.map((row, index) => (
                          <FormFieldset
                            key={row.id}
                            legend={i18n.t(
                              "admin.templates.export.language-row",
                              {
                                number: new Intl.NumberFormat(
                                  i18n.language,
                                ).format(index + 1),
                              },
                            )}
                          >
                            <Stack>
                              <Group justify="space-between">
                                <Input
                                  label={i18n.t(
                                    "admin.templates.export.body-language",
                                  )}
                                  value={row.locale}
                                  onChange={(locale) =>
                                    changeLanguage(row.id, { locale })
                                  }
                                  required
                                />
                                <IconButton
                                  type="button"
                                  aria-label={i18n.t(
                                    "admin.templates.export.remove-language",
                                  )}
                                  onClick={() => {
                                    setLanguages((previous) =>
                                      previous.filter(
                                        (item) => item.id !== row.id,
                                      ),
                                    );
                                    setFeedback(null);
                                  }}
                                >
                                  <XIcon />
                                </IconButton>
                              </Group>
                              <WorkspaceSources
                                workspaceId={workspaceId}
                                selected={row.source}
                                onSelect={(chosen) =>
                                  changeLanguage(
                                    row.id,
                                    chosen && !row.locale
                                      ? {
                                          source: chosen,
                                          locale: chosen.locale ?? "",
                                        }
                                      : { source: chosen },
                                  )
                                }
                                disabled={busy}
                              />
                            </Stack>
                          </FormFieldset>
                        ))}
                        <Group>
                          <Button
                            type="button"
                            prefix={<PlusIcon />}
                            onClick={() =>
                              setLanguages((previous) => [
                                ...previous,
                                {
                                  id: nextLanguage.current++,
                                  locale: "",
                                  source: null,
                                },
                              ])
                            }
                          >
                            {i18n.t("admin.templates.export.add-language")}
                          </Button>
                        </Group>
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>
              </>
            ) : null}
          </Stack>
        </FormFieldset>
        {feedback ? (
          <SettingsNotice role="alert" tabIndex={-1} tone={feedback.tone}>
            {feedback.message}
          </SettingsNotice>
        ) : null}
        <Group justify="flex-end">
          <Button type="button" onClick={onCancel}>
            {i18n.t("admin.common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!source || busy}
            loading={busy}
            prefix={<DownloadIcon />}
          >
            {i18n.t("admin.templates.export.download-bundle")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function WorkspaceSourceSelection({ onCancel }: { onCancel: () => void }) {
  const i18n = useI18n();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  return (
    <Stack>
      <WorkspacePicker
        value={workspaceId}
        onChange={setWorkspaceId}
        label={i18n.t("admin.workspaces.panel.title")}
      />
      {workspaceId ? (
        <>
          <SettingsListItemMeta breakAnywhere>
            {workspaceId}
          </SettingsListItemMeta>
          <WorkspaceExportForm
            key={workspaceId}
            workspaceId={workspaceId}
            onCancel={onCancel}
          />
        </>
      ) : (
        <>
          <SettingsEmptyState
            title={i18n.t("admin.templates.assignments.empty-workspace-title")}
          />
          <Group justify="flex-end">
            <Button onClick={onCancel}>{i18n.t("admin.common.cancel")}</Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

export function WorkspaceSourceExportDialog({
  open,
  onOpenChange,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const i18n = useI18n();
  return (
    <Modal
      open={open}
      width="xl"
      onOpenChange={onOpenChange}
      title={i18n.t("admin.templates.export.workspace-title")}
      description={i18n.t("admin.templates.export.choose-source")}
      returnFocusRef={returnFocusRef}
      scrollable
    >
      {open ? (
        <WorkspaceSourceSelection onCancel={() => onOpenChange(false)} />
      ) : null}
    </Modal>
  );
}
