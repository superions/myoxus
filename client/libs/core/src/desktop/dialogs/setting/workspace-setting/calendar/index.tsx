import { IntegrationService } from "@myoxus/core/modules/integration";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Box,
  Button,
  ColorInput,
  ColorSwatch,
  Input,
  Menu,
  MenuItem,
  MenuTrigger,
  notify,
  SettingHeader,
  SettingRow,
  SettingsInlineControl,
  SettingsListItemTitle,
  SettingWrapper,
  useConfirmModal,
} from "../../primitives";

const DEFAULT_TAG_COLOR = "#6366f1";

export const WorkspaceCalendarSettings = ({
  showHeader = true,
}: {
  showHeader?: boolean;
} = {}) => {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();
  const calendar = useService(IntegrationService).calendar;

  const REMINDER_OPTIONS = [
    { label: t["com.myoxus.common.reminder.none"](), value: null },
    { label: t["com.myoxus.common.reminder.before.5min"](), value: 5 },
    { label: t["com.myoxus.common.reminder.before.15min"](), value: 15 },
    { label: t["com.myoxus.common.reminder.before.30min"](), value: 30 },
    { label: t["com.myoxus.common.reminder.before.1h"](), value: 60 },
    { label: t["com.myoxus.common.reminder.before.1d"](), value: 1440 },
  ];

  const settings = useLiveData(calendar.settings$);
  const tags = useLiveData(calendar.tags$);
  const accountCalendars = useLiveData(calendar.accountCalendars$);

  const [reminderOffset, setReminderOffset] = useState<number | null>(
    settings?.defaultReminderOffsetMinutes ?? null,
  );
  const [writebackId, setWritebackId] = useState<string | null>(
    settings?.writebackSubscriptionId ?? null,
  );
  const [savingSettings, setSavingSettings] = useState(false);

  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(DEFAULT_TAG_COLOR);
  const [savingTag, setSavingTag] = useState(false);

  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState(DEFAULT_TAG_COLOR);

  useEffect(() => {
    calendar.getSettings().catch(() => undefined);
    calendar.listTags().catch(() => undefined);
    calendar.loadAccountCalendars().catch(() => undefined);
  }, [calendar]);

  useEffect(() => {
    setReminderOffset(settings?.defaultReminderOffsetMinutes ?? null);
    setWritebackId(settings?.writebackSubscriptionId ?? null);
  }, [settings]);

  const allSubscriptions = useMemo(() => {
    const result: { id: string; label: string }[] = [];
    for (const subs of accountCalendars.values()) {
      for (const sub of subs) {
        result.push({
          id: sub.id,
          label: sub.displayName ?? sub.externalCalendarId,
        });
      }
    }
    return result;
  }, [accountCalendars]);

  const handleSaveSettings = useCallback(async () => {
    setSavingSettings(true);
    try {
      await calendar.updateSettings({
        defaultReminderOffsetMinutes: reminderOffset,
        writebackSubscriptionId: writebackId,
      });
      notify.success({
        title: t["com.myoxus.settings.workspace.calendar.save-success"](),
      });
    } catch (err) {
      notify({
        title:
          err instanceof Error
            ? err.message
            : t["com.myoxus.settings.workspace.calendar.save-error"](),
      });
    } finally {
      setSavingSettings(false);
    }
  }, [calendar, reminderOffset, t, writebackId]);

  const handleCreateTag = useCallback(async () => {
    const name = newTagName.trim();
    if (!name) return;
    setSavingTag(true);
    try {
      await calendar.createTag({ name, color: newTagColor });
      setNewTagName("");
      setNewTagColor(DEFAULT_TAG_COLOR);
    } catch (err) {
      notify({
        title:
          err instanceof Error
            ? err.message
            : t["com.myoxus.settings.workspace.calendar.tag-create-error"](),
      });
    } finally {
      setSavingTag(false);
    }
  }, [calendar, newTagColor, newTagName, t]);

  const handleStartEdit = useCallback(
    (tagId: string) => {
      const tag = tags.find((t) => t.id === tagId);
      if (!tag) return;
      setEditingTagId(tagId);
      setEditTagName(tag.name);
      setEditTagColor(tag.color);
    },
    [tags],
  );

  const handleSaveEdit = useCallback(
    async (tagId: string) => {
      const name = editTagName.trim();
      if (!name) return;
      try {
        await calendar.updateTag(tagId, { name, color: editTagColor });
        setEditingTagId(null);
      } catch (err) {
        notify({
          title:
            err instanceof Error
              ? err.message
              : t["com.myoxus.settings.workspace.calendar.tag-save-error"](),
        });
      }
    },
    [calendar, editTagColor, editTagName, t],
  );

  const handleDeleteTag = useCallback(
    async (tagId: string) => {
      try {
        await calendar.deleteTag(tagId);
      } catch (err) {
        notify({
          title:
            err instanceof Error
              ? err.message
              : t["com.myoxus.settings.workspace.calendar.tag-delete-error"](),
        });
      }
    },
    [calendar, t],
  );

  const handleRequestDeleteTag = useCallback(
    (tagId: string) => {
      const tag = tags.find((item) => item.id === tagId);
      if (!tag) return;

      openConfirmModal({
        title:
          t[
            "com.myoxus.settings.workspace.calendar.tags.delete-confirm.title"
          ](),
        description: t[
          "com.myoxus.settings.workspace.calendar.tags.delete-confirm.description"
        ]({
          tagName: tag.name,
        }),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        confirmText: t["com.myoxus.settings.workspace.calendar.tags.delete"](),
        confirmButtonOptions: {
          variant: "error",
        },
        onConfirm: async () => {
          await handleDeleteTag(tagId);
        },
      });
    },
    [handleDeleteTag, openConfirmModal, t, tags],
  );

  const reminderLabel =
    REMINDER_OPTIONS.find((o) => o.value === reminderOffset)?.label ??
    t["com.myoxus.common.reminder.none"]();

  const writebackLabel =
    allSubscriptions.find((s) => s.id === writebackId)?.label ??
    t["com.myoxus.settings.workspace.calendar.writeback.disabled"]();
  const settingsDirty =
    (settings?.defaultReminderOffsetMinutes ?? null) !== reminderOffset ||
    (settings?.writebackSubscriptionId ?? null) !== writebackId;

  return (
    <>
      {showHeader ? (
        <SettingHeader
          title={t["com.myoxus.settings.workspace.calendar"]()}
          subtitle={t["com.myoxus.settings.workspace.calendar.subtitle"]()}
        />
      ) : null}

      <SettingWrapper
        title={t["com.myoxus.settings.workspace.calendar.defaults-section"]()}
      >
        <SettingRow
          name={t["com.myoxus.settings.workspace.calendar.reminder"]()}
          desc={t["com.myoxus.settings.workspace.calendar.reminder.desc"]()}
        >
          <Menu
            items={REMINDER_OPTIONS.map((opt) => (
              <MenuItem
                key={String(opt.value)}
                selected={reminderOffset === opt.value}
                onSelect={() => setReminderOffset(opt.value)}
              >
                {opt.label}
              </MenuItem>
            ))}
          >
            <MenuTrigger>{reminderLabel}</MenuTrigger>
          </Menu>
        </SettingRow>

        <SettingRow
          name={t["com.myoxus.settings.workspace.calendar.writeback"]()}
          desc={t["com.myoxus.settings.workspace.calendar.writeback.desc"]()}
        >
          <Menu
            items={
              <>
                <MenuItem
                  selected={writebackId === null}
                  onSelect={() => setWritebackId(null)}
                >
                  {t[
                    "com.myoxus.settings.workspace.calendar.writeback.disabled"
                  ]()}
                </MenuItem>
                {allSubscriptions.map((sub) => (
                  <MenuItem
                    key={sub.id}
                    selected={writebackId === sub.id}
                    onSelect={() => setWritebackId(sub.id)}
                  >
                    {sub.label}
                  </MenuItem>
                ))}
              </>
            }
          >
            <MenuTrigger>{writebackLabel}</MenuTrigger>
          </Menu>
        </SettingRow>

        {settingsDirty || savingSettings ? (
          <SettingRow name="">
            <Button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              data-myoxus-ui-role="button:compact"
              data-testid="workspace-calendar-settings-save"
              variant="primary"
            >
              {savingSettings
                ? t["com.myoxus.settings.workspace.calendar.saving"]()
                : t["com.myoxus.settings.workspace.calendar.save"]()}
            </Button>
          </SettingRow>
        ) : null}
      </SettingWrapper>

      <SettingWrapper
        title={t["com.myoxus.settings.workspace.calendar.tags-section"]()}
      >
        {tags.map((tag) =>
          editingTagId === tag.id ? (
            <SettingRow key={tag.id} name="" spreadCol={false}>
              <SettingsInlineControl wrap>
                <ColorInput
                  aria-label={t[
                    "com.myoxus.settings.editorSettings.edgeless.connecter.color"
                  ]()}
                  value={editTagColor}
                  onChange={setEditTagColor}
                />
                <Box flex="1 1 auto" miw={0}>
                  <Input
                    aria-label={t[
                      "com.myoxus.settings.workspace.calendar.tags.new.placeholder"
                    ]()}
                    value={editTagName}
                    onChange={setEditTagName}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        handleSaveEdit(tag.id).catch(() => undefined);
                      if (e.key === "Escape") setEditingTagId(null);
                    }}
                    autoFocus
                    block
                  />
                </Box>
                <Button
                  onClick={() => handleSaveEdit(tag.id).catch(() => undefined)}
                  data-myoxus-ui-role="button:compact"
                  variant="plain"
                >
                  {t["com.myoxus.settings.workspace.calendar.tags.save"]()}
                </Button>
                <Button
                  onClick={() => setEditingTagId(null)}
                  data-myoxus-ui-role="button:compact"
                  variant="plain"
                >
                  {t["com.myoxus.settings.workspace.calendar.tags.cancel"]()}
                </Button>
              </SettingsInlineControl>
            </SettingRow>
          ) : (
            <SettingRow key={tag.id} name="" spreadCol={false}>
              <SettingsInlineControl wrap>
                <ColorSwatch color={tag.color} shape="circle" />
                <Box flex="1 1 auto" miw={0}>
                  <SettingsListItemTitle truncate>
                    {tag.name}
                  </SettingsListItemTitle>
                </Box>
                <Button
                  onClick={() => handleStartEdit(tag.id)}
                  data-myoxus-ui-role="button:compact"
                  variant="plain"
                >
                  {t["com.myoxus.settings.workspace.calendar.tags.edit"]()}
                </Button>
                <Button
                  onClick={() => handleRequestDeleteTag(tag.id)}
                  data-myoxus-ui-role="button:compact"
                  variant="error"
                >
                  {t["com.myoxus.settings.workspace.calendar.tags.delete"]()}
                </Button>
              </SettingsInlineControl>
            </SettingRow>
          ),
        )}

        <SettingRow
          name={t["com.myoxus.settings.workspace.calendar.tags.new"]()}
          spreadCol={false}
        >
          <SettingsInlineControl wrap>
            <ColorInput
              aria-label={t[
                "com.myoxus.settings.editorSettings.edgeless.connecter.color"
              ]()}
              value={newTagColor}
              onChange={setNewTagColor}
            />
            <Box flex="1 1 auto" miw={0}>
              <Input
                aria-label={t[
                  "com.myoxus.settings.workspace.calendar.tags.new.placeholder"
                ]()}
                placeholder={t[
                  "com.myoxus.settings.workspace.calendar.tags.new.placeholder"
                ]()}
                value={newTagName}
                onChange={setNewTagName}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    handleCreateTag().catch(() => undefined);
                }}
                block
              />
            </Box>
            <Button
              onClick={() => handleCreateTag().catch(() => undefined)}
              disabled={savingTag || !newTagName.trim()}
              data-myoxus-ui-role="button:compact"
              variant="primary"
            >
              {t["com.myoxus.settings.workspace.calendar.tags.create"]()}
            </Button>
          </SettingsInlineControl>
        </SettingRow>
      </SettingWrapper>
    </>
  );
};
