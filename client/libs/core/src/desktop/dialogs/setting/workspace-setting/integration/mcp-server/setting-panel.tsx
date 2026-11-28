// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { AccessTokenService, ServerService } from "@myoxus/core/modules/server";
import type { McpApiKey } from "@myoxus/core/modules/server/stores/access-token";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { CopyIcon, DoneIcon, McpIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useMemo, useState } from "react";

import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  CopyButton,
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
const SCOPE_WRITE_DOCS = "write:docs";
const SCOPE_WRITE_CALENDAR = "write:calendar";
const SCOPE_WRITE_WORKSPACES = "write:workspaces";

// Keys belong to ApiKey.user_id; `mcp:<workspaceId>` is a human-readable label
// only and never restricts authorization to a single workspace.
const formatMcpKeyLabel = (workspaceId: string) => `mcp:${workspaceId}`;

function McpHeader() {
  const t = useI18n();
  return (
    <IntegrationSettingHeader
      icon={<McpIcon aria-hidden="true" />}
      name={t["com.myoxus.integration.mcp-server.name"]()}
      desc={t["com.myoxus.integration.mcp-server.desc"]()}
    />
  );
}

export const McpServerSettingPanel = () => {
  const t = useI18n();
  const workspaceService = useService(WorkspaceService);
  const serverService = useService(ServerService);
  const accessTokenService = useService(AccessTokenService);

  const workspaceId = workspaceService.workspace.id;
  const workspaceName = useLiveData(workspaceService.workspace.name$);
  const mcpApiKeys = useLiveData(accessTokenService.mcpApiKeys$);
  const isRevalidating = useLiveData(accessTokenService.isRevalidating$);
  const error = useLiveData(accessTokenService.error$);

  const [mutating, setMutating] = useState(false);
  const [documentWrite, setDocumentWrite] = useState(true);
  const [calendarWrite, setCalendarWrite] = useState(true);
  const [workspaceWrite, setWorkspaceWrite] = useState(false);
  const [revealedKey, setRevealedKey] = useState<McpApiKey | null>(null);

  const keyLabel = formatMcpKeyLabel(workspaceId);
  const existingKey = useMemo(
    () => mcpApiKeys?.find((entry) => entry.name === keyLabel),
    [keyLabel, mcpApiKeys],
  );
  const displayedKey = revealedKey ?? existingKey;
  const hasToken = Boolean(displayedKey);
  const isRedacted = hasToken && !revealedKey?.key;

  const activeScopes = displayedKey?.scopes ?? [
    ...MCP_BASE_SCOPES,
    ...(documentWrite ? [SCOPE_WRITE_DOCS] : []),
    ...(calendarWrite ? [SCOPE_WRITE_CALENDAR] : []),
    ...(workspaceWrite ? [SCOPE_WRITE_WORKSPACES] : []),
  ];

  const supportedTools = useMemo(
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

  const configJson = useMemo(() => {
    if (!displayedKey) return null;
    return JSON.stringify(
      {
        mcpServers: {
          [`myoxus_workspace_${workspaceId}`]: {
            type: "streamable-http",
            url: `${serverService.server.baseUrl}/mcp`,
            note: t["com.myoxus.integration.mcp-server.config.note"]({
              name: workspaceName ?? workspaceId,
            }),
            headers: {
              Authorization: `Bearer ${displayedKey.key ?? "[REDACTED]"}`,
            },
          },
        },
      },
      null,
      2,
    );
  }, [
    displayedKey,
    serverService.server.baseUrl,
    t,
    workspaceId,
    workspaceName,
  ]);

  useEffect(() => {
    accessTokenService.revalidate();
  }, [accessTokenService]);

  const handleGenerate = useAsyncCallback(async () => {
    setMutating(true);
    try {
      if (existingKey) {
        await accessTokenService.revokeMcpApiKey(existingKey.id);
      }
      const created = await accessTokenService.createMcpApiKey(keyLabel, [
        ...MCP_BASE_SCOPES,
        ...(documentWrite ? [SCOPE_WRITE_DOCS] : []),
        ...(calendarWrite ? [SCOPE_WRITE_CALENDAR] : []),
        ...(workspaceWrite ? [SCOPE_WRITE_WORKSPACES] : []),
      ]);
      setRevealedKey(created);
    } catch (err) {
      notify.error({ error: UserFriendlyError.fromAny(err) });
    } finally {
      setMutating(false);
    }
  }, [
    accessTokenService,
    calendarWrite,
    documentWrite,
    existingKey,
    keyLabel,
    workspaceWrite,
  ]);

  const handleRevoke = useAsyncCallback(async () => {
    setMutating(true);
    try {
      if (existingKey) {
        await accessTokenService.revokeMcpApiKey(existingKey.id);
      }
      setRevealedKey(null);
    } catch (err) {
      notify.error({ error: UserFriendlyError.fromAny(err) });
    } finally {
      setMutating(false);
    }
  }, [accessTokenService, existingKey]);

  if (mcpApiKeys === null && isRevalidating) {
    return (
      <Stack>
        <McpHeader />
        <Skeleton />
      </Stack>
    );
  }

  if (mcpApiKeys === null && error !== null) {
    return (
      <Stack>
        <McpHeader />
        <ErrorMessage>{error}</ErrorMessage>
      </Stack>
    );
  }

  return (
    <Stack>
      <McpHeader />

      <SettingsSection
        title={t["com.myoxus.integration.mcp-server.token.title"]()}
        description={t["com.myoxus.integration.mcp-server.token.description"]()}
        actions={
          hasToken ? (
            <Button variant="error" onClick={handleRevoke} disabled={mutating}>
              {t["Delete"]()}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={handleGenerate}
              disabled={mutating}
            >
              {t["com.myoxus.integration.mcp-server.token.create"]()}
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
          checked={workspaceWrite}
          disabled={hasToken || mutating}
          onChange={setWorkspaceWrite}
        />
        <SettingsSwitchRow
          label={t["com.myoxus.integration.mcp-server.scope.write.title"]()}
          description={t[
            "com.myoxus.integration.mcp-server.scope.write.desc"
          ]()}
          checked={documentWrite}
          disabled={hasToken || mutating}
          onChange={setDocumentWrite}
        />
        <SettingsSwitchRow
          label={`${t["com.myoxus.integration.calendar.name"]()}: ${t[
            "com.myoxus.integration.mcp-server.scope.write.title"
          ]()}`}
          description={<MonoText>{SCOPE_WRITE_CALENDAR}</MonoText>}
          checked={calendarWrite}
          disabled={hasToken || mutating}
          onChange={setCalendarWrite}
        />
        <Group wrap="wrap" data-myoxus-ui-role="mcp-scope-list">
          {activeScopes.map((scope) => (
            <Badge key={scope} data-myoxus-ui-role="mcp-scope-badge">
              <MonoText>{scope}</MonoText>
            </Badge>
          ))}
        </Group>
      </SettingsSection>

      <SettingsSection
        title={t["com.myoxus.integration.mcp-server.config.title"]()}
        actions={
          <CopyButton value={configJson ?? ""} timeout={2000}>
            {({ copied, copy }) => (
              <Button
                variant="primary"
                prefix={
                  copied ? (
                    <DoneIcon aria-hidden="true" />
                  ) : (
                    <CopyIcon aria-hidden="true" />
                  )
                }
                onClick={() => {
                  if (!configJson) return;
                  copy();
                  notify.success({ title: t["Copied to clipboard"]() });
                }}
                disabled={!configJson || mutating || isRedacted}
                tooltip={
                  isRedacted
                    ? t[
                        "com.myoxus.integration.mcp-server.copy-json.disabled-hint"
                      ]()
                    : undefined
                }
              >
                {copied
                  ? t["Copied to clipboard"]()
                  : t["com.myoxus.integration.mcp-server.config.copy-json"]()}
              </Button>
            )}
          </CopyButton>
        }
      >
        {configJson ? (
          <TerminalPanel tabIndex={0}>{configJson}</TerminalPanel>
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
          {supportedTools.map((tool) => (
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
