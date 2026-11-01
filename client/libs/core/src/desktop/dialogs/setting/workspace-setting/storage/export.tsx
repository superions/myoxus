import { exportWorkspaceLabels } from "@myoxus/core/modules/tag/export";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import type { Workspace } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { ExportIcon } from "@myoxus/icons/react";
import { useServiceOptional } from "@myoxus/infra";
import { universalId } from "@myoxus/storage";
import track from "@myoxus/track";
import { useState } from "react";

import { Button, notify, SettingsRow } from "../../primitives";

interface ExportPanelProps {
  workspace: Workspace;
}

export async function requestObsidianVault(
  workspaceId: string,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  const response = await fetcher(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/export/obsidian-vault`,
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(`Vault export failed (${response.status})`);
  }
  return response.blob();
}

export const DesktopExportPanel = ({ workspace }: ExportPanelProps) => {
  const t = useI18n();
  const [saving, setSaving] = useState(false);
  const [vaultExporting, setVaultExporting] = useState(false);
  const desktopApi = useServiceOptional(DesktopApiService);
  const isLocalWorkspace = workspace.flavour === "local";

  const [fullSyncing, setFullSyncing] = useState(false);
  const [fullSynced, setFullSynced] = useState(isLocalWorkspace);

  const fullSync = useAsyncCallback(async () => {
    setFullSyncing(true);
    await workspace.engine.blob.fullDownload();
    await workspace.engine.doc.waitForSynced();
    setFullSynced(true);
    setFullSyncing(false);
  }, [workspace.engine.blob, workspace.engine.doc]);

  const onExport = useAsyncCallback(async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      track.$.settingsPanel.workspace.export({
        type: "workspace",
      });

      const result = await desktopApi?.handler?.dialog.saveDBFileAs(
        universalId({
          peer: workspace.flavour,
          type: "workspace",
          id: workspace.id,
        }),
        workspace.name$.getValue() ?? "db",
        await exportWorkspaceLabels(
          workspace,
          Array.from(workspace.docCollection.docs.keys()),
        ),
      );
      if (result?.error) {
        throw new Error(result.error);
      } else if (!result) {
        throw new Error("Desktop export is unavailable");
      } else if (!result.canceled) {
        notify.success({ title: t["Export success"]() });
      }
    } catch {
      notify.error({
        title: t["Export failed"](),
        message: t["com.myoxus.export.error.message"](),
      });
    } finally {
      setSaving(false);
    }
  }, [desktopApi, saving, t, workspace]);

  const onVaultExport = useAsyncCallback(async () => {
    if (vaultExporting) return;
    setVaultExporting(true);
    try {
      const url = URL.createObjectURL(await requestObsidianVault(workspace.id));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${workspace.name$.getValue() ?? "workspace"}.obsidian.zip`;
      link.click();
      URL.revokeObjectURL(url);
      notify.success({ title: t["Export success"]() });
    } catch {
      notify.error({
        title: t["Export failed"](),
        message: t["com.myoxus.export.error.message"](),
      });
    } finally {
      setVaultExporting(false);
    }
  }, [t, vaultExporting, workspace]);

  const vaultExport = isLocalWorkspace ? null : (
    <SettingsRow
      name={t["com.myoxus.workspace-export.obsidian.title"]()}
      desc={t["com.myoxus.workspace-export.obsidian.description"]()}
    >
      <Button
        data-testid="export-obsidian-vault"
        onClick={onVaultExport}
        loading={vaultExporting}
        disabled={vaultExporting}
        prefix={<ExportIcon />}
      >
        {t["Export"]()}
      </Button>
    </SettingsRow>
  );

  if (!BUILD_CONFIG.isElectron) {
    return vaultExport;
  }

  if (fullSynced) {
    return (
      <>
        <SettingsRow
          name={t["Full Backup"]()}
          desc={t["Full Backup Description"]()}
        >
          <Button
            variant="primary"
            data-testid="export-myoxus-backup"
            onClick={onExport}
            disabled={saving}
          >
            {t["Full Backup"]()}
          </Button>
        </SettingsRow>
        {vaultExport}
      </>
    );
  }

  return (
    <>
      <SettingsRow
        name={t["Full Backup"]()}
        desc={
          fullSynced ? t["Full Backup Description"]() : t["Full Backup Hint"]()
        }
      >
        <Button
          variant="primary"
          data-testid="export-myoxus-full-sync"
          onClick={fullSync}
          loading={fullSyncing}
          disabled={fullSyncing}
          prefix={<ExportIcon />}
        >
          {t["Full Backup"]()}
        </Button>
      </SettingsRow>
      <SettingsRow
        name={t["Quick Export"]()}
        desc={t["Quick Export Description"]()}
      >
        <Button
          data-testid="export-myoxus-backup"
          onClick={onExport}
          disabled={saving}
        >
          {t["Quick Export"]()}
        </Button>
      </SettingsRow>
      {vaultExport}
    </>
  );
};
