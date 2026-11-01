import { IntegrationService } from "@myoxus/core/modules/integration";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Button,
  DialogFooterActions,
  notify,
  SettingsControlEmpty,
  SettingsSection,
  SettingsStatusText,
  SurfaceList,
} from "../../../primitives";
import { SubscriptionSetting } from "./subscription-setting";

const isSameSelection = (left: Set<string>, right: Set<string>) => {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
};

export const CalendarSettingPanel = () => {
  const t = useI18n();
  const calendar = useService(IntegrationService).calendar;
  const workspaceServerService = useService(WorkspaceServerService);
  const server = useLiveData(workspaceServerService.server$);
  const accounts = useLiveData(calendar.accounts$);
  const accountCalendars = useLiveData(calendar.accountCalendars$);
  const workspaceCalendars = useLiveData(calendar.workspaceCalendars$);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    calendar.revalidateWorkspaceCalendars().catch(() => undefined);
    calendar.loadAccountCalendars().catch(() => undefined);
  }, [calendar, server]);

  useEffect(() => {
    const selected = new Set(
      workspaceCalendars[0]?.items.map((item) => item.subscriptionId) ?? [],
    );
    setSelectedIds(selected);
  }, [workspaceCalendars]);

  const orderedSubscriptions = useMemo(() => {
    return accounts.flatMap(
      (account) => accountCalendars.get(account.id) ?? [],
    );
  }, [accounts, accountCalendars]);

  const handleToggle = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const hasChanges = useMemo(() => {
    const saved = new Set(
      workspaceCalendars[0]?.items.map((item) => item.subscriptionId) ?? [],
    );
    return !isSameSelection(saved, selectedIds);
  }, [selectedIds, workspaceCalendars]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const items = orderedSubscriptions
        .filter((subscription) => selectedIds.has(subscription.id))
        .map((subscription, index) => ({
          subscriptionId: subscription.id,
          sortOrder: index,
        }));
      await calendar.updateWorkspaceCalendars(items);
    } catch (error) {
      console.error("Failed to save calendar settings", error);
      notify.error({
        title: t["com.myoxus.integration.calendar.save-error"](),
      });
    } finally {
      setSaving(false);
    }
  }, [calendar, orderedSubscriptions, selectedIds, t]);

  const hasCalendars = orderedSubscriptions.length > 0;

  if (accounts.length === 0) {
    return null;
  }

  return (
    <>
      <SurfaceList
        label="Workspace calendar subscriptions"
        data-testid="workspace-calendar-subscriptions-list"
      >
        {accounts.map((account) => {
          const calendars = accountCalendars.get(account.id) ?? [];
          if (calendars.length === 0) return null;
          const title = account.displayName ?? account.email ?? account.id;
          const caption =
            account.displayName && account.email ? account.email : null;
          return (
            <SettingsSection
              key={account.id}
              component="section"
              title={title}
              description={caption}
              actions={
                <SettingsStatusText>
                  {calendars.length}{" "}
                  {t["com.myoxus.integration.calendar.name"]()}
                </SettingsStatusText>
              }
            >
              <SurfaceList label={title}>
                {calendars.map((subscription) => (
                  <SubscriptionSetting
                    key={subscription.id}
                    subscription={subscription}
                    checked={selectedIds.has(subscription.id)}
                    onToggle={handleToggle}
                  />
                ))}
              </SurfaceList>
            </SettingsSection>
          );
        })}
        {!hasCalendars ? (
          <SettingsControlEmpty data-testid="workspace-calendar-subscriptions-empty">
            {t["com.myoxus.integration.calendar.no-calendar"]()}
          </SettingsControlEmpty>
        ) : null}
      </SurfaceList>
      {hasCalendars ? (
        <DialogFooterActions data-testid="workspace-calendar-subscriptions-actions">
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!hasChanges || saving}
            loading={saving}
            data-testid="workspace-calendar-subscriptions-save"
          >
            {t["com.myoxus.editCollection.save"]()}
          </Button>
        </DialogFooterActions>
      ) : null}
    </>
  );
};
