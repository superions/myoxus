// SPDX-License-Identifier: AGPL-3.0-or-later

import { useWorkspaceTagColorOptions } from "@myoxus/core/components/tags/color-options";
import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import {
  DatabaseFieldKind,
  DatabaseFileMimeCategory,
  DatabaseFilesPreviewPolicy,
  DatabaseFormulaResultType,
  DatabaseStatusGroup,
  type DatabaseStatusOptionInput,
  updateDatabaseFieldMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Badge,
  Button,
  FormRow,
  Group,
  Input,
  Modal,
  MultiSelect,
  MyoxusText,
  NumberInput,
  Notice,
  Select,
  Stack,
  Switch,
  Textarea,
  useConfirmModal,
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
  fieldConfigInputFromField,
  getSelectOptions,
  selectOptionInputsFromText,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseField } from "../types";
import {
  databaseFormulaResultTypeLabel,
  extractFormulaDependencyNames,
} from "./labels";

export function FieldSettingsModal({
  databaseId,
  field,
  onChanged,
  onClose,
  returnFocusRef,
}: {
  databaseId: string;
  field: DatabaseField | null;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const { openConfirmModal } = useConfirmModal();
  const updateField = useMutation(
    { mutation: updateDatabaseFieldMutation },
    {
      suppressErrorNotification: field?.fieldType === DatabaseFieldKind.Status,
    },
  );
  const statusPending =
    field?.fieldType === DatabaseFieldKind.Status && updateField.isMutating;
  const colors = useWorkspaceTagColorOptions();
  const [statusOptions, setStatusOptions] = useState<
    DatabaseStatusOptionInput[]
  >([]);
  const [statusDefault, setStatusDefault] = useState("");
  const [activeStatusId, setActiveStatusId] = useState<string | null>(null);
  const statusSessionRef = useRef<{
    key: string;
    revision: number;
    generation: number;
  } | null>(null);
  const [statusReloadGeneration, setStatusReloadGeneration] = useState(0);
  const statusGroups = [
    {
      value: DatabaseStatusGroup.NotStarted,
      label: t["com.myoxus.database.progress.group.not-started"](),
    },
    {
      value: DatabaseStatusGroup.Active,
      label: t["com.myoxus.database.progress.group.active"](),
    },
    {
      value: DatabaseStatusGroup.Complete,
      label: t["com.myoxus.database.progress.group.complete"](),
    },
    {
      value: DatabaseStatusGroup.Archived,
      label: t["com.myoxus.database.progress.group.archived"](),
    },
  ];
  const [statusFailure, setStatusFailure] = useState<"used" | "failed" | null>(
    null,
  );
  const changeStatusOption = (
    index: number,
    patch: Partial<DatabaseStatusOptionInput>,
  ) => {
    setStatusFailure(null);
    setStatusOptions((options) =>
      options.map((option, position) =>
        position === index ? { ...option, ...patch } : option,
      ),
    );
  };
  const moveStatusOption = (index: number, offset: number) => {
    setStatusOptions((options) => {
      const next = [...options];
      [next[index], next[index + offset]] = [
        next[index + offset]!,
        next[index]!,
      ];
      return next;
    });
  };

  const [multiline, setMultiline] = useState(false);
  const [includeTime, setIncludeTime] = useState(false);
  const [allowReminders, setAllowReminders] = useState(false);
  const [numberFormat, setNumberFormat] = useState("");
  const [optionText, setOptionText] = useState("");
  const [formulaExpression, setFormulaExpression] = useState("");
  const [formulaResultType, setFormulaResultType] =
    useState<DatabaseFormulaResultType>(DatabaseFormulaResultType.Text);
  const [filesAllowedMimeCategories, setFilesAllowedMimeCategories] = useState<
    DatabaseFileMimeCategory[]
  >([DatabaseFileMimeCategory.Any]);
  const [filesMaxItemCount, setFilesMaxItemCount] = useState<number | "">("");
  const [filesMaxItemSize, setFilesMaxItemSize] = useState<number | "">("");
  const [filesPreviewPolicy, setFilesPreviewPolicy] =
    useState<DatabaseFilesPreviewPolicy>(DatabaseFilesPreviewPolicy.Auto);

  useEffect(() => {
    if (!field) {
      statusSessionRef.current = null;
      return;
    }
    if (field.fieldType === DatabaseFieldKind.Status) {
      const key = JSON.stringify([databaseId, field.id]);
      if (
        statusSessionRef.current?.key === key &&
        statusSessionRef.current.generation === statusReloadGeneration
      )
        return;
      // Revalidation must not replace a manager's draft or advance its basis.
      statusSessionRef.current = {
        key,
        revision: field.editRevision,
        generation: statusReloadGeneration,
      };
    } else {
      statusSessionRef.current = null;
    }
    setStatusOptions(
      field.config.status?.options.map((option) => ({ ...option })) ?? [],
    );
    setStatusDefault(field.config.status?.defaultOptionId ?? "");
    setStatusFailure(null);
    setActiveStatusId(null);
    setMultiline(Boolean(field.config.text?.multiline));
    setIncludeTime(Boolean(field.config.date?.includeTime));
    setAllowReminders(Boolean(field.config.dateTime?.allowReminders));
    setNumberFormat(field.config.number?.format ?? "");
    setFormulaExpression(field.config.formula?.expression ?? "");
    setFormulaResultType(
      field.config.formula?.resultType ?? DatabaseFormulaResultType.Text,
    );
    setFilesAllowedMimeCategories(
      field.config.files?.allowedMimeCategories.length
        ? field.config.files.allowedMimeCategories
        : [DatabaseFileMimeCategory.Any],
    );
    setFilesMaxItemCount(field.config.files?.maxItemCount ?? "");
    setFilesMaxItemSize(field.config.files?.maxItemSize ?? "");
    setFilesPreviewPolicy(
      field.config.files?.previewPolicy ?? DatabaseFilesPreviewPolicy.Auto,
    );
    setOptionText(
      getSelectOptions(field)
        .map((option) => option.name)
        .join("\n"),
    );
  }, [field, databaseId, statusReloadGeneration]);

  const formulaDependencyNames = useMemo(
    () => extractFormulaDependencyNames(formulaExpression),
    [formulaExpression],
  );
  const formulaResultTypeOptions = [
    DatabaseFormulaResultType.Text,
    DatabaseFormulaResultType.Number,
    DatabaseFormulaResultType.Checkbox,
    DatabaseFormulaResultType.Date,
  ].map((resultType) => ({
    value: resultType,
    label: databaseFormulaResultTypeLabel(t, resultType),
  }));
  const fileMimeCategoryOptions = [
    {
      value: DatabaseFileMimeCategory.Any,
      label: t["com.myoxus.database.files.mime.any"](),
    },
    {
      value: DatabaseFileMimeCategory.Image,
      label: t["com.myoxus.database.files.mime.image"](),
    },
    {
      value: DatabaseFileMimeCategory.Video,
      label: t["com.myoxus.database.files.mime.video"](),
    },
    {
      value: DatabaseFileMimeCategory.Audio,
      label: t["com.myoxus.database.files.mime.audio"](),
    },
    {
      value: DatabaseFileMimeCategory.Pdf,
      label: t["com.myoxus.database.files.mime.pdf"](),
    },
    {
      value: DatabaseFileMimeCategory.Document,
      label: t["com.myoxus.database.files.mime.document"](),
    },
    {
      value: DatabaseFileMimeCategory.Archive,
      label: t["com.myoxus.database.files.mime.archive"](),
    },
  ];
  const filePreviewPolicyOptions = [
    {
      value: DatabaseFilesPreviewPolicy.Auto,
      label: t["com.myoxus.database.files.preview.auto"](),
    },
    {
      value: DatabaseFilesPreviewPolicy.Disabled,
      label: t["com.myoxus.database.files.preview.disabled"](),
    },
  ];

  const save = useCallback(async () => {
    if (!field || field.fieldType === DatabaseFieldKind.Title) return;
    const statusSession = statusSessionRef.current;
    const existingOptions = getSelectOptions(field).map((option) => ({
      colorRole: option.colorRole,
      id: option.id,
      name: option.name,
      position: option.position,
    }));
    const options = selectOptionInputsFromText(existingOptions, optionText);
    const config =
      field.fieldType === DatabaseFieldKind.Status
        ? {
            status: {
              defaultOptionId: statusDefault,
              options: statusOptions.map((option, position) => ({
                ...option,
                position,
              })),
            },
          }
        : fieldConfigInputFromField(field, {
            allowReminders,
            filesAllowedMimeCategories,
            filesMaxItemCount:
              filesMaxItemCount === "" ? null : filesMaxItemCount,
            filesMaxItemSize: filesMaxItemSize === "" ? null : filesMaxItemSize,
            filesPreviewPolicy,
            includeTime,
            formulaExpression,
            formulaResultType,
            multiline,
            numberFormat,
            options,
          });
    setStatusFailure(null);
    const statusMutation = async (
      variables: Parameters<typeof updateField.trigger>[0],
    ) => {
      try {
        return await updateField.trigger(variables);
      } catch (error) {
        if (
          field.fieldType === DatabaseFieldKind.Status &&
          statusSessionRef.current === statusSession
        ) {
          const code = (error as { extensions?: { code?: unknown } })
            ?.extensions?.code;
          if (!(typeof code === "string" && code.endsWith("_CONFLICT")))
            setStatusFailure(
              code === "MIX_DATABASE_PROJECT_STATUS_IN_USE" ? "used" : "failed",
            );
        }
        throw error;
      }
    };
    try {
      await executeRevisionMutation(
        conflicts,
        statusMutation,
        {
          databaseId,
          fieldId: field.id,
          config,
          expectedEditRevision: statusSession?.revision ?? field.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.field.settings"]({
            field: field.name,
          }),
          localValue: config,
          reloadLatest: async () => {
            await onChanged();
            if (
              field.fieldType === DatabaseFieldKind.Status &&
              statusSessionRef.current === statusSession
            ) {
              statusSessionRef.current = null;
              // A canonical deep-deduped object still needs an explicit reset.
              setStatusReloadGeneration((generation) => generation + 1);
            }
          },
          afterSuccess: async () => {
            if (
              field.fieldType === DatabaseFieldKind.Status &&
              statusSessionRef.current !== statusSession
            )
              return;
            onClose();
            await onChanged({
              kind: "field_updated",
              target: { fieldId: field.id },
            });
          },
        },
      );
    } catch (error) {
      // The scoped trigger owns Status feedback for both initial and Force
      // attempts. Other field types retain their existing error owner.
      if (field.fieldType !== DatabaseFieldKind.Status) throw error;
    }
  }, [
    statusOptions,
    statusDefault,
    databaseId,
    allowReminders,
    conflicts,
    field,
    filesAllowedMimeCategories,
    filesMaxItemCount,
    filesMaxItemSize,
    filesPreviewPolicy,
    formulaExpression,
    formulaResultType,
    includeTime,
    multiline,
    numberFormat,
    onChanged,
    onClose,
    optionText,
    t,
    updateField,
  ]);

  return (
    <Modal
      open={Boolean(field)}
      persistent={statusPending}
      closeButtonOptions={{ disabled: statusPending }}
      scrollable
      returnFocusRef={returnFocusRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      contentOptions={{
        "data-testid": "database-field-settings-modal",
      }}
      title={
        field
          ? t["com.myoxus.database.field.settings"]({
              field: field.name,
            })
          : undefined
      }
    >
      {field ? (
        <Stack gap="md">
          {field.fieldType === DatabaseFieldKind.Status ? (
            <Stack>
              {statusFailure ? (
                <Notice
                  tone="error"
                  title={
                    statusFailure === "used"
                      ? t["com.myoxus.database.status.used-options"]()
                      : t["com.myoxus.common.operation-failed"]()
                  }
                />
              ) : null}
              <Select
                disabled={statusPending}
                label={t["com.myoxus.database.status.default"]()}
                value={statusDefault}
                onChange={(value) => setStatusDefault(value ?? "")}
                data={statusOptions.map((option) => ({
                  value: option.id,
                  label: option.name || t["com.myoxus.database.cell.empty"](),
                }))}
              />
              <Accordion
                value={activeStatusId}
                onChange={(value) =>
                  setActiveStatusId(typeof value === "string" ? value : null)
                }
              >
                {statusOptions.map((option, index) => (
                  <AccordionItem key={option.id} value={option.id}>
                    <AccordionControl>
                      <Group justify="space-between">
                        <MyoxusText>
                          {option.name || t["com.myoxus.database.cell.empty"]()}
                        </MyoxusText>
                        <Badge tone="neutral">
                          {
                            statusGroups.find(
                              (group) => group.value === option.group,
                            )?.label
                          }
                        </Badge>
                      </Group>
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        <Group align="flex-end">
                          <Input
                            disabled={statusPending}
                            label={t["com.myoxus.database.status.name"]()}
                            value={option.name}
                            onChange={(name) =>
                              changeStatusOption(index, { name })
                            }
                          />
                          <Select
                            disabled={statusPending}
                            label={t["com.myoxus.database.status.group"]()}
                            value={option.group}
                            onChange={(group) =>
                              changeStatusOption(index, {
                                group: group as DatabaseStatusGroup,
                              })
                            }
                            data={statusGroups}
                          />
                          <Select
                            disabled={statusPending}
                            label={t["com.myoxus.database.status.color"]()}
                            value={option.colorRole}
                            onChange={(colorRole) => {
                              if (colorRole)
                                changeStatusOption(index, { colorRole });
                            }}
                            data={[
                              ...(!colors.some(
                                (color) => color.value === option.colorRole,
                              )
                                ? [
                                    {
                                      value: option.colorRole,
                                      label:
                                        t[
                                          "com.myoxus.database.status.existing-color"
                                        ](),
                                    },
                                  ]
                                : []),
                              ...colors.map((color) => ({
                                value: color.value,
                                label: color.name,
                              })),
                            ]}
                          />
                        </Group>
                        <Group>
                          <Button
                            variant="secondary"
                            disabled={statusPending || index === 0}
                            onClick={() => moveStatusOption(index, -1)}
                          >
                            {t["com.myoxus.keyboardShortcuts.moveUp"]()}
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={
                              statusPending ||
                              index === statusOptions.length - 1
                            }
                            onClick={() => moveStatusOption(index, 1)}
                          >
                            {t["com.myoxus.keyboardShortcuts.moveDown"]()}
                          </Button>
                          <Button
                            disabled={statusPending}
                            variant="error"
                            onClick={() =>
                              setStatusOptions((options) =>
                                options.filter((item) => item.id !== option.id),
                              )
                            }
                          >
                            {t.Delete()}
                          </Button>
                        </Group>
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                ))}
              </Accordion>
              <Button
                variant="secondary"
                disabled={statusPending}
                onClick={() => {
                  const id = crypto.randomUUID();
                  setStatusOptions((options) => [
                    ...options,
                    {
                      id,
                      name: "",
                      group: DatabaseStatusGroup.Active,
                      colorRole: "database.status.inProgress",
                      position: options.length,
                    },
                  ]);
                  setActiveStatusId(id);
                }}
              >
                {t["com.myoxus.database.status.add"]()}
              </Button>
            </Stack>
          ) : null}
          {field.fieldType === DatabaseFieldKind.Text ? (
            <Switch
              checked={multiline}
              onChange={setMultiline}
              aria-label={t["com.myoxus.database.field.multiline"]()}
            >
              {t["com.myoxus.database.field.multiline"]()}
            </Switch>
          ) : null}
          {field.fieldType === DatabaseFieldKind.Date ? (
            <Switch
              checked={includeTime}
              onChange={setIncludeTime}
              aria-label={t["com.myoxus.database.field.include-time"]()}
            >
              {t["com.myoxus.database.field.include-time"]()}
            </Switch>
          ) : null}
          {field.fieldType === DatabaseFieldKind.DateTime ? (
            <Switch
              checked={allowReminders}
              onChange={(checked) => {
                if (checked || !field.config.dateTime?.allowReminders) {
                  setAllowReminders(checked);
                  return;
                }
                openConfirmModal({
                  title:
                    t["com.myoxus.database.reminder.disable-confirm-title"](),
                  description:
                    t[
                      "com.myoxus.database.reminder.disable-confirm-description"
                    ](),
                  confirmText:
                    t["com.myoxus.database.reminder.disable-confirm"](),
                  cancelText: t.Cancel(),
                  onConfirm: () => setAllowReminders(false),
                });
              }}
              aria-label={t["com.myoxus.database.reminder.allow-personal"]()}
            >
              {t["com.myoxus.database.reminder.allow-personal"]()}
            </Switch>
          ) : null}
          {field.fieldType === DatabaseFieldKind.Number ? (
            <FormRow label={t["com.myoxus.database.field.number-format"]()}>
              <Input
                aria-label={t["com.myoxus.database.field.number-format"]()}
                value={numberFormat}
                onChange={setNumberFormat}
                placeholder={t[
                  "com.myoxus.database.field.number-format-placeholder"
                ]()}
                block
              />
            </FormRow>
          ) : null}
          {field.fieldType === DatabaseFieldKind.Files ? (
            <Stack gap="sm">
              <FormRow
                label={t["com.myoxus.database.files.allowed-types"]()}
                help={t["com.myoxus.database.files.allowed-types-help"]()}
              >
                <MultiSelect
                  aria-label={t["com.myoxus.database.files.allowed-types"]()}
                  data={fileMimeCategoryOptions}
                  value={filesAllowedMimeCategories}
                  onChange={(values) => {
                    const categories = values as DatabaseFileMimeCategory[];
                    if (
                      categories.includes(DatabaseFileMimeCategory.Any) &&
                      !filesAllowedMimeCategories.includes(
                        DatabaseFileMimeCategory.Any,
                      )
                    ) {
                      setFilesAllowedMimeCategories([
                        DatabaseFileMimeCategory.Any,
                      ]);
                      return;
                    }
                    const narrowed = categories.filter(
                      (category) => category !== DatabaseFileMimeCategory.Any,
                    );
                    setFilesAllowedMimeCategories(
                      narrowed.length
                        ? narrowed
                        : [DatabaseFileMimeCategory.Any],
                    );
                  }}
                  block
                />
              </FormRow>
              <NumberInput
                label={t["com.myoxus.database.files.max-count"]()}
                value={filesMaxItemCount}
                onChange={(value) =>
                  setFilesMaxItemCount(value === "" ? "" : Number(value))
                }
                min={1}
                allowDecimal={false}
              />
              <NumberInput
                label={t["com.myoxus.database.files.max-size"]()}
                description={t["com.myoxus.database.files.max-size-help"]()}
                value={filesMaxItemSize}
                onChange={(value) =>
                  setFilesMaxItemSize(value === "" ? "" : Number(value))
                }
                min={1}
                allowDecimal={false}
              />
              <FormRow label={t["com.myoxus.database.files.preview-policy"]()}>
                <Select
                  aria-label={t["com.myoxus.database.files.preview-policy"]()}
                  data={filePreviewPolicyOptions}
                  value={filesPreviewPolicy}
                  onChange={(value) =>
                    setFilesPreviewPolicy(
                      (value as DatabaseFilesPreviewPolicy) ??
                        DatabaseFilesPreviewPolicy.Auto,
                    )
                  }
                  block
                />
              </FormRow>
            </Stack>
          ) : null}
          {field.fieldType === DatabaseFieldKind.Select ||
          field.fieldType === DatabaseFieldKind.MultiSelect ? (
            <FormRow
              label={t["com.myoxus.database.field.options"]()}
              help={t["com.myoxus.database.field.options-description"]()}
            >
              <Textarea
                aria-label={t["com.myoxus.database.field.options"]()}
                value={optionText}
                onChange={setOptionText}
                autosize
                minRows={4}
              />
            </FormRow>
          ) : null}
          {field.fieldType === DatabaseFieldKind.Formula ? (
            <Stack gap="sm">
              <FormRow
                label={t["com.myoxus.database.formula.expression"]()}
                help={t["com.myoxus.database.formula.help"]()}
              >
                <Textarea
                  aria-label={t["com.myoxus.database.formula.expression"]()}
                  value={formulaExpression}
                  onChange={setFormulaExpression}
                  placeholder={t[
                    "com.myoxus.database.formula.expression-placeholder"
                  ]()}
                  autosize
                  minRows={4}
                />
              </FormRow>
              <FormRow label={t["com.myoxus.database.formula.result-type"]()}>
                <Select
                  aria-label={t["com.myoxus.database.formula.result-type"]()}
                  data={formulaResultTypeOptions}
                  value={formulaResultType}
                  onChange={(value) =>
                    setFormulaResultType(
                      (value as DatabaseFormulaResultType) ??
                        DatabaseFormulaResultType.Text,
                    )
                  }
                  block
                />
              </FormRow>
              <Stack gap="xs">
                <MyoxusText typographySlot="body-small" tone="secondary">
                  {t["com.myoxus.database.formula.dependencies"]()}
                </MyoxusText>
                {formulaDependencyNames.length ? (
                  <Group gap="xs" wrap="wrap">
                    {formulaDependencyNames.map((dependency) => (
                      <Badge key={dependency} tone="neutral">
                        {dependency}
                      </Badge>
                    ))}
                  </Group>
                ) : (
                  <MyoxusText typographySlot="body-small" tone="secondary">
                    {t["com.myoxus.database.formula.no-dependencies"]()}
                  </MyoxusText>
                )}
              </Stack>
            </Stack>
          ) : null}
          <Group justify="flex-end" gap="xs">
            <Button
              variant="secondary"
              disabled={statusPending}
              onClick={onClose}
            >
              {t["Cancel"]()}
            </Button>
            <Button
              onClick={() => void save()}
              loading={updateField.isMutating}
            >
              {t["Save"]()}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}
