// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import { getPrimaryViewOrNull } from "@myoxus/core/modules/database/model";
import { workspaceTagColorRoleOrGrey } from "@myoxus/core/modules/tag";
import {
  type DatabaseCsvColumnMappingInput,
  DatabaseCsvDelimiter,
  DatabaseTaskRelationReason,
  type DatabaseCsvDialectInput,
  DatabaseFieldKind,
  DatabaseJsonImportModeType,
  DatabaseJsonConflictStrategyType,
  databasesQuery,
  DatabaseWorkspaceTagImportAction,
  importDatabaseCsvMutation,
  importDatabaseJsonMutation,
  importDatabaseNotionMutation,
  previewDatabaseCsvImportMutation,
  previewDatabaseJsonImportMutation,
  previewDatabaseNotionImportMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Button,
  Checkbox,
  ColorSwatch,
  FormRow,
  FormSelect,
  Group,
  HiddenFileInput,
  Input,
  Modal,
  MyoxusText,
  notify,
  Stack,
  Stepper,
  StepperStep,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { taskBlockedByReason } from "./relation/task-blocked-by-reason";
import { taskParentReason } from "./relation/task-parent-reason";

type I18nShape = ReturnType<typeof useI18n>;

/** JSON graph diagnostics carry stable reason codes. Unknown diagnostics keep
 * their server message; prose is never parsed to infer a graph policy reason. */
function jsonDiagnosticMessage(
  t: I18nShape,
  diagnostic: { code: string; message: string },
) {
  const reason = Object.values(DatabaseTaskRelationReason).find(
    (reason) =>
      diagnostic.code === `MIX_DATABASE_TASK_RELATION_INVALID_${reason}`,
  );
  if (reason) return taskParentReason(t, reason);
  const blockerReason = Object.values(DatabaseTaskRelationReason).find(
    (reason) =>
      diagnostic.code === `MIX_DATABASE_TASK_BLOCKED_BY_INVALID_${reason}`,
  );
  if (blockerReason) return taskBlockedByReason(t, blockerReason);
  if (diagnostic.code === "MIX_DATABASE_JSON_BLOCKER_TARGET_OMITTED")
    return t["com.myoxus.database.json-import.blocker-target-omitted"]();
  if (diagnostic.code === "MIX_DATABASE_JSON_PARENT_TARGET_OMITTED")
    return t["com.myoxus.database.json-import.parent-target-omitted"]();
  return diagnostic.message;
}
type CsvImportStep = 0 | 1 | 2;
type JsonImportStep = 0 | 1 | 2;

type CsvImportMapping = {
  sourceIndex: number;
  importColumn: boolean;
  sourceHeader: string;
  fieldName: string;
  fieldType: DatabaseFieldKind;
  isTitle: boolean;
};

const CSV_IMPORT_FIELD_TYPES = [
  DatabaseFieldKind.Title,
  DatabaseFieldKind.Text,
  DatabaseFieldKind.Number,
  DatabaseFieldKind.Percent,
  DatabaseFieldKind.Currency,
  DatabaseFieldKind.Duration,
  DatabaseFieldKind.Date,
  DatabaseFieldKind.Checkbox,
  DatabaseFieldKind.Select,
  DatabaseFieldKind.MultiSelect,
  DatabaseFieldKind.Tags,
  DatabaseFieldKind.Url,
  DatabaseFieldKind.Email,
  DatabaseFieldKind.Phone,
  DatabaseFieldKind.User,
  DatabaseFieldKind.Users,
] as const;

const CSV_DELIMITERS = [
  DatabaseCsvDelimiter.Auto,
  DatabaseCsvDelimiter.Comma,
  DatabaseCsvDelimiter.Semicolon,
  DatabaseCsvDelimiter.Tab,
  DatabaseCsvDelimiter.Pipe,
  DatabaseCsvDelimiter.Custom,
] as const;

function databaseTitleFromFile(file: File) {
  return file.name.replace(/\.[^.]+$/, "").trim() || file.name;
}

function importErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultCsvDialect(): DatabaseCsvDialectInput {
  return {
    delimiter: DatabaseCsvDelimiter.Auto,
    doubleQuote: true,
  };
}

function csvDialectForInput(
  dialect: DatabaseCsvDialectInput,
): DatabaseCsvDialectInput {
  const customDelimiter = dialect.customDelimiter?.trim();
  return {
    delimiter: dialect.delimiter,
    customDelimiter:
      dialect.delimiter === DatabaseCsvDelimiter.Custom && customDelimiter
        ? customDelimiter
        : null,
    quote: dialect.quote?.trim() || null,
    escape: dialect.escape?.trim() || null,
    doubleQuote: dialect.doubleQuote ?? true,
  };
}

function csvMappingForInput(
  mapping: CsvImportMapping[],
): DatabaseCsvColumnMappingInput[] {
  return mapping.map((column) => ({
    sourceIndex: column.sourceIndex,
    importColumn: column.importColumn,
    fieldName: column.fieldName,
    fieldType: column.fieldType,
    isTitle: column.isTitle,
  }));
}

function csvImportStepFromPreview(
  preview: {
    errors: unknown[];
    appliedMapping: CsvImportMapping[];
  } | null,
): CsvImportStep {
  if (!preview) return 0;
  return preview.errors.length ? 1 : 2;
}

function csvImportMappingIsValid(mapping: CsvImportMapping[]) {
  const imported = mapping.filter((column) => column.importColumn);
  return (
    imported.length > 0 &&
    imported.filter((column) => column.isTitle).length === 1 &&
    imported.every((column) => column.fieldName.trim().length > 0)
  );
}

function delimiterLabel(t: I18nShape, delimiter: DatabaseCsvDelimiter) {
  switch (delimiter) {
    case DatabaseCsvDelimiter.Auto:
      return t["com.myoxus.database.csv.delimiter.auto"]();
    case DatabaseCsvDelimiter.Comma:
      return t["com.myoxus.database.csv.delimiter.comma"]();
    case DatabaseCsvDelimiter.Semicolon:
      return t["com.myoxus.database.csv.delimiter.semicolon"]();
    case DatabaseCsvDelimiter.Tab:
      return t["com.myoxus.database.csv.delimiter.tab"]();
    case DatabaseCsvDelimiter.Pipe:
      return t["com.myoxus.database.csv.delimiter.pipe"]();
    case DatabaseCsvDelimiter.Custom:
      return t["com.myoxus.database.csv.delimiter.custom"]();
    default:
      return delimiter;
  }
}

function databaseFieldTypeLabel(t: I18nShape, kind: DatabaseFieldKind) {
  switch (kind) {
    case DatabaseFieldKind.Checkbox:
      return t["com.myoxus.database.field.type.checkbox"]();
    case DatabaseFieldKind.Date:
      return t["com.myoxus.database.field.type.date"]();
    case DatabaseFieldKind.MultiSelect:
      return t["com.myoxus.database.field.type.multi-select"]();
    case DatabaseFieldKind.Tags:
      return t["Tags"]();
    case DatabaseFieldKind.Number:
      return t["com.myoxus.database.field.type.number"]();
    case DatabaseFieldKind.Percent:
      return t["com.myoxus.database.field.type.percent"]();
    case DatabaseFieldKind.Currency:
      return t["com.myoxus.database.field.type.currency"]();
    case DatabaseFieldKind.Duration:
      return t["com.myoxus.database.field.type.duration"]();
    case DatabaseFieldKind.Select:
      return t["com.myoxus.database.field.type.select"]();
    case DatabaseFieldKind.Text:
      return t["com.myoxus.database.field.type.text"]();
    case DatabaseFieldKind.Title:
      return t["com.myoxus.database.field.type.title"]();
    case DatabaseFieldKind.Url:
      return t["com.myoxus.database.field.type.url"]();
    case DatabaseFieldKind.Email:
      return t["com.myoxus.database.field.type.email"]();
    case DatabaseFieldKind.Phone:
      return t["com.myoxus.database.field.type.phone"]();
    case DatabaseFieldKind.User:
      return t["com.myoxus.database.field.type.user"]();
    case DatabaseFieldKind.Users:
      return t["com.myoxus.database.field.type.users"]();
    default:
      return kind;
  }
}

function CsvDiagnostics({
  diagnostics,
}: {
  diagnostics: Array<{ code: string; message: string; row?: number | null }>;
}) {
  const t = useI18n();
  if (!diagnostics.length) return null;
  return (
    <SurfaceList label={t["com.myoxus.database.csv-import.diagnostics"]()}>
      {diagnostics.map((diagnostic, index) => (
        <SurfaceListItem key={`${diagnostic.code}-${index}`} density="compact">
          <SurfaceListText kind="title" component="span">
            {diagnostic.row ? `${diagnostic.row}: ` : null}
            {diagnostic.message}
          </SurfaceListText>
          <Badge tone="warning">{diagnostic.code}</Badge>
        </SurfaceListItem>
      ))}
    </SurfaceList>
  );
}

function JsonDiagnostics({
  diagnostics,
}: {
  diagnostics: Array<{ code: string; message: string; path?: string | null }>;
}) {
  const t = useI18n();
  if (!diagnostics.length) return null;
  return (
    <SurfaceList label={t["com.myoxus.database.json-import.diagnostics"]()}>
      {diagnostics.map((diagnostic, index) => (
        <SurfaceListItem key={`${diagnostic.code}-${index}`} density="compact">
          <MyoxusText>
            {diagnostic.path ? `${diagnostic.path}: ` : null}
            {jsonDiagnosticMessage(t, diagnostic)}
          </MyoxusText>
          <Badge tone="warning">{diagnostic.code}</Badge>
        </SurfaceListItem>
      ))}
    </SurfaceList>
  );
}

function WorkspaceTagDiagnostics({
  diagnostics,
}: {
  diagnostics: ReadonlyArray<{
    sourceId?: string | null;
    targetId?: string | null;
    name: string;
    slug: string;
    sourceColor?: string | null;
    colorRole: string;
    action: DatabaseWorkspaceTagImportAction;
    affectedRows: number[];
    affectedFields: string[];
    message: string;
  }>;
}) {
  const t = useI18n();
  if (!diagnostics.length) return null;
  const actionLabel = (action: DatabaseWorkspaceTagImportAction) => {
    switch (action) {
      case DatabaseWorkspaceTagImportAction.Create:
        return t["Create"]();
      case DatabaseWorkspaceTagImportAction.Reuse:
        return t["com.myoxus.database.import.workspace-tags.action.reuse"]();
      case DatabaseWorkspaceTagImportAction.ArchivedReference:
        return t["com.myoxus.tags.status.archived"]();
      case DatabaseWorkspaceTagImportAction.Rejected:
        return t["com.myoxus.database.import.workspace-tags.action.rejected"]();
      default:
        return action;
    }
  };
  return (
    <SurfaceList label={t["Tags"]()}>
      {diagnostics.map((diagnostic) => (
        <SurfaceListItem
          key={`${diagnostic.sourceId ?? diagnostic.targetId ?? diagnostic.slug}-${diagnostic.action}`}
          density="compact"
        >
          <SurfaceListItemIcon>
            <ColorSwatch
              tagColorRole={workspaceTagColorRoleOrGrey(diagnostic.colorRole)}
              shape="circle"
            />
          </SurfaceListItemIcon>
          <SurfaceListItemMain>
            <Group justify="space-between" wrap="wrap">
              <SurfaceListText kind="title" component="span">
                {diagnostic.name}
              </SurfaceListText>
              <Badge
                tone={
                  diagnostic.action ===
                  DatabaseWorkspaceTagImportAction.Rejected
                    ? "error"
                    : diagnostic.action ===
                        DatabaseWorkspaceTagImportAction.Create
                      ? "info"
                      : "neutral"
                }
              >
                {actionLabel(diagnostic.action)}
              </Badge>
            </Group>
            <SurfaceListMeta>{diagnostic.slug}</SurfaceListMeta>
            <MyoxusText tone="secondary">{diagnostic.message}</MyoxusText>
            <Group gap="xs" wrap="wrap">
              {diagnostic.sourceColor &&
              diagnostic.sourceColor !== diagnostic.colorRole ? (
                <MyoxusText tone="secondary">
                  {diagnostic.sourceColor} -&gt; {diagnostic.colorRole}
                </MyoxusText>
              ) : null}
              {diagnostic.affectedRows.length ? (
                <MyoxusText tone="secondary">
                  {t["com.myoxus.database.import.workspace-tags.affected-rows"](
                    { rows: diagnostic.affectedRows.join(", ") },
                  )}
                </MyoxusText>
              ) : null}
              {diagnostic.affectedFields.length ? (
                <MyoxusText tone="secondary">
                  {t[
                    "com.myoxus.database.import.workspace-tags.affected-fields"
                  ]({ fields: diagnostic.affectedFields.join(", ") })}
                </MyoxusText>
              ) : null}
            </Group>
          </SurfaceListItemMain>
        </SurfaceListItem>
      ))}
    </SurfaceList>
  );
}

export interface DatabaseImportControllerOptions {
  workspaceId: string | null;
  /** Managed hosts merge admitted contents into this exact existing target. */
  targetDatabaseId?: string;
  targetDatabaseTitle?: string;
  /** Called only after a server-backed import has completed successfully. */
  onImported: (databaseId: string, viewId: string | null) => void;
  /** Optional inventory-specific reset performed before navigation. */
  onApplied?: () => void | Promise<void>;
}

export interface DatabaseImportController {
  csvBusy: boolean;
  jsonBusy: boolean;
  notionBusy: boolean;
  openCsvPicker: () => void;
  openJsonPicker: () => void;
  openNotionPicker: () => void;
  /** Hidden file inputs and preview Modals; mount once beside the owning page. */
  surfaces: ReactNode;
}

/**
 * Owns the native CSV/JSON/Notion import workflow used by Database
 * inventory and detail routes. Callers expose entry points only; file inputs,
 * previews and mutations stay here. Managed JSON imports keep one captured
 * target and merge admitted contents; inventory/Generic imports create normally.
 */
export function useDatabaseImportController({
  workspaceId,
  targetDatabaseId,
  targetDatabaseTitle,
  onImported,
  onApplied,
}: DatabaseImportControllerOptions): DatabaseImportController {
  const t = useI18n();
  const importScope = JSON.stringify([workspaceId, targetDatabaseId]);
  const currentImportScope = useRef(importScope);
  currentImportScope.current = importScope;
  const revalidate = useMutateQueryResource();
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const jsonFileInputRef = useRef<HTMLInputElement>(null);
  const notionFileInputRef = useRef<HTMLInputElement>(null);
  const previewCsv = useMutation({
    mutation: previewDatabaseCsvImportMutation,
  });
  const importCsv = useMutation({ mutation: importDatabaseCsvMutation });
  const previewJson = useMutation({
    mutation: previewDatabaseJsonImportMutation,
  });
  const importJson = useMutation({ mutation: importDatabaseJsonMutation });
  const previewNotion = useMutation({
    mutation: previewDatabaseNotionImportMutation,
  });
  const importNotion = useMutation({ mutation: importDatabaseNotionMutation });
  const [csvPreview, setCsvPreview] = useState<{
    file: File;
    databaseTitle: string;
    dialect: DatabaseCsvDialectInput;
    firstRowIsHeader: boolean;
    mapping: CsvImportMapping[];
    step: CsvImportStep;
    preview: NonNullable<
      Awaited<ReturnType<typeof previewCsv.trigger>>
    >["previewDatabaseCsvImport"];
  } | null>(null);
  const [jsonPreview, setJsonPreview] = useState<{
    workspaceId: string;
    targetDatabaseId?: string;
    targetDatabaseTitle?: string;
    file: File;
    step: JsonImportStep;
    preview: NonNullable<
      Awaited<ReturnType<typeof previewJson.trigger>>
    >["previewDatabaseJsonImport"];
  } | null>(null);
  const [notionPreview, setNotionPreview] = useState<{
    file: File;
    preview: NonNullable<
      Awaited<ReturnType<typeof previewNotion.trigger>>
    >["previewDatabaseNotionImport"];
  } | null>(null);

  const onCsvFile = useCallback(
    async (file: File) => {
      if (!workspaceId) return;
      const databaseTitle = databaseTitleFromFile(file);
      const dialect = defaultCsvDialect();
      try {
        const response = await previewCsv.trigger({
          file,
          input: {
            workspaceId,
            databaseTitle,
            dialect: csvDialectForInput(dialect),
            firstRowIsHeader: true,
          },
        });
        setCsvPreview({
          file,
          databaseTitle,
          dialect,
          firstRowIsHeader: true,
          mapping: response.previewDatabaseCsvImport.appliedMapping,
          step: csvImportStepFromPreview(response.previewDatabaseCsvImport),
          preview: response.previewDatabaseCsvImport,
        });
      } catch (error) {
        notify.error({
          title: t["com.myoxus.database.csv-import.preview-failed"](),
          message: importErrorMessage(error),
        });
      }
    },
    [previewCsv, t, workspaceId],
  );

  const refreshCsvPreview = useCallback(
    async (
      next: Omit<
        NonNullable<typeof csvPreview>,
        "preview" | "step" | "mapping"
      > & { mapping?: CsvImportMapping[] },
    ) => {
      if (!workspaceId) return;
      try {
        const response = await previewCsv.trigger({
          file: next.file,
          input: {
            workspaceId,
            databaseTitle: next.databaseTitle,
            dialect: csvDialectForInput(next.dialect),
            firstRowIsHeader: next.firstRowIsHeader,
            mapping: next.mapping
              ? csvMappingForInput(next.mapping)
              : undefined,
          },
        });
        setCsvPreview({
          ...next,
          mapping: response.previewDatabaseCsvImport.appliedMapping,
          step: csvImportStepFromPreview(response.previewDatabaseCsvImport),
          preview: response.previewDatabaseCsvImport,
        });
      } catch (error) {
        notify.error({
          title: t["com.myoxus.database.csv-import.preview-failed"](),
          message: importErrorMessage(error),
        });
      }
    },
    [previewCsv, t, workspaceId],
  );

  const updateCsvMapping = useCallback(
    (sourceIndex: number, patch: Partial<CsvImportMapping>) => {
      setCsvPreview((current) => {
        if (!current) return current;
        return {
          ...current,
          mapping: current.mapping.map((column) => {
            if (column.sourceIndex !== sourceIndex) return column;
            const next = { ...column, ...patch };
            return next.isTitle
              ? {
                  ...next,
                  importColumn: true,
                  fieldType: DatabaseFieldKind.Title,
                }
              : next;
          }),
          step: 1,
        };
      });
    },
    [],
  );

  const setCsvTitleColumn = useCallback((sourceIndex: number) => {
    setCsvPreview((current) => {
      if (!current) return current;
      return {
        ...current,
        mapping: current.mapping.map((column) => ({
          ...column,
          importColumn:
            column.sourceIndex === sourceIndex ? true : column.importColumn,
          fieldType:
            column.sourceIndex === sourceIndex
              ? DatabaseFieldKind.Title
              : column.fieldType === DatabaseFieldKind.Title
                ? DatabaseFieldKind.Text
                : column.fieldType,
          isTitle: column.sourceIndex === sourceIndex,
        })),
        step: 1,
      };
    });
  }, []);

  const finishImport = useCallback(
    async (databaseId: string, viewId: string | null) => {
      if (!workspaceId) return;
      await revalidate(
        databasesQuery,
        (variables) => variables.workspaceId === workspaceId,
      );
      await onApplied?.();
      onImported(databaseId, viewId);
    },
    [onApplied, onImported, revalidate, workspaceId],
  );

  const applyCsvImport = useCallback(async () => {
    if (!csvPreview || !workspaceId) return;
    try {
      const response = await importCsv.trigger({
        file: csvPreview.file,
        input: {
          workspaceId,
          databaseTitle: csvPreview.databaseTitle,
          dialect: csvDialectForInput(csvPreview.dialect),
          firstRowIsHeader: csvPreview.firstRowIsHeader,
          mapping: csvMappingForInput(csvPreview.mapping),
        },
      });
      setCsvPreview(null);
      notify.success({ title: t["com.myoxus.database.csv-import.success"]() });
      await finishImport(
        response.importDatabaseCsv.database.database.id,
        getPrimaryViewOrNull(response.importDatabaseCsv.database)?.id ?? null,
      );
    } catch (error) {
      notify.error({
        title: t["com.myoxus.database.csv-import.failed"](),
        message: importErrorMessage(error),
      });
    }
  }, [csvPreview, finishImport, importCsv, t, workspaceId]);

  const onJsonFile = useCallback(
    async (file: File) => {
      if (!workspaceId) return;
      const openingScope = currentImportScope.current;
      try {
        const response = await previewJson.trigger({
          file,
          input: targetDatabaseId
            ? {
                workspaceId,
                targetDatabaseId,
                mode: DatabaseJsonImportModeType.MERGE,
                conflictStrategy: DatabaseJsonConflictStrategyType.ABORT,
              }
            : { workspaceId },
        });
        if (currentImportScope.current !== openingScope) return;
        setJsonPreview({
          workspaceId,
          targetDatabaseId,
          targetDatabaseTitle,
          file,
          step: response.previewDatabaseJsonImport.errors.length ? 1 : 2,
          preview: response.previewDatabaseJsonImport,
        });
      } catch (error) {
        notify.error({
          title: t["com.myoxus.database.json-import.preview-failed"](),
          message: importErrorMessage(error),
        });
      }
    },
    [previewJson, t, workspaceId, targetDatabaseId, targetDatabaseTitle],
  );

  const applyJsonImport = useCallback(async () => {
    if (
      !jsonPreview ||
      !workspaceId ||
      jsonPreview.workspaceId !== workspaceId ||
      jsonPreview.targetDatabaseId !== targetDatabaseId
    )
      return;
    const confirmedScope = currentImportScope.current;
    try {
      const response = await importJson.trigger({
        file: jsonPreview.file,
        input: jsonPreview.targetDatabaseId
          ? {
              workspaceId: jsonPreview.workspaceId,
              targetDatabaseId: jsonPreview.targetDatabaseId,
              mode: DatabaseJsonImportModeType.MERGE,
              conflictStrategy: DatabaseJsonConflictStrategyType.ABORT,
            }
          : { workspaceId: jsonPreview.workspaceId },
      });
      if (currentImportScope.current !== confirmedScope) return;
      setJsonPreview(null);
      notify.success({
        title: t["com.myoxus.database.json-import.success"](),
      });
      if (response.importDatabaseJson.warnings.length) {
        notify.warning({
          title: t["com.myoxus.database.json-import.diagnostics"](),
          message: response.importDatabaseJson.warnings
            .map((warning) => jsonDiagnosticMessage(t, warning))
            .join("\n"),
        });
      }
      await finishImport(
        response.importDatabaseJson.database.database.id,
        getPrimaryViewOrNull(response.importDatabaseJson.database)?.id ?? null,
      );
    } catch (error) {
      notify.error({
        title: t["com.myoxus.database.json-import.failed"](),
        message: importErrorMessage(error),
      });
    }
  }, [finishImport, importJson, jsonPreview, t, workspaceId, targetDatabaseId]);

  const onNotionFile = useCallback(
    async (file: File) => {
      if (!workspaceId) return;
      try {
        const response = await previewNotion.trigger({
          file,
          input: { workspaceId },
        });
        setNotionPreview({
          file,
          preview: response.previewDatabaseNotionImport,
        });
      } catch (error) {
        notify.error({
          title: t["com.myoxus.database.notion-import.preview-failed"](),
          message: importErrorMessage(error),
        });
      }
    },
    [previewNotion, t, workspaceId],
  );

  const applyNotionImport = useCallback(async () => {
    if (!notionPreview || !workspaceId) return;
    try {
      const response = await importNotion.trigger({
        file: notionPreview.file,
        input: { workspaceId },
      });
      setNotionPreview(null);
      notify.success({
        title: t["com.myoxus.database.notion-import.success"](),
        message: t["com.myoxus.database.notion-import.preview-body-summary"]({
          matched: String(notionPreview.preview.matchedPageCount),
          documents: String(notionPreview.preview.contentDocumentCount),
          empty: String(notionPreview.preview.emptyPageCount),
          blocks: String(notionPreview.preview.bodyBlockCount),
          links: String(notionPreview.preview.rewrittenInternalLinkCount),
        }),
      });
      if (response.importDatabaseNotion.warnings.length) {
        notify.warning({
          title: t["com.myoxus.database.json-import.conflict-warnings"](),
          message: response.importDatabaseNotion.warnings
            .map((warning) => jsonDiagnosticMessage(t, warning))
            .join("\n"),
        });
      }
      await finishImport(
        response.importDatabaseNotion.database.database.id,
        getPrimaryViewOrNull(response.importDatabaseNotion.database)?.id ??
          null,
      );
    } catch (error) {
      notify.error({
        title: t["com.myoxus.database.notion-import.failed"](),
        message: importErrorMessage(error),
      });
    }
  }, [finishImport, importNotion, notionPreview, t, workspaceId]);

  const csvPreviewColumns = useMemo(
    () => csvPreview?.mapping ?? [],
    [csvPreview],
  );
  const csvImportMappingValid = useMemo(
    () => csvImportMappingIsValid(csvPreviewColumns),
    [csvPreviewColumns],
  );

  return {
    csvBusy: previewCsv.isMutating || importCsv.isMutating,
    jsonBusy: previewJson.isMutating || importJson.isMutating,
    notionBusy: previewNotion.isMutating || importNotion.isMutating,
    openCsvPicker: () => csvFileInputRef.current?.click(),
    openJsonPicker: () => jsonFileInputRef.current?.click(),
    openNotionPicker: () => notionFileInputRef.current?.click(),
    surfaces: (
      <>
        <HiddenFileInput
          ref={csvFileInputRef}
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void onCsvFile(file);
          }}
          data-testid="database-csv-file-input"
        />
        <HiddenFileInput
          ref={jsonFileInputRef}
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void onJsonFile(file);
          }}
          data-testid="database-json-file-input"
        />
        <HiddenFileInput
          ref={notionFileInputRef}
          accept=".zip,application/zip,.html,text/html"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void onNotionFile(file);
          }}
          data-testid="database-notion-file-input"
        />
        <Modal
          open={Boolean(csvPreview)}
          onOpenChange={(open) => {
            if (!open) setCsvPreview(null);
          }}
          title={t["com.myoxus.database.csv-import.preview-title"]()}
          width="xl"
          scrollable
          contentOptions={{ "data-testid": "database-csv-import-modal" }}
        >
          {csvPreview ? (
            <Stack gap="md">
              <Stepper
                active={csvPreview.step}
                ariaLabel={t["com.myoxus.database.csv-import.steps"]()}
                compact
              >
                <StepperStep
                  label={t["com.myoxus.database.csv-import.step.file"]()}
                />
                <StepperStep
                  label={t["com.myoxus.database.csv-import.step.mapping"]()}
                />
                <StepperStep
                  label={t["com.myoxus.database.csv-import.step.review"]()}
                />
              </Stepper>

              <Stack gap="sm">
                <FormRow label={t["com.myoxus.database.csv-import.name"]()}>
                  <Input
                    aria-label={t["com.myoxus.database.csv-import.name"]()}
                    block
                    value={csvPreview.databaseTitle}
                    onChange={(databaseTitle) =>
                      setCsvPreview((current) =>
                        current ? { ...current, databaseTitle } : current,
                      )
                    }
                  />
                </FormRow>
                <FormRow label={t["com.myoxus.database.csv.delimiter"]()}>
                  <FormSelect
                    aria-label={t["com.myoxus.database.csv.delimiter"]()}
                    value={csvPreview.dialect.delimiter}
                    data={CSV_DELIMITERS.map((delimiter) => ({
                      value: delimiter,
                      label: delimiterLabel(t, delimiter),
                    }))}
                    onChange={(delimiter) =>
                      void refreshCsvPreview({
                        ...csvPreview,
                        dialect: {
                          ...csvPreview.dialect,
                          delimiter: delimiter as DatabaseCsvDelimiter,
                        },
                        mapping: undefined,
                      })
                    }
                  />
                </FormRow>
                {csvPreview.dialect.delimiter ===
                DatabaseCsvDelimiter.Custom ? (
                  <FormRow
                    label={t["com.myoxus.database.csv.delimiter.custom"]()}
                  >
                    <Input
                      aria-label={t[
                        "com.myoxus.database.csv.delimiter.custom"
                      ]()}
                      block
                      value={csvPreview.dialect.customDelimiter ?? ""}
                      onChange={(customDelimiter) =>
                        setCsvPreview((current) =>
                          current
                            ? {
                                ...current,
                                dialect: {
                                  ...current.dialect,
                                  customDelimiter,
                                },
                                step: 0,
                              }
                            : current,
                        )
                      }
                      onBlur={() =>
                        void refreshCsvPreview({
                          ...csvPreview,
                          mapping: undefined,
                        })
                      }
                    />
                  </FormRow>
                ) : null}
                <FormRow label={t["com.myoxus.database.csv.quote"]()}>
                  <Input
                    aria-label={t["com.myoxus.database.csv.quote"]()}
                    block
                    value={csvPreview.dialect.quote ?? ""}
                    onChange={(quote) =>
                      setCsvPreview((current) =>
                        current
                          ? {
                              ...current,
                              dialect: { ...current.dialect, quote },
                              step: 0,
                            }
                          : current,
                      )
                    }
                    onBlur={() =>
                      void refreshCsvPreview({
                        ...csvPreview,
                        mapping: undefined,
                      })
                    }
                  />
                </FormRow>
                <FormRow label={t["com.myoxus.database.csv.escape"]()}>
                  <Input
                    aria-label={t["com.myoxus.database.csv.escape"]()}
                    block
                    value={csvPreview.dialect.escape ?? ""}
                    onChange={(escape) =>
                      setCsvPreview((current) =>
                        current
                          ? {
                              ...current,
                              dialect: { ...current.dialect, escape },
                              step: 0,
                            }
                          : current,
                      )
                    }
                    onBlur={() =>
                      void refreshCsvPreview({
                        ...csvPreview,
                        mapping: undefined,
                      })
                    }
                  />
                </FormRow>
                <Checkbox
                  checked={csvPreview.dialect.doubleQuote ?? true}
                  label={t["com.myoxus.database.csv.double-quote"]()}
                  onChange={(_, doubleQuote) =>
                    void refreshCsvPreview({
                      ...csvPreview,
                      dialect: { ...csvPreview.dialect, doubleQuote },
                      mapping: undefined,
                    })
                  }
                />
                <Checkbox
                  checked={csvPreview.firstRowIsHeader}
                  label={t["com.myoxus.database.csv-import.first-row-header"]()}
                  onChange={(_, firstRowIsHeader) =>
                    void refreshCsvPreview({
                      ...csvPreview,
                      firstRowIsHeader,
                      mapping: undefined,
                    })
                  }
                />
              </Stack>

              <MyoxusText tone="secondary">
                {t["com.myoxus.database.csv-import.preview-summary"]({
                  columns: String(csvPreviewColumns.length),
                  rows: String(csvPreview.preview.rowCount),
                })}
              </MyoxusText>
              <Group gap="xs" wrap="wrap">
                <Badge tone="info">
                  {t["com.myoxus.database.csv-import.detected-dialect"]({
                    delimiter: delimiterLabel(
                      t,
                      csvPreview.preview.detectedDialect.delimiter,
                    ),
                    confidence: csvPreview.preview.confidence,
                  })}
                </Badge>
                <Badge tone="neutral">{csvPreview.file.name}</Badge>
              </Group>
              <TableScrollContainer>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {t["com.myoxus.database.csv-import.include"]()}
                      </TableHead>
                      <TableHead>
                        {t["com.myoxus.database.csv-import.column"]()}
                      </TableHead>
                      <TableHead>
                        {t["com.myoxus.database.csv-import.field"]()}
                      </TableHead>
                      <TableHead>
                        {t["com.myoxus.database.csv-import.type"]()}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {csvPreviewColumns.map((column) => (
                      <TableRow key={column.sourceIndex}>
                        <TableCell>
                          <Checkbox
                            checked={column.importColumn}
                            disabled={column.isTitle}
                            aria-label={t[
                              "com.myoxus.database.csv-import.include-column"
                            ]({ column: column.sourceHeader })}
                            onChange={(_, importColumn) =>
                              updateCsvMapping(column.sourceIndex, {
                                importColumn,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>{column.sourceHeader}</TableCell>
                        <TableCell>
                          <Input
                            aria-label={`${t[
                              "com.myoxus.database.csv-import.field"
                            ]()}: ${column.sourceHeader}`}
                            block
                            value={column.fieldName}
                            disabled={!column.importColumn}
                            onChange={(fieldName) =>
                              updateCsvMapping(column.sourceIndex, {
                                fieldName,
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <FormSelect
                            aria-label={`${t[
                              "com.myoxus.database.csv-import.type"
                            ]()}: ${column.sourceHeader}`}
                            value={column.fieldType}
                            disabled={!column.importColumn}
                            data={CSV_IMPORT_FIELD_TYPES.map((fieldType) => ({
                              value: fieldType,
                              label: databaseFieldTypeLabel(t, fieldType),
                            }))}
                            onChange={(fieldType) => {
                              if (fieldType === DatabaseFieldKind.Title) {
                                setCsvTitleColumn(column.sourceIndex);
                                return;
                              }
                              updateCsvMapping(column.sourceIndex, {
                                fieldType: fieldType as DatabaseFieldKind,
                                isTitle: false,
                              });
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScrollContainer>
              <CsvDiagnostics diagnostics={csvPreview.preview.errors} />
              <CsvDiagnostics diagnostics={csvPreview.preview.warnings} />
              <WorkspaceTagDiagnostics
                diagnostics={csvPreview.preview.workspaceTagDiagnostics}
              />
              <Group justify="flex-end" gap="xs">
                <Button variant="secondary" onClick={() => setCsvPreview(null)}>
                  {t["Cancel"]()}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void refreshCsvPreview({
                      ...csvPreview,
                      mapping: csvPreview.mapping,
                    })
                  }
                  loading={previewCsv.isMutating}
                >
                  {t["com.myoxus.database.csv-import.refresh-preview"]()}
                </Button>
                <Button
                  onClick={() => void applyCsvImport()}
                  loading={importCsv.isMutating}
                  disabled={
                    previewCsv.isMutating ||
                    csvPreview.preview.errors.length > 0 ||
                    !csvImportMappingValid
                  }
                >
                  {t["com.myoxus.database.csv-import.apply"]()}
                </Button>
              </Group>
            </Stack>
          ) : null}
        </Modal>
        <Modal
          open={Boolean(jsonPreview)}
          onOpenChange={(open) => {
            if (!open) setJsonPreview(null);
          }}
          title={t["com.myoxus.database.json-import.preview-title"]()}
          scrollable
          contentOptions={{ "data-testid": "database-json-import-modal" }}
        >
          {jsonPreview ? (
            <Stack gap="md">
              <Stepper
                active={jsonPreview.step}
                ariaLabel={t["com.myoxus.database.json-import.steps"]()}
                compact
              >
                <StepperStep
                  label={t["com.myoxus.database.json-import.step.file"]()}
                />
                <StepperStep
                  label={t["com.myoxus.database.json-import.step.preview"]()}
                />
                <StepperStep
                  label={t["com.myoxus.database.json-import.step.confirm"]()}
                />
              </Stepper>
              {jsonPreview.targetDatabaseId ? (
                <>
                  <MyoxusText>
                    {t["com.myoxus.database.json-import.mode.merge"]()}
                  </MyoxusText>
                  <FormRow
                    label={t["com.myoxus.database.json-import.target.label"]()}
                  >
                    <MyoxusText>{jsonPreview.targetDatabaseTitle}</MyoxusText>
                  </FormRow>
                  <MyoxusText>
                    {t["com.myoxus.database.json-import.content-only"]()}
                  </MyoxusText>
                  <FormRow
                    label={t[
                      "com.myoxus.database.json-import.conflict-strategy"
                    ]()}
                  >
                    <MyoxusText>
                      {t[
                        "com.myoxus.database.json-import.conflict-strategy.abort"
                      ]()}
                    </MyoxusText>
                  </FormRow>
                </>
              ) : null}
              <Group gap="xs" wrap="wrap">
                <Badge tone="neutral">{jsonPreview.file.name}</Badge>
                <Badge tone="neutral">
                  {t["com.myoxus.database.json-import.schema-version"]({
                    version: String(jsonPreview.preview.schemaVersion),
                  })}
                </Badge>
              </Group>
              <SurfaceList
                label={t["com.myoxus.database.json-import.summary"]()}
              >
                <SurfaceListItem density="compact">
                  <SurfaceListItemMain>
                    <SurfaceListText kind="title">
                      {jsonPreview.preview.title}
                    </SurfaceListText>
                    <SurfaceListMeta>
                      {t["com.myoxus.database.json-import.preview-summary"]({
                        fields: String(jsonPreview.preview.fieldCount),
                        views: String(jsonPreview.preview.viewCount),
                        rows: String(jsonPreview.preview.rowCount),
                        templates: String(jsonPreview.preview.templateCount),
                      })}
                    </SurfaceListMeta>
                  </SurfaceListItemMain>
                </SurfaceListItem>
              </SurfaceList>
              <JsonDiagnostics diagnostics={jsonPreview.preview.errors} />
              <JsonDiagnostics diagnostics={jsonPreview.preview.warnings} />
              <WorkspaceTagDiagnostics
                diagnostics={jsonPreview.preview.workspaceTagDiagnostics}
              />
              <Group justify="flex-end" gap="xs">
                <Button
                  variant="secondary"
                  onClick={() => setJsonPreview(null)}
                >
                  {t["Cancel"]()}
                </Button>
                <Button
                  onClick={() => void applyJsonImport()}
                  loading={importJson.isMutating}
                  data-testid="database-json-import-apply"
                  disabled={
                    jsonPreview.workspaceId !== workspaceId ||
                    jsonPreview.targetDatabaseId !== targetDatabaseId ||
                    previewJson.isMutating ||
                    jsonPreview.preview.errors.length > 0
                  }
                >
                  {t["com.myoxus.database.json-import.apply"]()}
                </Button>
              </Group>
            </Stack>
          ) : null}
        </Modal>
        <Modal
          open={Boolean(notionPreview)}
          onOpenChange={(open) => {
            if (!open) setNotionPreview(null);
          }}
          title={t["com.myoxus.database.notion-import.preview-title"]()}
          scrollable
          contentOptions={{ "data-testid": "database-notion-import-modal" }}
        >
          {notionPreview ? (
            <Stack gap="md">
              <MyoxusText tone="secondary">
                {t["com.myoxus.database.notion-import.description"]()}
              </MyoxusText>
              <MyoxusText tone="secondary">
                {t["com.myoxus.database.notion-import.unsupported-hint"]()}
              </MyoxusText>
              <Group gap="xs" wrap="wrap">
                <Badge tone="neutral">{notionPreview.file.name}</Badge>
                <Badge tone="neutral">
                  {t["com.myoxus.database.json-import.schema-version"]({
                    version: String(notionPreview.preview.schemaVersion),
                  })}
                </Badge>
                <Badge tone="info">
                  {t["com.myoxus.database.json-import.preview-summary"]({
                    fields: String(notionPreview.preview.fieldCount),
                    views: String(notionPreview.preview.viewCount),
                    rows: String(notionPreview.preview.rowCount),
                    templates: String(notionPreview.preview.templateCount),
                  })}
                </Badge>
              </Group>
              <MyoxusText tone="secondary">
                {t["com.myoxus.database.notion-import.preview-body-summary"]({
                  matched: String(notionPreview.preview.matchedPageCount),
                  documents: String(notionPreview.preview.contentDocumentCount),
                  empty: String(notionPreview.preview.emptyPageCount),
                  blocks: String(notionPreview.preview.bodyBlockCount),
                  links: String(
                    notionPreview.preview.rewrittenInternalLinkCount,
                  ),
                })}
              </MyoxusText>
              <JsonDiagnostics diagnostics={notionPreview.preview.errors} />
              <JsonDiagnostics diagnostics={notionPreview.preview.warnings} />
              <WorkspaceTagDiagnostics
                diagnostics={notionPreview.preview.workspaceTagDiagnostics}
              />
              <Group justify="flex-end" gap="xs">
                <Button
                  variant="secondary"
                  onClick={() => setNotionPreview(null)}
                >
                  {t["Cancel"]()}
                </Button>
                <Button
                  onClick={() => void applyNotionImport()}
                  loading={importNotion.isMutating}
                  disabled={
                    previewNotion.isMutating ||
                    notionPreview.preview.errors.length > 0
                  }
                  data-testid="database-notion-import-apply"
                >
                  {t["com.myoxus.database.json-import.apply"]()}
                </Button>
              </Group>
            </Stack>
          ) : null}
        </Modal>
      </>
    ),
  };
}
