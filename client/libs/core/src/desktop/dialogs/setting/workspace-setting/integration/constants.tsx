// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { IntegrationTypeIcon } from "@myoxus/core/modules/integration";
import type { I18nString } from "@myoxus/i18n";
import { GithubIcon, McpIcon } from "@myoxus/icons/react";
import type { ReactNode } from "react";

import { GitSyncSettingPanel } from "./git-sync/setting-panel";
import { McpServerSettingPanel } from "./mcp-server/setting-panel";
import { ReadwiseSettingPanel } from "./readwise/setting-panel";

type IntegrationEntry = {
  id: string;
  name: I18nString;
  desc: I18nString;
  icon: ReactNode;
  cloud?: boolean;
} & ({ setting: ReactNode } | { link: string });

const INTEGRATIONS = [
  {
    id: "readwise" as const,
    name: "com.myoxus.integration.readwise.name",
    desc: "com.myoxus.integration.readwise.desc",
    icon: <IntegrationTypeIcon type="readwise" />,
    setting: <ReadwiseSettingPanel />,
  },
  {
    id: "git-sync" as const,
    name: "com.myoxus.integration.git-sync.name",
    desc: "com.myoxus.integration.git-sync.desc",
    icon: <GithubIcon />,
    setting: <GitSyncSettingPanel />,
  },
  {
    id: "mcp-server" as const,
    name: "com.myoxus.integration.mcp-server.name",
    desc: "com.myoxus.integration.mcp-server.desc",
    icon: <McpIcon aria-hidden="true" />,
    setting: <McpServerSettingPanel />,
    cloud: true,
  },
] satisfies IntegrationEntry[];

type IntegrationId = (typeof INTEGRATIONS)[number]["id"];

export type IntegrationItem = Omit<IntegrationEntry, "id"> & {
  id: IntegrationId;
};

export function getAllowedIntegrationList(
  isCloudWorkspace: boolean,
): IntegrationItem[] {
  return INTEGRATIONS.filter(
    (entry) => !entry.cloud || isCloudWorkspace,
  ) as IntegrationItem[];
}
