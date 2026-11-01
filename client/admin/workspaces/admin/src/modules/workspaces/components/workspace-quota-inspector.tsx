/**
 * WorkspaceQuotaInspector — P112-QUOTA-UI-B-02
 *
 * Fetches the full quota resolution hierarchy for a workspace via
 * `adminWorkspaceQuotaDetails` and renders:
 *   1. A table showing Workspace Override, Config Default, and Effective.
 *   2. A usage progress bar (hidden when quota is unlimited).
 *   3. An info banner when the workspace has unlimited storage.
 */
import {
  adminWorkspaceQuotaDetailsQuery,
  WorkspaceQuotaSource,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Progress,
  SettingsEmptyState,
  SettingsListItemTitle,
  SettingsStatusText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";

import { useQuery } from "../../../use-query";
import { formatBytes } from "../utils";

interface WorkspaceQuotaInspectorProps {
  workspaceId: string;
}

/**
 * Maps a `WorkspaceQuotaSource` enum value to the i18n key suffix used in the
 * `admin.workspaces.quota-inspector.level.*` namespace.
 */
function sourceToLevelKey(source: WorkspaceQuotaSource): string {
  switch (source) {
    case WorkspaceQuotaSource.WorkspaceOverride:
      return "workspace-override";
    case WorkspaceQuotaSource.ConfigDefault:
      return "config-default";
    case WorkspaceQuotaSource.Unlimited:
      // Unlimited is rendered as "Config Default" with a special banner;
      // the table still shows config-default as the active row.
      return "config-default";
  }
}

function bytesOrNull(n: number | null | undefined): string | null {
  if (n == null || n === 0) return null;
  return formatBytes(n);
}

export function WorkspaceQuotaInspector({
  workspaceId,
}: WorkspaceQuotaInspectorProps) {
  const i18n = useI18n();

  const { data, isLoading } = useQuery(
    {
      query: adminWorkspaceQuotaDetailsQuery,
      variables: { workspaceId },
    },
    { revalidateIfStale: true },
  );

  const details = data?.admin?.adminWorkspaceQuotaDetails;

  if (isLoading || !details) {
    return <div>{isLoading ? "…" : null}</div>;
  }

  const isUnlimited = details.source === WorkspaceQuotaSource.Unlimited;
  const activeLevel = sourceToLevelKey(details.source as WorkspaceQuotaSource);

  // Rows: each has a display label, the value in bytes (or null for "not set"),
  // and whether it is the currently active level.
  const rows: Array<{
    key: string;
    levelKey: string;
    valueBytes: number | null;
    isActive: boolean;
  }> = [
    {
      key: "workspace",
      levelKey: "workspace-override",
      valueBytes: details.workspaceOverrideBytes ?? null,
      isActive: activeLevel === "workspace-override",
    },
    {
      key: "config",
      levelKey: "config-default",
      // config is in MB — convert to bytes for display consistency
      valueBytes:
        details.configDefaultMb > 0
          ? details.configDefaultMb * 1024 * 1024
          : null,
      isActive: activeLevel === "config-default",
    },
    {
      key: "effective",
      levelKey: "effective",
      valueBytes: details.effectiveBytes > 0 ? details.effectiveBytes : null,
      isActive: false, // Effective is a derived row, never "active source"
    },
  ];

  const usedBytes = details.usedBytes;
  const totalBytes = details.effectiveBytes;
  const percent =
    !isUnlimited && totalBytes > 0
      ? Math.min(100, (usedBytes / totalBytes) * 100)
      : 0;
  return (
    <>
      <SettingsListItemTitle>
        {i18n.t("admin.workspaces.quota-inspector.title")}
      </SettingsListItemTitle>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              {i18n.t("admin.workspaces.quota-inspector.col.level")}
            </TableHead>
            <TableHead>
              {i18n.t("admin.workspaces.quota-inspector.col.value")}
            </TableHead>
            <TableHead>
              {i18n.t("admin.workspaces.quota-inspector.col.active")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell>
                {i18n.t(
                  `admin.workspaces.quota-inspector.level.${row.levelKey}`,
                )}
              </TableCell>
              <TableCell>
                {row.valueBytes != null
                  ? (bytesOrNull(row.valueBytes) ??
                    i18n.t("admin.workspaces.quota-inspector.unlimited"))
                  : isUnlimited && row.levelKey === "config-default"
                    ? i18n.t("admin.workspaces.quota-inspector.unlimited")
                    : "—"}
              </TableCell>
              <TableCell>
                {row.isActive ? (
                  <Badge tone="success">{i18n.t("admin.common.active")}</Badge>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Unlimited banner */}
      {isUnlimited && (
        <SettingsEmptyState
          title={i18n.t("admin.workspaces.quota-inspector.unlimited")}
        />
      )}

      {/* Usage progress bar (hidden when unlimited) */}
      {!isUnlimited && totalBytes > 0 && (
        <>
          <SettingsStatusText>
            {i18n.t("admin.workspaces.quota-inspector.usage", {
              used: formatBytes(usedBytes),
              total: formatBytes(totalBytes),
            })}
          </SettingsStatusText>
          <Progress
            value={percent}
            showValueLabel={false}
            ariaLabel={i18n.t("admin.workspaces.quota-inspector.usage", {
              used: formatBytes(usedBytes),
              total: formatBytes(totalBytes),
            })}
          />
        </>
      )}
    </>
  );
}
