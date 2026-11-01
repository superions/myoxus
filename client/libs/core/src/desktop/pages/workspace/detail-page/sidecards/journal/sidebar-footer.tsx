/** Journal sidecard footer actions. */
import { IntegrationService } from "@myoxus/core/modules/integration";
import { useI18n } from "@myoxus/i18n";
import {
  ExportToHtmlIcon,
  ImportIcon,
  MoreHorizontalIcon,
  ResetIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  FileMenuItem,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  notify,
  SidebarFooterBar,
  SidebarFooterCaption,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";

const STALE_THRESHOLD_MS = 60 * 60 * 1000;

function formatLastSync(
  t: ReturnType<typeof useI18n>,
  lastRevalidatedAt: number | null,
  refreshing: boolean,
  now: number,
): { label: string; stale: boolean } {
  if (refreshing) {
    return {
      label: t["com.myoxus.integration.calendar.sync.refreshing"](),
      stale: false,
    };
  }
  if (lastRevalidatedAt === null) {
    return {
      label: t["com.myoxus.integration.calendar.sync.never"](),
      stale: true,
    };
  }
  const ageMs = Math.max(0, now - lastRevalidatedAt);
  const minutes = Math.floor(ageMs / 60_000);
  const stale = ageMs > STALE_THRESHOLD_MS;
  if (minutes < 1) {
    return {
      label: t["com.myoxus.integration.calendar.sync.just-now"](),
      stale: false,
    };
  }
  if (minutes < 60) {
    return {
      label: t["com.myoxus.integration.calendar.sync.minutes-ago"]({
        count: String(minutes),
      }),
      stale,
    };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return {
      label: t["com.myoxus.integration.calendar.sync.hours-ago"]({
        count: String(hours),
      }),
      stale,
    };
  }
  return {
    label: t["com.myoxus.integration.calendar.sync.long-ago"](),
    stale: true,
  };
}

export const JournalSidebarFooter = () => {
  const t = useI18n();
  const calendar = useService(IntegrationService).calendar;
  const lastRevalidatedAt = useLiveData(calendar.lastRevalidatedAt$);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const start = dayjs().startOf("month");
      const end = dayjs().endOf("month");
      await calendar.revalidateEventsRange(start, end);
    } catch (err) {
      notify.error({
        title: t["com.myoxus.integration.calendar.sync.refresh-failed"](),
        message: String(err),
      });
    } finally {
      setRefreshing(false);
    }
  }, [calendar, refreshing, t]);

  const handleExport = useCallback(async () => {
    try {
      const from = dayjs().subtract(90, "day");
      const to = dayjs().add(365, "day");
      const icsBody = await calendar.exportIcs(from, to);
      if (!icsBody) {
        notify.warning({
          title: t["com.myoxus.integration.calendar.ics.export-empty"](),
        });
        return;
      }
      const blob = new Blob([icsBody], { type: "text/calendar" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workspace-calendar-${dayjs().format("YYYY-MM-DD")}.ics`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify.error({
        title: t["com.myoxus.integration.calendar.ics.export-failed"](),
        message: String(err),
      });
    }
  }, [calendar, t]);

  const handleImportFile = useCallback(
    async (file: File) => {
      if (!file) return;
      try {
        const icsBody = await file.text();
        const result = await calendar.importIcs(icsBody);
        notify.success({
          title: t["com.myoxus.integration.calendar.ics.import-success"](),
          message: t["com.myoxus.integration.calendar.ics.import-count"]({
            count: String(result?.importedCount ?? 0),
          }),
        });
      } catch (err) {
        notify.error({
          title: t["com.myoxus.integration.calendar.ics.import-failed"](),
          message: String(err),
        });
      }
    },
    [calendar, t],
  );

  const sync = formatLastSync(t, lastRevalidatedAt, refreshing, now);

  return (
    <SidebarFooterBar
      data-myoxus-ui-role="sidebar-journal-footer"
      data-testid="sidebar-journal-footer"
    >
      <SidebarFooterCaption
        tone={sync.stale ? "warning" : "muted"}
        data-testid="ics-toolbar-last-sync"
        aria-live="polite"
      >
        {sync.label}
      </SidebarFooterCaption>
      <Menu
        items={
          <>
            <MenuItem
              prefixIcon={<ResetIcon />}
              onClick={handleRefresh}
              disabled={refreshing}
              data-testid="ics-toolbar-refresh"
            >
              {t["com.myoxus.integration.calendar.sync.refresh"]()}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              prefixIcon={<ExportToHtmlIcon />}
              onClick={handleExport}
              data-testid="ics-toolbar-export"
            >
              {t["com.myoxus.integration.calendar.ics.export"]()}
            </MenuItem>
            <FileMenuItem
              prefixIcon={<ImportIcon />}
              accept=".ics,text/calendar"
              onFile={handleImportFile}
              inputUiRole="journal-footer-file-input"
              data-testid="ics-toolbar-import"
            >
              {t["com.myoxus.integration.calendar.ics.import"]()}
            </FileMenuItem>
          </>
        }
      >
        <IconButton
          type="button"
          aria-label={t["com.myoxus.integration.calendar.ics.menu"]()}
          data-myoxus-ui-role="button:icon-only:journal-footer"
          data-testid="ics-toolbar-trigger"
        >
          <MoreHorizontalIcon />
        </IconButton>
      </Menu>
    </SidebarFooterBar>
  );
};
