import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { AccessTokenService, ServerService } from "@myoxus/core/modules/server";
import type { McpApiKey } from "@myoxus/core/modules/server/stores/access-token";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { McpIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  ErrorMessage,
  Group,
  MonoText,
  notify,
  SettingsControlEmpty,
  SettingsListItemMeta,
  SettingsSection,
  SettingsSwitchRow,
  Skeleton,
  Stack,
  TerminalPanel,
} from "../../../primitives";
import { IntegrationSettingHeader } from "../setting";

const MCP_BASE_SCOPES = [
  "read:workspaces",
  "read:docs",
  "read:calendar",
] as const;
const MCP_DOCUMENT_WRITE_SCOPE = "write:docs";
const MCP_CALENDAR_WRITE_SCOPE = "write:calendar";
const MCP_WORKSPACE_WRITE_SCOPE = "write:workspaces";

const mcpApiKeyName = (workspaceId: string) => `mcp:${workspaceId}`;

export const McpServerSettingPanel = () => {
  return <McpServerSetting />;
};

const McpServerSettingHeader = ({ action }: { action?: ReactNode }) => {
  const t = useI18n();

  return (
    <IntegrationSettingHeader
      icon={<McpIcon aria-hidden="true" />}
      name={t["com.myoxus.integration.mcp-server.name"]()}
      desc={t["com.myoxus.integration.mcp-server.desc"]()}
      action={action}
    />
  );
};

const McpServerSetting = () => {
  const workspaceService = useService(WorkspaceService);
  const serverService = useService(ServerService);
  const workspaceName = useLiveData(workspaceService.workspace.name$);
  const accessTokenService = useService(AccessTokenService);
  const mcpApiKeys = useLiveData(accessTokenService.mcpApiKeys$);
  const isRevalidating = useLiveData(accessTokenService.isRevalidating$);
  const error = useLiveData(accessTokenService.error$);
  const [mutating, setMutating] = useState(false);
  const [documentWriteEnabled, setDocumentWriteEnabled] = useState(true);
  const [calendarWriteEnabled, setCalendarWriteEnabled] = useState(true);
  const [workspaceWriteEnabled, setWorkspaceWriteEnabled] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState<McpApiKey | null>(null);
  const t = useI18n();
  const apiKeyName = mcpApiKeyName(workspaceService.workspace.id);
  const supportTools = useMemo(
    () =>
      [
        {
          name: "read_doc",
          description: t["com.myoxus.integration.mcp-server.tools.doc-read"](),
        },
        {
          name: "search_docs",
          description:
            t["com.myoxus.integration.mcp-server.tools.doc-keyword-search"](),
        },
        {
          name: "create_page / update_doc / delete_page / doc_version_create",
          description: t["com.myoxus.integration.mcp-server.tools.doc-write"](),
        },
        {
          name: "doc_patch",
          description: t["com.myoxus.integration.mcp-server.tools.doc-patch"](),
        },
        {
          name: "doc_metadata_update / doc_metadata_transition",
          description:
            t["com.myoxus.integration.mcp-server.tools.doc-metadata-write"](),
        },
        {
          name: "folder_create / folder_update / folder_delete",
          description:
            t["com.myoxus.integration.mcp-server.tools.folder-write"](),
        },
        {
          name: "folder_entry_list / folder_entry_create / folder_entry_update / folder_entry_delete",
          description:
            t["com.myoxus.integration.mcp-server.tools.folder-entry-write"](),
        },
        {
          name: "blob_list / blob_get_metadata / blob_read",
          description: t["com.myoxus.integration.mcp-server.tools.blob-read"](),
        },
        {
          name: "blob_upload / blob_delete",
          description:
            t["com.myoxus.integration.mcp-server.tools.blob-write"](),
        },
        {
          name: "calendar_events_list",
          description: t["com.myoxus.integration.calendar.name"](),
        },
        {
          name: "calendar_conflicts_check",
          description:
            t["com.myoxus.integration.calendar.event-dialog.overlaps-with"](),
        },
        {
          name: "calendar_event_create",
          description: t["com.myoxus.integration.calendar.add-event"](),
        },
        {
          name: "calendar_event_update",
          description: t["com.myoxus.integration.calendar.event-edit"](),
        },
        {
          name: "calendar_event_delete",
          description: t["com.myoxus.integration.calendar.event-delete"](),
        },
      ] as const,
    [t],
  );

  const mcpApiKey = useMemo(() => {
    return mcpApiKeys?.find((key) => key.name === apiKeyName);
  }, [apiKeyName, mcpApiKeys]);

  const displayedApiKey = revealedApiKey ?? mcpApiKey;
  const displayedScopes: string[] = displayedApiKey?.scopes ?? [
    ...MCP_BASE_SCOPES,
    ...(documentWriteEnabled ? [MCP_DOCUMENT_WRITE_SCOPE] : []),
    ...(calendarWriteEnabled ? [MCP_CALENDAR_WRITE_SCOPE] : []),
    ...(workspaceWriteEnabled ? [MCP_WORKSPACE_WRITE_SCOPE] : []),
  ];
  const hasMcpToken = Boolean(revealedApiKey || mcpApiKey);
  const hasCopyableToken = Boolean(revealedApiKey?.key);
  const isRedactedDisplay = hasMcpToken && !hasCopyableToken;

  const code = useMemo(() => {
    return displayedApiKey
      ? JSON.stringify(
          {
            mcpServers: {
              [`myoxus_workspace_${workspaceService.workspace.id}`]: {
                type: "streamable-http",
                url: `${serverService.server.baseUrl}/mcp`,
                note: t["com.myoxus.integration.mcp-server.config.note"]({
                  name: workspaceName ?? workspaceService.workspace.id,
                }),
                headers: {
                  Authorization: `Bearer ${displayedApiKey.key ?? "[REDACTED]"}`,
                },
              },
            },
          },
          null,
          2,
        )
      : null;
  }, [displayedApiKey, workspaceName, workspaceService, serverService, t]);

  const copyJsonDisabled = !code || mutating || isRedactedDisplay;
  const copyJsonTooltip = isRedactedDisplay
    ? t["com.myoxus.integration.mcp-server.copy-json.disabled-hint"]()
    : undefined;

  const showLoading = mcpApiKeys === null && isRevalidating;
  const showError = mcpApiKeys === null && error !== null;

  useEffect(() => {
    accessTokenService.revalidate();
  }, [accessTokenService]);

  const handleGenerateAccessToken = useAsyncCallback(async () => {
    setMutating(true);
    try {
      if (mcpApiKey) {
        await accessTokenService.revokeMcpApiKey(mcpApiKey.id);
      }
      const scopes = [
        ...MCP_BASE_SCOPES,
        ...(documentWriteEnabled ? [MCP_DOCUMENT_WRITE_SCOPE] : []),
        ...(calendarWriteEnabled ? [MCP_CALENDAR_WRITE_SCOPE] : []),
        ...(workspaceWriteEnabled ? [MCP_WORKSPACE_WRITE_SCOPE] : []),
      ];
      const createdKey = await accessTokenService.createMcpApiKey(
        apiKeyName,
        scopes,
      );
      setRevealedApiKey(createdKey);
    } catch (err) {
      notify.error({
        error: UserFriendlyError.fromAny(err),
      });
    } finally {
      setMutating(false);
    }
  }, [
    accessTokenService,
    apiKeyName,
    calendarWriteEnabled,
    documentWriteEnabled,
    mcpApiKey,
    workspaceWriteEnabled,
  ]);

  const handleRevokeAccessToken = useAsyncCallback(async () => {
    setMutating(true);
    try {
      if (mcpApiKey) {
        await accessTokenService.revokeMcpApiKey(mcpApiKey.id);
      }
      setRevealedApiKey(null);
    } catch (err) {
      notify.error({
        error: UserFriendlyError.fromAny(err),
      });
    } finally {
      setMutating(false);
    }
  }, [accessTokenService, mcpApiKey]);

  if (showLoading) {
    return (
      <Stack>
        <McpServerSettingHeader />
        <Skeleton />
      </Stack>
    );
  }

  if (showError) {
    return (
      <Stack>
        <McpServerSettingHeader />
        <ErrorMessage>{error}</ErrorMessage>
      </Stack>
    );
  }

  return (
    <Stack>
      <McpServerSettingHeader />

      <SettingsSection
        title={t["com.myoxus.integration.mcp-server.token.title"]()}
        description={t["com.myoxus.integration.mcp-server.token.description"]()}
        actions={
          !hasMcpToken ? (
            <Button
              variant="primary"
              onClick={handleGenerateAccessToken}
              disabled={mutating}
            >
              {t["com.myoxus.integration.mcp-server.token.create"]()}
            </Button>
          ) : (
            <Button
              variant="error"
              onClick={handleRevokeAccessToken}
              disabled={mutating}
            >
              {t["Delete"]()}
            </Button>
          )
        }
      >
        <SettingsSwitchRow
          label={t[
            "com.myoxus.integration.mcp-server.scope.workspace-write.title"
          ]()}
          description={t[
            "com.myoxus.integration.mcp-server.scope.workspace-write.desc"
          ]()}
          checked={workspaceWriteEnabled}
          disabled={hasMcpToken || mutating}
          onChange={setWorkspaceWriteEnabled}
        />
        <SettingsSwitchRow
          label={t["com.myoxus.integration.mcp-server.scope.write.title"]()}
          description={t[
            "com.myoxus.integration.mcp-server.scope.write.desc"
          ]()}
          checked={documentWriteEnabled}
          disabled={hasMcpToken || mutating}
          onChange={setDocumentWriteEnabled}
        />
        <SettingsSwitchRow
          label={`${t["com.myoxus.integration.calendar.name"]()}: ${t[
            "com.myoxus.integration.mcp-server.scope.write.title"
          ]()}`}
          description={<MonoText>{MCP_CALENDAR_WRITE_SCOPE}</MonoText>}
          checked={calendarWriteEnabled}
          disabled={hasMcpToken || mutating}
          onChange={setCalendarWriteEnabled}
        />
        <Group wrap="wrap" data-myoxus-ui-role="mcp-scope-list">
          {displayedScopes.map((scope) => (
            <Badge key={scope} data-myoxus-ui-role="mcp-scope-badge">
              <MonoText>{scope}</MonoText>
            </Badge>
          ))}
        </Group>
      </SettingsSection>

      <SettingsSection
        title={t["com.myoxus.integration.mcp-server.config.title"]()}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              if (!code) return;

              navigator.clipboard.writeText(code);
              notify.success({
                title: t["Copied to clipboard"](),
              });
            }}
            disabled={copyJsonDisabled}
            tooltip={copyJsonTooltip}
          >
            {t["com.myoxus.integration.mcp-server.config.copy-json"]()}
          </Button>
        }
      >
        {code ? (
          <TerminalPanel tabIndex={0}>{code}</TerminalPanel>
        ) : (
          <SettingsControlEmpty>
            {t["com.myoxus.integration.mcp-server.config.empty"]()}
          </SettingsControlEmpty>
        )}
      </SettingsSection>

      <SettingsSection
        title={t["com.myoxus.integration.mcp-server.tools.title"]()}
      >
        <Accordion multiple data-myoxus-ui-role="mcp-tool-list">
          {supportTools.map((tool) => (
            <AccordionItem key={tool.name} value={tool.name}>
              <AccordionControl>
                <MonoText>{tool.name}</MonoText>
              </AccordionControl>
              <AccordionPanel>
                <SettingsListItemMeta>{tool.description}</SettingsListItemMeta>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      </SettingsSection>
    </Stack>
  );
};
